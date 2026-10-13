import json
from pathlib import Path

import httpx
import pytest
import yaml

from ursa_learning.config import LearningSettings
from ursa_learning.live_worker import Journal, LiveWorker, ReviewRequired, load_setup, worker_lock
from ursa_learning.services.live_mixture import compile_mixture, validated_volumes
from ursa_learning.services.run_manager import RemoteRunManager
from ursa_learning.services.station import StationClient

ROOT = Path(__file__).parents[1]
SOURCE = (ROOT / 'examples/live-mixture-protocol.yaml').read_text()
RECIPE = {"parts": {"red": 6, "yellow": 3, "blue": 1}, "volumes": {"red": 90, "yellow": 45, "blue": 15}, "totalVolumeUl": 150}


def harness(tmp_path, *, simulate=False, lost_start=False, missing_run=False, lost_report=False, used_well=False, tip_count=3):
    config = load_setup(ROOT / "examples/live-talk-worker.json")
    posted, reports, calls = [], [], []
    job = {"id": "job-1234567890123456", "number": 1, "recipe": RECIPE}
    current = {"run_id": f"live-{job['id']}", "state": "running", "created_at": 1.0, "mock_mode": False}
    failures = {"report": lost_report}
    tips = {"pipette": {"attachment_uncertain": False, "tip_extension_mm": None}, "containers": [
        {"rack_key": "tips", "slot_id": f"A{i+1}", "status": "available"} for i in range(tip_count)]}
    fluids = {"containers": [
        {"labware_key": "stocks", "location_id": f"A{i+1}", "current_volume_ul": 5000, "dead_volume_ul": 100} for i in range(3)
    ] + [{"labware_key": "plate", "location_id": "A1", "current_volume_ul": 10 if used_well else 0}]}

    def station(request):
        calls.append((request.method, request.url.path))
        route = request.url.path
        if route == "/api/v1/station/status":
            return httpx.Response(200, json={"connected": True, "active_run_id": None})
        if route.endswith("/raw"):
            return httpx.Response(200, json={"content": SOURCE if "/protocol/" in route else "config: {}"})
        if route.endswith("/tips"):
            return httpx.Response(200, json=tips)
        if route.endswith("/state/validate"):
            return httpx.Response(200, json={"fluids": fluids})
        if route.endswith("/runs/validate"):
            return httpx.Response(200, json={"valid": True})
        if route == "/api/v1/runs" and request.method == "POST":
            posted.append(json.loads(request.content))
            if lost_start:
                raise httpx.ReadTimeout("lost start response")
        elif route.startswith("/api/v1/runs/") and missing_run:
            return httpx.Response(404, json={"detail": "not found"})
        return httpx.Response(200, json=current)

    def cloud(request):
        action = request.url.path.rsplit("/", 1)[-1]
        if action == "progress":
            reports.append(json.loads(request.content))
            if failures["report"]:
                failures["report"] = False
                raise httpx.ReadTimeout("lost report response")
        return httpx.Response(200, json={"eventId": "talk", "job": job if action == "claim" else None})

    settings = LearningSettings(run_dir=tmp_path / "runs", config_dir=tmp_path / "configs")
    runs = RemoteRunManager(settings, station=StationClient(settings, client=httpx.Client(
        base_url="http://cub.local:8742", transport=httpx.MockTransport(station))))
    worker = LiveWorker(httpx.Client(base_url="https://demo.test", transport=httpx.MockTransport(cloud)),
                        None if simulate else runs, Journal(tmp_path / "journal.json"),
                        None if simulate else config, simulate=simulate)
    return worker, posted, reports, current, calls


def test_one_job_compiles_exact_recipe_into_one_well_without_camera(tmp_path):
    worker, posted, reports, current, _ = harness(tmp_path)
    worker.tick()
    assert len(posted) == 1
    submission = posted[0]
    steps = yaml.safe_load(submission["protocol_yaml"])["protocol"]
    assert [step["transfer"]["volume_ul"] for step in steps if "transfer" in step] == [90, 45, 15]
    assert {step["transfer"]["destination"] for step in steps if "transfer" in step} == {"plate.A1"}
    assert len([step for step in steps if "pick_up_tip" in step]) == 3
    assert len([step for step in steps if "mix" in step]) == 1
    assert not any("measure_color" in step or "move" in step for step in steps)
    assert submission["state"] == {"fluid_state_id": 1}
    assert submission["mock_mode"] is False
    worker.tick()
    assert len(posted) == 1
    current["state"] = "succeeded"
    worker.tick()
    assert reports[-1]["status"] == "completed"
    assert reports[-1]["well"] == "plate.A1"


