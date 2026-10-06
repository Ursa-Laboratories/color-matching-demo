"""Campaign-compatible run adapter. CubOS exclusively executes protocols."""
from __future__ import annotations
from contextlib import contextmanager
import hashlib
import json
import os
import threading
import uuid
from pathlib import Path
from ursa_learning.config import LearningSettings, get_settings
from ursa_learning.models.runs import RunEvent, RunRecord, RunSubmission
from ursa_learning.services.run_store import RunStore, _atomic_write
from ursa_learning.services.station import StationClient, StationHTTPError
from ursa_learning.services.yaml_io import safe_filename


class RunConflictError(RuntimeError):
    pass


class RunPolicyError(ValueError):
    pass


class RemoteRunManager:
    def __init__(self, settings: LearningSettings, *, station: StationClient | None = None):
        self.settings = settings
        self.station = station or StationClient(settings)
        self.store = RunStore(settings.ensure_run_dir() / "evidence", self.station)
        self._lock = threading.RLock()
        self._reservation_file = settings.ensure_run_dir() / ".station-reservation.json"
        self._reservations: dict[str, str] = {}
        self._state_decks: dict[int, str] = {}
        if self._reservation_file.is_file():
            self._reservations = json.loads(self._reservation_file.read_text())

    def _request(self, method, path, **kwargs):
        try:
            return self.station.request_json(method, path, **kwargs)
        except StationHTTPError as exc:
            if exc.status_code == 409:
                raise RunConflictError(str(exc)) from exc
            raise

    @property
    def active_run_id(self) -> str | None:
        return self.station_state().get("active_run_id")

    def station_state(self) -> dict:
        return self.station.status()

    def ensure_station_ready(self) -> dict:
        status = self.station_state()
        if not status.get("connected"):
            raise RunConflictError("Connect the CubOS station before starting")
        if status.get("calibration_active"):
            raise RunConflictError("Finish station calibration before starting")
        if status.get("active_run_id"):
            raise RunConflictError(f"CubOS is busy with run {status['active_run_id']}")
        return status

    def _save_reservations(self):
        self._reservation_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._reservation_file.with_suffix(".tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(self._reservations, stream)
        temporary.replace(self._reservation_file)
        self._reservation_file.chmod(0o600)

    def reserve_campaign(self, owner: str) -> None:
        with self._lock:
            remote = self._request("GET", "/api/v1/station/reservation")
            if remote.get("reserved"):
                if remote.get("owner") == owner and owner in self._reservations:
                    return
                raise RunConflictError(f"Station is reserved by {remote.get('owner')!r}; inspect the owner before recovery")
            result = self._request("POST", "/api/v1/station/reservation", json={"owner": owner})
            token = result.get("reservation_token")
            if not isinstance(token, str) or not token:
                raise RuntimeError("CubOS reservation response omitted its token")
            self._reservations = {owner: token}
            self._save_reservations()

    def release_campaign(self, owner: str) -> None:
        with self._lock:
            token = self._reservations.get(owner)
            if token is None:
                return
            self._request("DELETE", "/api/v1/station/reservation", headers={"X-CubOS-Reservation": token})
            self._reservations.pop(owner, None)
            self._save_reservations()

    @contextmanager
    def inventory_edit(self):
        owner = "learning-inventory-" + uuid.uuid4().hex
        self.reserve_campaign(owner)
        try:
            if self.active_run_id:
                raise RunConflictError("Wait for the station run to finish before editing inventory")
            yield
        finally:
            self.release_campaign(owner)

    def submit(self, submission: RunSubmission, *, campaign_owner: str | None = None) -> RunRecord:
        payload = submission.model_dump(mode="json", exclude_none=True)
        if campaign_owner:
            self.reserve_campaign(campaign_owner)
            payload["reservation_token"] = self._reservations[campaign_owner]
        # Exactly one HTTP attempt. Transport failure has an unknown execution
        # outcome; the durable caller's run ID is the recovery handle.
        return RunRecord.model_validate(self._request("POST", "/api/v1/runs", json=payload))

    def get(self, run_id: str) -> RunRecord | None:
        self.store.run_dir(run_id)
        try:
            data = self._request("GET", f"/api/v1/runs/{run_id}")
        except StationHTTPError as exc:
            if exc.status_code == 404:
                return None
            raise
        record = RunRecord.model_validate(data)
        record.metadata.update(self.store.annotations(run_id))
        return record

    def cancel(self, run_id: str) -> RunRecord:
        self.store.run_dir(run_id)
        try:
            return RunRecord.model_validate(self._request("POST", f"/api/v1/runs/{run_id}/cancel"))
        except StationHTTPError as exc:
            if exc.status_code == 404:
                raise KeyError(run_id) from exc
            raise

    def events(self, run_id: str) -> list[RunEvent]:
        self.store.run_dir(run_id)
        data = self._request("GET", f"/api/v1/runs/{run_id}/events")
        return [RunEvent.model_validate(event) for event in data["events"]]

    def read_config(self, category: str, filename: str) -> str:
        safe_filename(filename)
        if category not in {"gantry", "deck", "protocol"}:
            raise ValueError("Unsupported configuration category")
        # Only generated application namespaces are local. A station filename
        # is fetched afresh for each use, even when a similarly named file exists.
        if filename.startswith(("learning-", "overnight-", "color-generated-")):
            local = self.settings.configs_dir / category / filename
            if local.is_file() and not local.is_symlink():
                return local.read_text(encoding="utf-8")
        return self.station.read_config(category, filename)

    def _validate_bundle(self, gantry, deck, protocol, tip_snapshot=None):
        payload = {"gantry_config": gantry, "deck_config": deck, "protocol_yaml": protocol, "mock_mode": True}
        if tip_snapshot is not None:
            payload["tip_snapshot"] = tip_snapshot
        result = self._request("POST", "/api/v1/runs/validate", json=payload)
        if not result.get("valid"):
            raise ValueError("; ".join(result.get("errors", [])) or result.get("output") or "CubOS rejected the protocol bundle")
        return result

    def _resolve_run_state(self, deck_yaml, selection):
        payload = {"deck_yaml": deck_yaml, **selection.model_dump(mode="json", exclude_none=True)}
        result = self._request("POST", "/api/v1/station/state/validate", json=payload)
        state_id = selection.fluid_state_id
        if state_id is not None:
            self._state_decks[state_id] = deck_yaml
        return result

    def get_tip_snapshot(self, state_id):
        return self.station.get_tip_snapshot(state_id)

    def get_fluid_snapshot(self, state_id):
        deck_yaml = self._state_decks.get(state_id)
        if deck_yaml is not None:
            # Only setup YAML is retained. Each call fetches fresh physical
            # inventory and authoritative dead-volume floors from CubOS.
            result = self._request("POST", "/api/v1/station/state/validate", json={"deck_yaml": deck_yaml, "fluid_state_id": state_id})
            return result["fluids"]
        return self.station.get_fluid_snapshot(state_id)

    def get_trial_measurements(self, run_id):
        record = self.get(run_id)
        return record.result if record else None

    def evidence_path(self, run_id: str, source_path: str) -> Path | None:
        record = self.get(run_id)
        if record is None:
            return None
        for item in record.metadata.get("evidence_artifacts", []):
            if isinstance(item, dict) and item.get("source_path") == source_path:
                return self._evidence_artifact(record, item)
        return None

    def _evidence_artifact(self, record, item):
        name, expected = item.get("artifact"), item.get("sha256")
        if not isinstance(name, str) or not isinstance(expected, str):
            raise ValueError("CubOS evidence mapping is incomplete")
        path = self.store.artifact_path(record.run_id, name)
        if path is None:
            return None
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("Downloaded evidence digest does not match CubOS")
        return path

    def download_image(self, run_id, artifact_name):
        record = self.get(run_id)
        if record is None:
            raise KeyError(run_id)
        for item in record.metadata.get("evidence_artifacts", []):
            if isinstance(item, dict) and item.get("artifact") == artifact_name:
                return self._evidence_artifact(record, item)
        raise ValueError("Image is not listed as immutable CubOS evidence")

    def freeze_target(self, run_id: str) -> RunRecord:
        record = self.get(run_id)
        if record is None:
            raise KeyError(run_id)
        if record.state != "succeeded" or not record.metadata.get("active_learning_target"):
            return record
        with self.store.color_target_analysis_transaction():
            if record.metadata.get("color_target_source_artifact"):
                return record
            items = record.metadata.get("evidence_artifacts", [])
            sources = [item for item in items if isinstance(item, dict) and item.get("field") == "image_path"]
            if not sources:
                return record
            item = sources[-1]
            path = self._evidence_artifact(record, item)
            if path is None:
                raise ValueError("Immutable target evidence is unavailable")
            result = record.result
            if isinstance(result, dict) and isinstance(result.get("results"), list):
                result = result["results"]
            if isinstance(result, list):
                measurements = [value for value in result if isinstance(value, dict) and value.get("image_path") == item.get("source_path")]
                measurement = measurements[-1] if measurements else {}
            else:
                measurement = result if isinstance(result, dict) else {}
            metadata = {"color_target_source_artifact": item["artifact"], "color_target_source_sha256": item["sha256"], "color_target_reanalyses": []}
            self.store.annotate(run_id, metadata)
            record.metadata.update(metadata)
            complete = {"schema": "ursa-learning.color-target-reanalysis.v1", "revision": 0, "source_image_sha256": item["sha256"], "expected_well": record.metadata["active_learning_target"], "analysis": measurement}
            _atomic_write(self.store.run_dir(run_id) / "color-target-analysis-0.json", json.dumps(complete, indent=2))
            previews = [candidate for candidate in items if isinstance(candidate, dict) and candidate.get("field") == "annotated_preview_path"]
            if previews:
                preview = self._evidence_artifact(record, previews[-1])
                if preview:
                    (self.store.run_dir(run_id) / "color-target-analysis-0.png").write_bytes(preview.read_bytes())
            return record

    def archive_run(self, run_id: str) -> Path:
        record = self.get(run_id)
        if record is None:
            raise KeyError(run_id)
        directory = self.store.run_dir(run_id)
        directory.mkdir(parents=True, exist_ok=True)
        # Export snapshots are explicitly historical evidence, not recovery
        # state. Remote get/status never falls back to these copies.
        _atomic_write(directory / "run.json", record.model_dump_json(indent=2))
        events = self.events(run_id)
        _atomic_write(directory / "events.jsonl", "\n".join(event.model_dump_json() for event in events))
        for name in ("gantry.yaml", "deck.yaml", "protocol.yaml", "result.json", "error.txt"):
            self.store.artifact_path(run_id, name)
        return directory


RunManager = RemoteRunManager
_manager = None
_manager_lock = threading.Lock()


def get_run_manager() -> RemoteRunManager:
    global _manager
    with _manager_lock:
        settings = get_settings()
        if _manager is None or _manager.settings is not settings:
            _manager = RemoteRunManager(settings)
        return _manager
