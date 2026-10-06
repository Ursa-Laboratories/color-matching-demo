"""Contract tests for station isolation, reservation recovery, and browser gateway."""
import hashlib
import json
from pathlib import Path
import httpx
import pytest
from pydantic import SecretStr
from fastapi.testclient import TestClient
from ursa_learning.config import LearningSettings
from ursa_learning.models.runs import RunSubmission
from ursa_learning.services.run_manager import RemoteRunManager, RunConflictError
from ursa_learning.services.station import StationClient, StationUnavailableError


def make_adapter(tmp_path, handler):
    settings = LearningSettings(run_dir=tmp_path / "runs", config_dir=tmp_path / "configs", cubos_api_token=SecretStr("station-secret"), api_token=SecretStr("app-secret"), trusted_hosts=["testserver"])
    client = httpx.Client(base_url=settings.cubos_url, transport=httpx.MockTransport(handler))
    return RemoteRunManager(settings, station=StationClient(settings, client=client))


def submission():
    return RunSubmission(run_id="trial-1", gantry_config="gantry: {}", deck_config="labware: {}", protocol_yaml="protocol: []", mock_mode=True)


def run_record(**kwargs):
    return {"run_id": "trial-1", "state": "succeeded", "created_at": 1.0, **kwargs}


def test_http_submission_reservation_and_release_survive_restart(tmp_path):
    calls = []
    reserved = {"owner": None, "reserved": False}
    def station(request):
        calls.append(request)
        assert request.headers["authorization"] == "Bearer station-secret"
        if request.url.path.endswith("/reservation"):
            if request.method == "GET":
                return httpx.Response(200, json=reserved)
            if request.method == "POST":
                reserved.update(owner=json.loads(request.content)["owner"], reserved=True)
                return httpx.Response(201, json={**reserved, "reservation_token": "opaque-token"})
            assert request.headers["x-cubos-reservation"] == "opaque-token"
            reserved.update(owner=None, reserved=False)
            return httpx.Response(200, json=reserved)
        assert json.loads(request.content)["reservation_token"] == "opaque-token"
        return httpx.Response(202, json=run_record())
    manager = make_adapter(tmp_path, station)
    record = manager.submit(submission(), campaign_owner="campaign-1")
    assert record.run_id == "trial-1"
    assert manager._reservation_file.stat().st_mode & 0o777 == 0o600
    recovered = RemoteRunManager(manager.settings, station=manager.station)
    recovered.reserve_campaign("campaign-1")
    recovered.release_campaign("campaign-1")
    assert len([call for call in calls if call.method == "POST" and call.url.path.endswith("/reservation")]) == 1
    assert len([call for call in calls if call.method == "DELETE"]) == 1


def test_outage_never_resubmits_or_uses_stale_station_state(tmp_path):
    calls = []
    def station(request):
        calls.append(request)
        raise httpx.ReadTimeout("unknown outcome", request=request)
    manager = make_adapter(tmp_path, station)
    with pytest.raises(StationUnavailableError):
        manager.submit(submission())
    assert len(calls) == 1
    manager.store.run_dir("trial-1").mkdir(parents=True)
    (manager.store.run_dir("trial-1") / "run.json").write_text(json.dumps(run_record()))
    with pytest.raises(StationUnavailableError):
        manager.get("trial-1")
    assert len(calls) == 2


def test_remote_configs_are_fresh_and_generated_configs_local(tmp_path):
    calls = []
    def station(request):
        calls.append(request)
        return httpx.Response(200, json={"content": f"revision: {len(calls)}"})
    manager = make_adapter(tmp_path, station)
    local = manager.settings.configs_dir / "deck" / "deck.yaml"
    local.write_text("stale")
    assert manager.read_config("deck", "deck.yaml") == "revision: 1"
    assert manager.read_config("deck", "deck.yaml") == "revision: 2"
    (local.parent / "overnight-123.yaml").write_text("frozen")
    assert manager.read_config("deck", "overnight-123.yaml") == "frozen"
    with pytest.raises(ValueError):
        manager.read_config("deck", "../secrets")
    assert len(calls) == 2