def test_lost_start_response_resolves_stable_id_without_second_post(tmp_path):
    worker, posted, reports, _, _ = harness(tmp_path, lost_start=True)
    worker.tick()
    worker.tick()
    assert len(posted) == 1
    assert reports[-1]["status"] == "running"


def test_unknown_start_blocks_and_is_never_resubmitted(tmp_path):
    worker, posted, reports, _, _ = harness(tmp_path, lost_start=True, missing_run=True)
    worker.tick()
    assert reports[-1]["status"] == "blocked"
    worker.tick()
    assert len(posted) == 1


def test_restart_during_start_reads_the_saved_id_only(tmp_path):
    worker, posted, reports, _, _ = harness(tmp_path)
    entry = worker.prepare({"id": "job-1234567890123456"})
    entry["phase"] = "starting"
    worker.journal.save()
    worker.journal = Journal(tmp_path / "journal.json")
    worker.tick()
    assert posted == []
    assert reports[-1]["status"] == "running"


def test_lost_cloud_report_is_retried_before_more_hardware_work(tmp_path):
    worker, posted, reports, _, calls = harness(tmp_path, lost_report=True)
    with pytest.raises(httpx.ReadTimeout):
        worker.tick()
    count = len(calls)
    worker.tick()
    assert len(calls) == count
    assert len(posted) == 1
    assert reports[0] == reports[1]


@pytest.mark.parametrize("options", [{"used_well": True}, {"tip_count": 2}])
def test_used_well_or_missing_tips_block_before_submission(tmp_path, options):
    worker, posted, reports, _, _ = harness(tmp_path, **options)
    worker.tick()
    assert posted == []
    assert reports[-1]["status"] == "blocked"


def test_simulation_never_uses_cubos(tmp_path):
    worker, posted, reports, _, calls = harness(tmp_path, simulate=True)
    worker.tick()
    assert reports[-1]["status"] == "running"
    worker.tick()
    assert reports[-1]["status"] == "completed"
    assert calls == [] and posted == []


def test_failed_run_never_advances_as_completed(tmp_path):
    worker, _, reports, current, _ = harness(tmp_path)
    current["state"] = "failed"
    worker.tick()
    assert reports[-1]["status"] == "blocked"


def test_journal_binding_and_lock_prevent_reuse(tmp_path):
    path = tmp_path / "journal.json"
    journal = Journal(path)
    journal.bind("one", {})
    with pytest.raises(ReviewRequired):
        journal.bind("two", {})
    with pytest.raises(ReviewRequired):
        journal.bind("one", {"changed": True})
    with worker_lock(path), pytest.raises(ReviewRequired):
        with worker_lock(path):
            pass


def test_zero_components_are_skipped_and_final_active_tip_mixes():
    recipe = {"parts": {"red": 10, "yellow": 0, "blue": 0}, "volumes": {"red": 150, "yellow": 0, "blue": 0}, "totalVolumeUl": 150}
    protocol, stocks = compile_mixture(SOURCE, recipe, "plate.B1", ["tips.C1"])
    steps = yaml.safe_load(protocol)["protocol"]
    assert [next(iter(step)) for step in steps] == ["pick_up_tip", "transfer", "mix", "drop_tip"]
    assert steps[1]["transfer"]["source_height"] == -8
    assert steps[2]["mix"]["position"] == "plate.B1"
    assert stocks == {"stocks.A1": 150}


def test_untrusted_volumes_and_templates_with_camera_steps_are_rejected():
    with pytest.raises(ValueError):
        validated_volumes({**RECIPE, "volumes": {"red": 100, "yellow": 45, "blue": 15}})
    with pytest.raises(ValueError):
        compile_mixture(SOURCE + "  - measure_color: {position: plate.A1}\n", RECIPE, "plate.A1", ["tips.A1", "tips.A2", "tips.A3"])


def test_setup_rejects_duplicate_wells(tmp_path):
    path = tmp_path / "setup.json"
    config = json.loads((ROOT / "examples/live-talk-worker.json").read_text())
    config["candidate_wells"] = ["plate.A1", "plate.A1"]
    path.write_text(json.dumps(config))
    with pytest.raises(ValueError):
        load_setup(path)
