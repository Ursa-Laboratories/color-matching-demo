"""Offline regressions at the separate app/CubOS HTTP boundary."""
from __future__ import annotations

import hashlib
import io
import json
import time
import zipfile
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ursa_learning.config import LearningSettings
from ursa_learning.models.campaigns import CampaignRecord, CampaignTrial
from ursa_learning.models.runs import RunRecord
from ursa_learning.optimization import analyze_color_image
from ursa_learning.routers import campaigns as routes
from ursa_learning.services.campaign_manager import CampaignManager
from ursa_learning.services.campaign_presentation import CampaignPresentationService
from ursa_learning.services.run_manager import RemoteRunManager
from ursa_learning.services.station import StationClient, StationUnavailableError
from tests.test_campaign_manager import FakeRuns, _setup, wait_for
from tests.test_color import _acquisition, _write_well_image
from tests.test_color_campaign import SOURCE_PROTOCOL, build_color_campaign, setup


@pytest.fixture
def remote_target(tmp_path, monkeypatch):
    source = _write_well_image(tmp_path)
    center = (220 / 399, 160 / 299)
    analysis = analyze_color_image(source, expected_center=center,
                                   expected_center_source="operator_selected",
                                   acquisition_context=_acquisition(height=None))
    payload = source.read_bytes()
    preview = Path(analysis["annotated_preview_path"]).read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    # These paths only identify immutable remote artifacts. They do not exist
    # on the app host and must never be opened by application services.
    analysis.update(image_path="/srv/cubos/images/well.png",
                    annotated_preview_path="/srv/cubos/images/well.analysis.png")
    analysis["frame_metadata"] = {"image_sha256": digest}
    analysis["well_identity"] = {"expected_well": "plate.A1", "source": "protocol_position",
                                 "verification_status": "not_verified_by_cv"}
    record = RunRecord(run_id="target-run", state="succeeded", created_at=time.time(),
                       mock_mode=False, metadata={"active_learning_target": "plate.A1"},
                       result={"results": [analysis]})
    artifacts = {"measurement-0-image_path.png": payload,
                 "measurement-0-annotated_preview_path.png": preview,
                 "gantry.yaml": b"instruments: {}\n", "deck.yaml": b"labware: {}\n",
                 "protocol.yaml": SOURCE_PROTOCOL.encode(),
                 "result.json": json.dumps(record.result).encode()}
    record.metadata["evidence_artifacts"] = [
        {"result_path": "results.0", "field": field, "artifact": name,
         "sha256": hashlib.sha256(artifacts[name]).hexdigest(), "source_path": analysis[field]}
        for field, name in (("image_path", "measurement-0-image_path.png"),
                            ("annotated_preview_path", "measurement-0-annotated_preview_path.png"))
    ]
    requests = []

    def handle(request):
        requests.append((request.method, request.url.path))
        path = request.url.path
        if path == "/api/v1/runs/target-run":
            return httpx.Response(200, json=record.model_dump(mode="json"))
        if path == "/api/v1/runs/target-run/events":
            return httpx.Response(200, json={"events": []})
        if "/artifacts/" in path:
            content = artifacts.get(path.rsplit("/", 1)[-1])
            return httpx.Response(200, content=content) if content is not None else httpx.Response(404, json={"detail": "missing"})
        if path.endswith("/raw"):
            category = path.split("/")[-3]
            return httpx.Response(200, json={"content": SOURCE_PROTOCOL if category == "protocol" else "instruments: {}\n"})
        if path == "/api/v1/station/state/validate":
            return httpx.Response(200, json={"valid": True})
        if path == "/api/v1/fluid-states/1/tips":
            return httpx.Response(200, json={"pipette": {"attachment_uncertain": False, "tip_extension_mm": None},
                "containers": [{"rack_key": "tips", "slot_id": f"A{i}", "status": "available"} for i in range(1, 19)]})
        raise AssertionError(f"Unexpected station request {request.method} {path}")

    settings = LearningSettings(config_dir=tmp_path / "configs", run_dir=tmp_path / "app-runs")
    station = StationClient(settings, client=httpx.Client(base_url="http://cubos", transport=httpx.MockTransport(handle)))
    manager = RemoteRunManager(settings, station=station)
    monkeypatch.setattr(routes, "get_settings", lambda: settings)
    monkeypatch.setattr(routes, "get_run_manager", lambda: manager)
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app), manager, record, artifacts, requests, center, settings