def test_evidence_download_hash_validation_and_local_reanalysis(tmp_path):
    raw = b"frozen-camera-image"
    preview = b"preview"
    digest = hashlib.sha256(raw).hexdigest()
    metadata = {"active_learning_target": "plate.A1", "evidence_artifacts": [{"source_path": "/station/image.dng", "field": "image_path", "artifact": "measurement-0-image_path.dng", "sha256": digest}, {"source_path": "/station/image.analysis.png", "field": "annotated_preview_path", "artifact": "measurement-0-annotated_preview_path.png", "sha256": hashlib.sha256(preview).hexdigest()}]}
    result = [{"image_path": "/station/image.dng", "annotated_preview_path": "/station/image.analysis.png", "lab": [1, 2, 3], "frame_metadata": {"image_sha256": digest}}]
    def station(request):
        if request.url.path.endswith(".dng"):
            return httpx.Response(200, content=raw)
        if request.url.path.endswith(".png"):
            return httpx.Response(200, content=preview)
        return httpx.Response(200, json=run_record(metadata=metadata, result=result))
    manager = make_adapter(tmp_path, station)
    record = manager.freeze_target("trial-1")
    assert record.metadata["color_target_source_sha256"] == digest
    assert manager.evidence_path("trial-1", "/station/image.dng").read_bytes() == raw
    assert manager.evidence_path("trial-1", "/arbitrary/local/file") is None
    staging = tmp_path / "analysis.png"
    staging.write_bytes(b"new-preview")
    updated, complete = manager.store.append_color_target_analysis(record, artifact={"source_image_sha256": digest, "analysis": {"lab": [4, 5, 6]}}, annotated_preview=staging)
    assert complete["revision"] == 1
    restored = manager.get("trial-1")
    assert restored.metadata["color_target_reanalyses"][0]["source_image_sha256"] == digest
    assert restored.metadata["color_target_reanalyses"][0]["analysis"]["lab"] == [4, 5, 6]
    assert manager.store.artifact_path("trial-1", "color-target-analysis-1.png").read_bytes() == b"new-preview"
    manager.evidence_path("trial-1", "/station/image.dng").write_bytes(b"tampered")
    with pytest.raises(ValueError, match="digest"):
        manager.evidence_path("trial-1", "/station/image.dng")


def test_proxy_blocks_cross_origin_host_and_unlisted_resources(tmp_path, monkeypatch):
    from ursa_learning import app as application
    requests = []
    def station(request):
        requests.append(request)
        return httpx.Response(200, json={"status": "ok"})
    manager = make_adapter(tmp_path, station)
    monkeypatch.setattr(application, "get_settings", lambda: manager.settings)
    monkeypatch.setattr(application, "get_run_manager", lambda: manager)
    client = TestClient(application.create_app())
    assert client.post("/api/v1/runs", json={}, headers={"Origin": "https://malicious.example"}).status_code == 403
    assert client.get("/api/v1/health", headers={"Host": "malicious.example"}).status_code == 400
    assert client.post("/api/v1/runs", json={}).status_code == 401
    assert client.post("/api/v1/system/update/apply", headers={"Authorization": "Bearer app-secret"}).status_code == 404
    assert client.get("/api/v1/settings/browse").status_code == 404
    response = client.post("/api/v1/runs", json={}, headers={"Origin": "http://testserver", "Authorization": "Bearer browser-token", "Cookie": "private=secret"})
    assert response.status_code == 200
    assert len(requests) == 1
    forwarded = requests[0]
    assert forwarded.headers["authorization"] == "Bearer station-secret"
    assert "origin" not in forwarded.headers and "cookie" not in forwarded.headers
    assert forwarded.headers["host"] == "127.0.0.1:8742"


def test_snapshot_reads_use_fresh_station_validation_with_retained_setup(tmp_path):
    from ursa_learning.models.state import RunStateSelection
    calls = []
    def station(request):
        calls.append(request)
        payload = json.loads(request.content)
        assert payload == {"deck_yaml": "labware: {}", "fluid_state_id": 42}
        return httpx.Response(200, json={"fluids": {"containers": [{"dead_volume_ul": 200, "current_volume_ul": 1000 - len(calls)}]}, "tips": {}, "dead_volumes": {"stock.A1": 200}})
    manager = make_adapter(tmp_path, station)
    manager._resolve_run_state("labware: {}", RunStateSelection(fluid_state_id=42))
    assert manager.get_fluid_snapshot(42)["containers"][0]["current_volume_ul"] == 998
    assert manager.get_fluid_snapshot(42)["containers"][0]["current_volume_ul"] == 997
    assert len(calls) == 3


