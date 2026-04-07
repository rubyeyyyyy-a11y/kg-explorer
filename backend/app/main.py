import logging
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import Response
from fastapi.responses import JSONResponse

from app import runtime_setup  # noqa: F401
from app import config as app_config
from app.api import routes_edit
from app.core.space_context import SPACE_HEADER, bind_request_space, reset_current_space
from app.process_runtime import build_instance_id, log_process_start, prepare_process_runtime
from app.services import health_service
from app.routers import detail, graph, imports, search, search_v2, spaces, team_ingestion


app = FastAPI(title="KG Entity Search API")
logger = logging.getLogger(__name__)


DEV_INSTANCE_TRACE = app_config.settings.dev_instance_trace
INSTANCE_ID = build_instance_id("api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health(request: Request):
    payload, status_code = health_service.build_legacy_response(request)
    return JSONResponse(status_code=status_code, content=payload.model_dump())


@app.get("/api/health/live")
def health_live():
    payload, status_code = health_service.build_live_response()
    return JSONResponse(status_code=status_code, content=payload.model_dump())


@app.get("/api/health/ready")
def health_ready(request: Request):
    payload, status_code = health_service.build_ready_response(request)
    return JSONResponse(status_code=status_code, content=payload.model_dump())


@app.get("/api/health/dependencies")
def health_dependencies(request: Request):
    payload, status_code = health_service.build_dependencies_response(request)
    return JSONResponse(status_code=status_code, content=payload.model_dump())


@app.on_event("startup")
def startup_prepare():
    prepare_process_runtime()
    health_service.mark_startup_complete()
    log_process_start(process_role="api", instance_id=INSTANCE_ID)


@app.middleware("http")
async def add_instance_header(request: Request, call_next) -> Response:
    if request.url.path.startswith("/api/v1/team-ingestion") and request.headers.get(SPACE_HEADER) is not None:
        return JSONResponse(
            status_code=400,
            content={
                "detail": {
                    "error_code": "TEAM_INGESTION_SPACE_HEADER_REJECTED",
                    "message": (
                        "team-ingestion V1 rejects external X-KG-Space and always executes in "
                        f"{app_config.settings.kg_default_space}"
                    ),
                    "field": SPACE_HEADER,
                }
            },
        )
    try:
        token = bind_request_space(request)
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    try:
        resolved = getattr(request.state, "space_resolution", None)
        logger.warning(
            "request_space method=%s path=%s space=%s source=%s registry_status=%s",
            request.method,
            request.url.path,
            getattr(request.state, "space_name", app_config.settings.kg_default_space),
            getattr(resolved, "source", "unknown"),
            getattr(resolved, "registry_status", None),
        )
        response = await call_next(request)
    finally:
        reset_current_space(token)
    if DEV_INSTANCE_TRACE:
        response.headers["X-Instance-Id"] = INSTANCE_ID
    response.headers["X-KG-Space"] = getattr(request.state, "space_name", app_config.settings.kg_default_space)
    return response


app.include_router(search.router)
app.include_router(search_v2.router)
app.include_router(graph.router)
app.include_router(detail.router)
app.include_router(routes_edit.router)
app.include_router(imports.router)
app.include_router(spaces.router)
app.include_router(team_ingestion.router)