def test_http_target_freezing_reanalysis_revision_is_accepted_for_real_color_setup(remote_target):
    client, manager, record, artifacts, requests, center, settings = remote_target
    fetched = client.get("/api/v1/campaigns/color-target/target-run")
    assert fetched.status_code == 200
    assert fetched.json()["metadata"]["color_target_source_sha256"] == hashlib.sha256(artifacts["measurement-0-image_path.png"]).hexdigest()
    response = client.post("/api/v1/campaigns/color-target/target-run/reanalyze", json={
        "expected_center": list(center), "expected_center_source": "operator_selected"})
    assert response.status_code == 200, response.text
    revised = response.json()
    assert revised["measurement_status"] == "accepted"
    assert revised["analysis_revision"] == 1
    assert Path(revised["annotated_preview_path"]).is_relative_to(manager.store.base_dir)
    body = setup(mock_mode=False, fluid_state_id=1, target_run_id="target-run",
                 target_analysis_revision=1, expected_center=center,
                 target_lab=None, reference_processing_profile_id=None).model_dump(mode="json")
    prepared = client.post("/api/v1/campaigns/color-setup", json=body)
    assert prepared.status_code == 200, prepared.text
    spec = prepared.json()
    assert spec["target_lab"] == revised["lab"]
    assert spec["reference_processing_profile_id"] == revised["processing_profile"]["id"]
    assert (settings.configs_dir / "protocol" / spec["protocol_file"]).is_file()
    assert ("GET", "/api/v1/runs/target-run/artifacts/measurement-0-image_path.png") in requests
    assert not any(method == "POST" and path == "/api/v1/runs" for method, path in requests)


def test_target_review_rejects_modified_downloaded_source(remote_target):
    client, manager, *_ = remote_target
    frozen = manager.freeze_target("target-run")
    path = manager.store.artifact_path("target-run", frozen.metadata["color_target_source_artifact"])
    path.write_bytes(b"modified capture")
    response = client.post("/api/v1/campaigns/color-target/target-run/reanalyze", json={"expected_center": [0.5, 0.5]})
    assert response.status_code == 409
    assert "digest" in response.json()["detail"]


def test_presentation_export_downloads_native_snapshots_and_immutable_assets(remote_target):
    _, runs, remote, artifacts, requests, _, settings = remote_target
    spec = build_color_campaign(setup(target_mode="rgb", target_rgb=(120, 80, 40),
                                     target_lab=None, reference_processing_profile_id=None,
                                     expected_center_source="frame_center"),
                                settings.configs_dir / "protocol", source_protocol_yaml=SOURCE_PROTOCOL)
    campaigns = CampaignManager(settings, runs)
    measurement = dict(remote.result["results"][0], comparison_status="accepted", delta_e_00=2.0)
    trial = CampaignTrial(index=0, parameters={"red_ul": 100, "yellow_ul": 100, "blue_ul": 100},
                          run_id=remote.run_id, state="succeeded", objective=2.0,
                          objective_status="accepted", measurement=measurement, sample_well="plate.A2")
    record = CampaignRecord(campaign_id="export-campaign", spec=spec, state="completed",
                            created_at=time.time(), updated_at=time.time(), trials=[trial])
    campaigns._records[record.campaign_id] = record
    campaigns._save(record)
    payload = CampaignPresentationService(campaigns, runs).export_zip(record.campaign_id)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert archive.read("runs/target-run/protocol.yaml") == artifacts["protocol.yaml"]
        assert len(manifest["assets"]) == 2
        raw = next(item for item in manifest["assets"] if item["role"] == "raw")
        assert archive.read(raw["file"]) == artifacts["measurement-0-image_path.png"]
    assert ("GET", "/api/v1/runs/target-run/artifacts/protocol.yaml") in requests


