"""Standalone learning server with a constrained CubOS HTTP gateway."""
from __future__ import annotations
import hmac
import os
from pathlib import Path
import re
from urllib.parse import urlsplit
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from ursa_learning.config import get_settings
from ursa_learning.services.run_manager import get_run_manager, RunConflictError
from ursa_learning.services.station import StationHTTPError, StationUnavailableError

FRONTEND_DIST = Path(os.environ.get("URSA_LEARNING_WEB_DIST", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
_MUTATING = {"POST", "PUT", "PATCH", "DELETE"}
_LOCAL = {"localhost", "127.0.0.1", "::1", "[::1]"}


def _allowed_hosts() -> set[str]:
    settings = get_settings()
    hosts = _LOCAL if settings.host in _LOCAL | {"0.0.0.0", "::"} else {settings.host}
    return {*(host.lower() for host in hosts), *(f"{host}:{settings.port}".lower() for host in hosts), *(host.lower() for host in settings.trusted_hosts)}


async def _security(request: Request, call_next):
    allowed = _allowed_hosts()
    host = request.headers.get("host", "").lower()
    if host not in allowed:
        return JSONResponse({"detail": "Invalid Host header"}, status_code=400)
    if request.method in _MUTATING:
        source = request.headers.get("origin") or request.headers.get("referer")
        if source and urlsplit(source).netloc.lower() not in allowed:
            return JSONResponse({"detail": "Cross-origin request blocked"}, status_code=403)
        if request.headers.get("sec-fetch-site") == "cross-site":
            return JSONResponse({"detail": "Cross-site request blocked"}, status_code=403)
        try:
            token = get_settings().resolved_api_token()
        except (OSError, ValueError):
            return JSONResponse({"detail": "Application token is unavailable"}, status_code=503)
        if token and not source:
            scheme, _, supplied = request.headers.get("authorization", "").partition(" ")
            if scheme.lower() != "bearer" or not hmac.compare_digest(supplied, token.get_secret_value()):
                return JSONResponse({"detail": "Invalid application API token"}, status_code=401)
    return await call_next(request)


# Explicit resource/method contracts. No settings browse, system updater,
# arbitrary URL, reservation-token access, or filesystem gateway is proxied.
_PROXY_RULES = (
    ({"GET"}, r"health"),
    ({"GET"}, r"settings"),
    ({"GET"}, r"station/(?:status|reservation)"),
    ({"GET"}, r"configs/(?:gantry|deck|protocol)/[^/]+/raw"),
    ({"POST"}, r"station/state/validate"),
    ({"GET", "POST"}, r"runs"),
    ({"POST"}, r"runs/validate"),
    ({"GET"}, r"runs/[A-Za-z0-9_.-]+(?:/(?:events|plan|artifacts)(?:/[^/]+)?)?"),
    ({"POST"}, r"runs/[A-Za-z0-9_.-]+/cancel"),
    ({"GET"}, r"fluid-states"),
    ({"GET"}, r"fluid-states/[0-9]+(?:/(?:containers|tips|caps|operations|reconciliation))?"),
    ({"POST"}, r"fluid-states/[0-9]+/(?:reconciliation/resolve|refill-tips|reconcile-stock)"),
    ({"GET"}, r"(?:gantry|deck|protocol)/configs"),
    ({"GET"}, r"gantry/(?:position|instrument-types|pipette-models|instrument-schemas|instrument-methods|instrument-method-params)"),
    ({"POST"}, r"gantry/(?:feed-hold|jog-cancel)"),
    ({"GET"}, r"protocol/(?:commands(?:/[^/]+)?|run-status)"),
    ({"POST"}, r"protocol/(?:validate|validate-setup|cancel)"),
    ({"POST"}, r"deck/preview-wells"),
    ({"GET"}, r"(?:gantry|deck|protocol)/[^/]+\.ya?ml"),
    ({"GET"}, r"data/(?:campaigns|experiments|campaigns/[0-9]+/(?:measurements|asmi)\.zip)"),
    ({"POST"}, r"instruments/camera/monitor/(?:start|heartbeat|stop)"),
    ({"GET"}, r"instruments/camera/monitor(?:/frame)?"),
)



def proxy_allowed(method: str, path: str) -> bool:
    if any(segment in {".", ".."} for segment in path.split("/")) or "\\" in path or "%" in path:
        return False
    return any(method in methods and re.fullmatch(pattern, path) for methods, pattern in _PROXY_RULES)


class ReservationRelease(BaseModel):
    owner: str
    confirmed: bool = False


def create_app() -> FastAPI:
    from ursa_learning.routers import campaigns, overnight_queue, presentation
    app = FastAPI(title="Ursa Learning API")
    app.middleware("http")(_security)

    @app.exception_handler(StationUnavailableError)
    async def station_unavailable(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=503)

    @app.exception_handler(StationHTTPError)
    async def station_error(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status_code)

    @app.exception_handler(RunConflictError)
    async def conflict(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.get("/api/v1/learning/settings")
    def learning_settings():
        url = urlsplit(get_settings().cubos_url)
        host = url.hostname or "localhost"
        if ":" in host:
            host = f"[{host}]"
        authority = f"{host}:{url.port}" if url.port is not None else host
        return {"cubos_operator_url": f"{url.scheme}://{authority}{url.path.rstrip('/')}"}

    @app.post("/api/v1/learning/reservation/release")
    def release_reservation(body: ReservationRelease):
        from ursa_learning.services.campaign_manager import get_campaign_manager, TERMINAL
        from ursa_learning.services.overnight_queue import get_overnight_queue_manager, QUEUE_TERMINAL
        if not body.confirmed:
            raise RunConflictError("Confirm the interrupted owner and inspect the physical station before releasing its reservation")
        campaigns = get_campaign_manager()
        queues = get_overnight_queue_manager()
        manager = get_run_manager()
        # Same lock order as queue start/recovery. Holding the locks across
        # release prevents a paused campaign from resuming mid-recovery.
        with queues._lock, queues._claim_lock(), campaigns._lock:
            owner = campaigns._records.get(body.owner)
            if owner is not None and owner.state not in TERMINAL:
                raise RunConflictError("Stop the active or paused campaign before releasing its reservation")
            if any(queue.state not in QUEUE_TERMINAL and queue.state != "prepared" for queue in queues._records.values()):
                raise RunConflictError("Stop the active overnight queue before releasing its reservation")
            if manager.active_run_id:
                raise RunConflictError("Wait for the station run to finish before releasing its reservation")
            if body.owner not in manager._reservations:
                raise RunConflictError("This application does not hold a recovery token for that owner")
            manager.release_campaign(body.owner)
        return {"released": True, "owner": body.owner}

    # Specific overnight paths precede /campaigns/{campaign_id}.
    app.include_router(overnight_queue.router)
    app.include_router(presentation.router)
    app.include_router(campaigns.router)

    @app.api_route("/api/v1/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def station_proxy_async(path: str, request: Request):
        if not proxy_allowed(request.method, path):
            return JSONResponse({"detail": "Station resource is not exposed by Ursa Learning"}, status_code=404)
        from starlette.concurrency import run_in_threadpool
        body = await request.body()
        headers = {"Content-Type": request.headers["content-type"]} if "content-type" in request.headers else {}
        response = await run_in_threadpool(
            get_run_manager().station.request, request.method, "/api/v1/" + path,
            content=body, params=list(request.query_params.multi_items()), headers=headers,
        )
        response_headers = {name: response.headers[name] for name in ("content-type", "content-disposition", "cache-control", "etag") if name in response.headers}
        return Response(response.content, status_code=response.status_code, headers=response_headers)

    if FRONTEND_DIST.is_dir():
        app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
    return app
