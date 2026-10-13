"""Laptop bridge: pull approved recipes over HTTPS and execute one CubOS well each."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import time
import uuid

import httpx

from ursa_learning.config import LearningSettings
from ursa_learning.models.runs import RunSubmission
from ursa_learning.models.state import RunStateSelection
from ursa_learning.services.live_mixture import MixtureSetup, compile_mixture, check_inventory
from ursa_learning.services.run_manager import RemoteRunManager, RunConflictError
from ursa_learning.services.station import StationUnavailableError
from ursa_learning.services.yaml_io import atomic_write_text


class ReviewRequired(RuntimeError):
    pass


def load_setup(path: Path) -> dict:
    return MixtureSetup.model_validate_json(path.read_text()).model_dump()


class Journal:
    def __init__(self, path: Path):
        self.path = path
        self.data = json.loads(path.read_text()) if path.exists() else {
            "version": 2, "worker_id": uuid.uuid4().hex, "event_id": None, "jobs": {}, "setup_hash": None,
        }
        if self.data.get("version") != 2:
            raise ReviewRequired("Use a new journal for the mixture demo after inspecting physical state")
        self.save()

    def save(self):
        atomic_write_text(self.path, json.dumps(self.data, indent=2, allow_nan=False))

    def bind(self, event_id: str, config: dict | None):
        digest = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
        if self.data["event_id"] not in (None, event_id) or self.data["setup_hash"] not in (None, digest):
            raise ReviewRequired("Event/setup changed. Inspect physical state and allocate fresh wells before using a new journal.")
        self.data.update(event_id=event_id, setup_hash=digest)
        self.save()


@contextmanager
def worker_lock(path: Path):
    import fcntl
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(".lock").open("a+") as stream:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ReviewRequired("Another worker is using this journal") from exc
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


class LiveWorker:
    def __init__(self, cloud: httpx.Client, runs: RemoteRunManager | None,
                 journal: Journal, config: dict | None, *, simulate=False):
        self.cloud, self.runs, self.journal, self.config = cloud, runs, journal, config
        self.mode = "simulation" if simulate else "hardware"

    def cloud_post(self, action, body=None):
        response = self.cloud.post(f"/api/live/worker/{action}", json={
            "workerId": self.journal.data["worker_id"], "mode": self.mode, **(body or {}),
        })
        response.raise_for_status()
        return response.json()

    def prepare(self, job):
        jobs = self.journal.data["jobs"]
        if job["id"] in jobs:
            return jobs[job["id"]]
        index = len(jobs)
        wells = self.config["candidate_wells"] if self.config else [f"demo.{n+1}" for n in range(300)]
        well = wells[index] if index < len(wells) else None
        entry = {"phase": "allocated", "well": well, "run_id": f"live-{job['id']}",
                 "progress": {"status": "running", "well": well, "runId": None}}
        jobs[job["id"]] = entry
        self.journal.save()
        return entry

    def start_run(self, job, entry):
        if entry["well"] is None:
            raise ReviewRequired("No unused well remains. Inspect and reconcile fresh labware before a new session.")
        if self.runs is None or self.config is None:
            raise ReviewRequired("CubOS setup is missing")
        if entry["phase"] in {"starting", "active"}:
            record = self.runs.get(entry["run_id"])
            if record is None:
                raise ReviewRequired("The previous run start is unconfirmed. Inspect its stable run ID; do not resubmit.")
            return record
        self.runs.ensure_station_ready()
        gantry = self.runs.read_config("gantry", self.config["gantry_file"])
        deck = self.runs.read_config("deck", self.config["deck_file"])
        source = self.runs.read_config("protocol", self.config["source_protocol_file"])
        selection = RunStateSelection(fluid_state_id=self.config["fluid_state_id"])
        self.runs._resolve_run_state(deck, selection)
        tips = self.runs.get_tip_snapshot(selection.fluid_state_id)
        pipette = tips["pipette"]
        if pipette["attachment_uncertain"] or pipette["tip_extension_mm"] is not None:
            raise ReviewRequired("CubOS must record a bare pipette before this job")
        available = [f"{item['rack_key']}.{item['slot_id']}" for item in tips["containers"] if item["status"] == "available"]
        protocol, required_stock = compile_mixture(source, job["recipe"], entry["well"], available)
        check_inventory(self.runs.get_fluid_snapshot(selection.fluid_state_id), entry["well"], required_stock)
        self.runs._validate_bundle(gantry, deck, protocol, tips)
        submission = RunSubmission(run_id=entry["run_id"], gantry_config=gantry, deck_config=deck,
            protocol_yaml=protocol, state=selection, mock_mode=False,
            metadata={"live_job_id": job["id"], "live_recipe": job["recipe"], "live_well": entry["well"]})
        # Save the stable ID and exact bundle before the single hardware-start POST.
        entry["submission"] = submission.model_dump(mode="json")
        entry["phase"] = "starting"
        self.journal.save()
        try:
            record = self.runs.submit(submission)
        except StationUnavailableError:
            # A lost response can be resolved by reading this ID, never by a second POST.
            record = self.runs.get(entry["run_id"])
            if record is None:
                raise ReviewRequired("Run start outcome is unknown; inspect CubOS before continuing")
        entry["phase"] = "active"
        self.journal.save()
        return record

    def tick(self):
        heartbeat = self.cloud_post("heartbeat")
        self.journal.bind(heartbeat["eventId"], self.config)
        for job_id, pending in self.journal.data["jobs"].items():
            if pending.get("pending_report"):
                self.cloud_post("progress", {"jobId": job_id, **pending["progress"]})
                pending["pending_report"] = False
                self.journal.save()
                return
        claimed = self.cloud_post("claim")
        job = claimed["job"]
        if job is None:
            return
        entry = self.prepare(job)
        if entry["phase"] == "done":
            self.cloud_post("progress", {"jobId": job["id"], **entry["progress"]})
            return
        try:
            if self.mode == "simulation":
                report = {"status": "completed" if entry["phase"] == "active" else "running",
                          "well": entry["well"], "runId": None}
                entry["phase"] = "active"
            else:
                record = self.start_run(job, entry)
                if record.run_id != entry["run_id"] or record.mock_mode:
                    raise ReviewRequired("CubOS returned an unexpected run identity or simulation result")
                status = "completed" if record.state == "succeeded" else "blocked" if record.state in {"failed", "cancelled", "cancel_requested"} else "running"
                report = {"status": status, "well": entry["well"], "runId": record.run_id,
                          "message": "Inspect the CubOS run before continuing." if status == "blocked" else None}
        except (StationUnavailableError, RunConflictError, ValueError, KeyError, ReviewRequired) as exc:
            report = {"status": "blocked", "well": entry["well"],
                      "runId": entry["run_id"] if entry["phase"] in {"starting", "active"} else None,
                      "message": f"{type(exc).__name__}: inspect the local worker and CubOS run before continuing."}
            print(f"Job {job['number']} needs review ({type(exc).__name__}).", flush=True)
        entry["progress"] = report
        entry["pending_report"] = True
        if report["status"] != "running":
            entry["phase"] = "done"
        self.journal.save()
        self.cloud_post("progress", {"jobId": job["id"], **report})
        entry["pending_report"] = False
        self.journal.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Public queue URL")
    parser.add_argument("--cub-url", default="http://cub.local:8742")
    parser.add_argument("--setup", type=Path, help="Reviewed mixture setup JSON")
    parser.add_argument("--journal", type=Path, default=Path(".live-worker/mixtures.json"))
    parser.add_argument("--simulate", action="store_true", help="Rehearsal only; never contacts hardware")
    args = parser.parse_args()
    url = httpx.URL(args.url)
    if url.scheme != "https" and url.host not in {"localhost", "127.0.0.1"}:
        parser.error("The public queue URL must use HTTPS")
    token = os.environ.get("LIVE_WORKER_TOKEN", "")
    if len(token) < 32:
        parser.error("Set LIVE_WORKER_TOKEN to the server's worker secret (at least 32 characters)")
    if not args.simulate and args.setup is None:
        parser.error("Hardware mode requires --setup with reviewed physical setup")
    config = None if args.simulate else load_setup(args.setup)
    with worker_lock(args.journal), httpx.Client(base_url=args.url.rstrip("/"), timeout=15,
            headers={"Authorization": f"Bearer {token}"}) as cloud:
        runs = None if args.simulate else RemoteRunManager(LearningSettings(
            cubos_url=args.cub_url, run_dir=args.journal.parent / "runs", config_dir=args.journal.parent / "configs"))
        worker = LiveWorker(cloud, runs, Journal(args.journal), config, simulate=args.simulate)
        print(f"Laptop worker ready ({worker.mode}). Waiting for the operator's Run command.", flush=True)
        try:
            while True:
                try:
                    worker.tick()
                except httpx.HTTPError as exc:
                    print(f"Queue unavailable ({type(exc).__name__}); retrying in 3 seconds.", flush=True)
                time.sleep(3)
        finally:
            if runs:
                runs.station.client.close()


if __name__ == "__main__":
    main()