def test_submit_timeout_persists_native_id_and_holds_station_without_replay(tmp_path):
    settings, spec = _setup(tmp_path, max_trials=2)

    class TimeoutRuns(FakeRuns):
        def submit(self, submission, **kwargs):
            self.submissions.append(submission)
            raise StationUnavailableError("POST response was lost")

    runs = TimeoutRuns()
    manager = CampaignManager(settings, runs, validator=lambda *_: None, poll_interval=0.001)
    cid = manager.start(spec).campaign_id
    result = wait_for(manager, cid, lambda record: record.state == "interrupted" and cid not in manager._workers)
    assert len(runs.submissions) == 1
    assert result.stop_reason == "station_outcome_unknown"
    assert result.active_run_id == runs.submissions[0].run_id == result.trials[0].run_id
    assert runs.owner == cid
    assert (manager.base / cid / "trial-1.yaml").read_text() == runs.submissions[0].protocol_yaml
    assert manager.get(cid).trials[0].objective is None
    recovered = CampaignManager(settings, runs, validator=lambda *_: None)
    assert recovered.get(cid).active_run_id == result.active_run_id
    assert len(runs.submissions) == 1


def test_release_failure_is_visible_and_worker_exits(tmp_path):
    settings, spec = _setup(tmp_path, max_trials=1)

    class FailedRelease(FakeRuns):
        def release_campaign(self, owner):
            raise StationUnavailableError("DELETE response lost")

    runs = FailedRelease([1.0])
    manager = CampaignManager(settings, runs, validator=lambda *_: None, poll_interval=0.001)
    cid = manager.start(spec).campaign_id
    result = wait_for(manager, cid, lambda record: record.stop_reason == "station_release_unconfirmed" and cid not in manager._workers)
    assert result.state == "interrupted"
    assert result.trials[0].objective == 1.0
    assert runs.owner == cid
    assert "reservation release was not confirmed" in result.error


def test_preset_routes_round_trip_parameters_and_clear_physical_state(remote_target, tmp_path):
    client, _, _, _, _, _, _ = remote_target
    _, spec = _setup(tmp_path / "preset-inputs", mock=False)
    body = {"name": "Threshold assay", "spec": spec.model_copy(update={"fluid_state_id": 42, "target_run_id": "target-run",
        "target_analysis_revision": 1, "target_lab": (42.0, 12.0, 18.0), "reference_processing_profile_id": "old-profile"}).model_dump(mode="json")}
    saved = client.put("/api/v1/campaigns/presets/threshold.yaml", json=body)
    assert saved.status_code == 200, saved.text
    restored = client.get("/api/v1/campaigns/presets/threshold.yaml")
    assert restored.status_code == 200
    assert restored.json()["preset"]["spec"]["parameters"] == body["spec"]["parameters"]
    restored_spec = restored.json()["preset"]["spec"]
    assert restored_spec["fluid_state_id"] is None
    assert restored_spec["target_run_id"] is None
    assert restored_spec["target_analysis_revision"] is None
    assert restored_spec["target_lab"] is None
    assert restored_spec["reference_processing_profile_id"] is None
    listing = client.get("/api/v1/campaigns/presets")
    assert listing.status_code == 200
    assert listing.json()[0]["name"] == "Threshold assay"
    rejected = client.put("/api/v1/campaigns/presets/bad%5Cname.yaml", json=body)
    assert rejected.status_code == 400
    assert client.get("/api/v1/campaigns/presets/missing.yaml").status_code == 404


def test_target_review_rejects_corrupt_station_artifact_bytes(remote_target):
    client, _, _, artifacts, *_ = remote_target
    artifacts["measurement-0-image_path.png"] = b"wrong download"
    response = client.get("/api/v1/campaigns/color-target/target-run")
    assert response.status_code == 409
    assert "digest" in response.json()["detail"]
