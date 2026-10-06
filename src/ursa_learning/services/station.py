"""Request-scoped HTTP access to the authoritative CubOS station."""
from __future__ import annotations
from typing import Any
from urllib.parse import quote
import httpx
from ursa_learning.config import LearningSettings, get_settings


class StationUnavailableError(RuntimeError):
    """The station outcome cannot be determined; never retry a run blindly."""


class StationHTTPError(ValueError):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        super().__init__(detail)


class StationClient:
    def __init__(self, settings: LearningSettings | None = None, *, client: httpx.Client | None = None):
        self.settings = settings or get_settings()
        self.client = client or httpx.Client(base_url=self.settings.cubos_url.rstrip("/"), timeout=self.settings.request_timeout)

    def headers(self) -> dict[str, str]:
        token = self.settings.resolved_cubos_token()
        return {"Authorization": f"Bearer {token.get_secret_value()}"} if token else {}

    def request(self, method: str, path: str, *, headers=None, **kwargs) -> httpx.Response:
        if not path.startswith("/api/v1/"):
            raise ValueError("Station requests must use /api/v1 resources")
        try:
            response = self.client.request(method, path, headers={**self.headers(), **(headers or {})}, **kwargs)
        except httpx.HTTPError as exc:
            raise StationUnavailableError(
                "CubOS is unavailable or the request timed out. A submitted run may still be running; inspect its run ID before retrying."
            ) from exc
        if response.is_error:
            try:
                detail = response.json().get("detail", response.text)
            except (ValueError, AttributeError):
                detail = response.text
            raise StationHTTPError(response.status_code, str(detail))
        return response

    def request_json(self, method: str, path: str, **kwargs) -> Any:
        return self.request(method, path, **kwargs).json()

    def read_config(self, category: str, filename: str) -> str:
        from ursa_learning.services.yaml_io import safe_filename
        if category not in {"gantry", "deck", "protocol"}:
            raise ValueError("Unsupported station configuration category")
        safe_filename(filename)
        result = self.request_json("GET", f"/api/v1/configs/{category}/{quote(filename, safe='')}/raw")
        return result["content"]

    def status(self) -> dict:
        return self.request_json("GET", "/api/v1/station/status")

    def get_tip_snapshot(self, state_id: int) -> dict:
        return self.request_json("GET", f"/api/v1/fluid-states/{int(state_id)}/tips")

    def get_fluid_snapshot(self, state_id: int) -> dict:
        return self.request_json("GET", f"/api/v1/fluid-states/{int(state_id)}")