def test_recovery_release_refuses_paused_owner_and_active_queue(tmp_path, monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace
    import threading
    from ursa_learning import app as application
    from ursa_learning.services import campaign_manager, overnight_queue
    calls = []
    def station(request):
        calls.append(request)
        if request.method == "DELETE":
            assert request.headers["x-cubos-reservation"] == "opaque-token"
        return httpx.Response(200, json={"active_run_id": None})
    manager = make_adapter(tmp_path, station)
    manager._reservations["campaign-1"] = "opaque-token"
    campaigns = SimpleNamespace(_lock=threading.RLock(), _records={"campaign-1": SimpleNamespace(state="paused")})
    queues = SimpleNamespace(_lock=threading.RLock(), _claim_lock=lambda: nullcontext(), _records={})
    monkeypatch.setattr(application, "get_settings", lambda: manager.settings)
    monkeypatch.setattr(application, "get_run_manager", lambda: manager)
    monkeypatch.setattr(campaign_manager, "get_campaign_manager", lambda: campaigns)
    monkeypatch.setattr(overnight_queue, "get_overnight_queue_manager", lambda: queues)
    client = TestClient(application.create_app())
    headers = {"Origin": "http://testserver"}
    endpoint = "/api/v1/learning/reservation/release"
    assert client.post(endpoint, json={"owner": "campaign-1"}, headers=headers).status_code == 409
    assert client.post(endpoint, json={"owner": "campaign-1", "confirmed": True}, headers=headers).status_code == 409
    campaigns._records["campaign-1"].state = "interrupted"
    queues._records["queue-1"] = SimpleNamespace(state="running")
    assert client.post(endpoint, json={"owner": "campaign-1", "confirmed": True}, headers=headers).status_code == 409
    assert calls == []
    queues._records["queue-1"].state = "interrupted"
    assert client.post(endpoint, json={"owner": "campaign-1", "confirmed": True}, headers=headers).status_code == 200
    assert [request.method for request in calls] == ["GET", "DELETE"]
    assert "campaign-1" not in manager._reservations


def test_validation_preserves_authoritative_state_and_virtual_tip_snapshot(tmp_path):
    snapshot = {"fluid_state_id": 42, "containers": [], "pipette": {"attachment_uncertain": False}}
    calls = []
    def station(request):
        calls.append(request)
        assert request.url.path == "/api/v1/runs/validate"
        payload = json.loads(request.content)
        assert "state" not in payload
        assert payload["mock_mode"] is True
        assert payload["tip_snapshot"] == snapshot
        assert payload["protocol_yaml"] == "protocol: []"
        return httpx.Response(200, json={"valid": True, "errors": [], "output": "dry validation"})
    manager = make_adapter(tmp_path, station)
    assert manager._validate_bundle("gantry: {}", "labware: {}", "protocol: []", tip_snapshot=snapshot)["valid"]
    assert len(calls) == 1


def test_proxy_allows_retained_monitor_and_refill_but_excludes_station_administration():
    from ursa_learning.app import proxy_allowed
    for method, path in [("GET", "instruments/camera/monitor"), ("GET", "instruments/camera/monitor/frame"), ("POST", "instruments/camera/monitor/start"), ("POST", "instruments/camera/monitor/heartbeat"), ("POST", "instruments/camera/monitor/stop"), ("POST", "fluid-states/42/reconcile-stock")]:
        assert proxy_allowed(method, path)
    for method, path in [("POST", "gantry/home"), ("POST", "gantry/jog"), ("PUT", "gantry/station.yaml"), ("PUT", "settings"), ("POST", "station/reservation"), ("DELETE", "station/reservation"), ("GET", "configs/deck/../raw")]:
        assert not proxy_allowed(method, path)


def test_operator_link_uses_configured_station_without_credentials(tmp_path, monkeypatch):
    from ursa_learning import app as application
    settings = LearningSettings(run_dir=tmp_path / 'runs', config_dir=tmp_path / 'configs', cubos_url='http://private:password@127.0.0.1:18742', trusted_hosts=['testserver'])
    monkeypatch.setattr(application, 'get_settings', lambda: settings)
    client = TestClient(application.create_app())
    response = client.get('/api/v1/learning/settings')
    assert response.status_code == 200
    assert response.json() == {'cubos_operator_url': 'http://127.0.0.1:18742'}
