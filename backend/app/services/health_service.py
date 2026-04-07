from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Iterable

from fastapi import Request

from app.clients.es_client import ElasticsearchClient
from app.config import settings
from app.core.config import ensure_audit_log_dir
from app.core.space_context import resolve_request_space
from app.db.nebula import execute_ngql
from app.schemas.health import DependenciesHealthResp, HealthComponent, HealthStatus, LegacyHealthResp, LiveHealthResp, ReadyHealthResp
from app.services.spaces import readiness_service, registry_service

_STARTUP_COMPLETED = False


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _request_id() -> str:
    return uuid.uuid4().hex[:12]


def mark_startup_complete() -> None:
    global _STARTUP_COMPLETED
    _STARTUP_COMPLETED = True


def _component(
    status: HealthStatus,
    detail: str,
    *,
    reason: str | None = None,
    took_ms: float | None = None,
    metadata: dict | None = None,
) -> HealthComponent:
    return HealthComponent(
        status=status,
        detail=detail,
        reason=reason,
        took_ms=None if took_ms is None else round(float(took_ms), 3),
        metadata=dict(metadata or {}),
    )


def _aggregate_status(components: Iterable[HealthComponent]) -> HealthStatus:
    statuses = [component.status for component in components]
    if any(status == "down" for status in statuses):
        return "down"
    if any(status == "degraded" for status in statuses):
        return "degraded"
    return "ok"


def _http_status(status: HealthStatus) -> int:
    return 503 if status == "down" else 200


def _check_directory(path: Path, *, detail: str) -> HealthComponent:
    try:
        path.mkdir(parents=True, exist_ok=True)
        if not path.is_dir():
            raise RuntimeError("path exists but is not a directory")
        return _component("ok", detail, metadata={"path": str(path)})
    except Exception as exc:
        return _component("down", f"{detail} failed", reason=str(exc), metadata={"path": str(path)})


def _collect_live_checks() -> dict[str, HealthComponent]:
    checks = {
        "startup": _component(
            "ok" if _STARTUP_COMPLETED else "down",
            "startup handlers completed" if _STARTUP_COMPLETED else "startup handlers not completed",
        ),
        "config": _component(
            "ok" if settings.kg_default_space and str(settings.runtime_root) else "down",
            "settings imported",
            metadata={
                "app_env": settings.app_env,
                "default_space": settings.kg_default_space,
                "allowed_spaces": list(settings.kg_allowed_spaces),
                "es_enabled": bool(settings.es_enabled),
                "runtime_root": str(settings.runtime_root),
            },
        ),
        "runtime_root": _check_directory(settings.runtime_root, detail="runtime root accessible"),
        "runtime_run_dir": _check_directory(settings.runtime_run_dir, detail="runtime run dir accessible"),
        "runtime_logs_dir": _check_directory(settings.runtime_logs_dir, detail="runtime logs dir accessible"),
    }
    try:
        ensure_audit_log_dir()
        checks["audit_log_dir"] = _component(
            "ok",
            "audit log dir accessible",
            metadata={"path": str(settings.audit_log_path.parent)},
        )
    except Exception as exc:
        checks["audit_log_dir"] = _component(
            "down",
            "audit log dir initialization failed",
            reason=str(exc),
            metadata={"path": str(settings.audit_log_path.parent)},
        )
    return checks


def _build_space_snapshot(space_name: str) -> dict | None:
    summary = registry_service.get_space(space_name)
    if summary is None:
        return None
    return readiness_service.build_space_summary_payload(summary)


def _current_space_snapshot(request: Request) -> tuple[dict | None, dict | None]:
    resolved = getattr(request.state, "space_resolution", None)
    if resolved is None:
        resolved = resolve_request_space(request)
    current_payload = readiness_service.build_current_space_payload(
        space_name=resolved.space_name,
        source=resolved.source,
        header_present=resolved.header_present,
        header_value=resolved.header_value,
        registry_status=resolved.registry_status,
    )
    summary = registry_service.get_space(resolved.space_name)
    return current_payload, (None if summary is None else summary.model_dump())


def _space_ready_status(summary: dict | None) -> tuple[HealthStatus, str]:
    if summary is None:
        return "down", "space is missing from registry"
    registry_status = str(summary.get("status") or "")
    internal_status = str(summary.get("internal_status") or "")
    if registry_status == "ready" and internal_status == "ready":
        return "ok", "space registry snapshot is ready"
    return "down", f"space registry status is {registry_status or 'unknown'} / {internal_status or 'unknown'}"


def _space_dependency_status(summary: dict | None) -> tuple[HealthStatus, str]:
    if summary is None:
        return "down", "space is missing from registry"
    registry_status = str(summary.get("status") or "")
    internal_status = str(summary.get("internal_status") or "")
    if registry_status == "ready" and internal_status == "ready":
        return "ok", "space registry snapshot is ready"
    return "degraded", f"space registry status is {registry_status or 'unknown'} / {internal_status or 'unknown'}"


def _index_snapshot_status(space_payload: dict | None) -> tuple[HealthStatus, str]:
    if space_payload is None:
        return "down", "space snapshot unavailable"
    index_status = space_payload.get("index_status")
    if index_status is None:
        return "degraded", "index status snapshot missing from registry"
    raw_status = str(index_status.get("status") or "")
    if raw_status in {"verified_nonempty", "verified_empty"}:
        return "ok", raw_status
    if raw_status == "verified_partial":
        return "degraded", raw_status
    if raw_status == "failed":
        return "down", raw_status
    return "degraded", raw_status or "unknown"


def _probe_nebula() -> HealthComponent:
    started = time.perf_counter()
    try:
        result = execute_ngql("SHOW HOSTS;", use_space=False)
        took_ms = (time.perf_counter() - started) * 1000.0
        if not result.is_succeeded():
            return _component("down", "nebula health probe failed", reason=str(result.error_msg() or ""), took_ms=took_ms)
        return _component(
            "ok",
            "nebula responded to SHOW HOSTS",
            took_ms=took_ms,
            metadata={"hosts_rows": len(result.rows())},
        )
    except Exception as exc:
        took_ms = (time.perf_counter() - started) * 1000.0
        return _component("down", "nebula health probe failed", reason=str(exc), took_ms=took_ms)


def _probe_elasticsearch() -> HealthComponent:
    if not settings.es_enabled:
        return _component(
            "degraded",
            "elasticsearch is disabled by configuration",
            reason="es_enabled=false",
            metadata={
                "enabled": False,
                "base_url": settings.es_url,
                "urls": list(settings.es_urls),
                "index": settings.es_index,
            },
        )

    ok, took_ms, reason = ElasticsearchClient().healthcheck()
    status: HealthStatus = "ok" if ok else "down"
    detail = "elasticsearch cluster health reachable" if ok else "elasticsearch cluster health failed"
    return _component(
        status,
        detail,
        reason=None if ok else reason,
        took_ms=took_ms,
        metadata={
            "enabled": True,
            "base_url": settings.es_url,
            "urls": list(settings.es_urls),
            "index": settings.es_index,
            "username_set": bool(settings.es_username),
            "result": reason,
        },
    )


def build_live_response(*, request_id: str | None = None, timestamp: str | None = None) -> tuple[LiveHealthResp, int]:
    resolved_request_id = request_id or _request_id()
    resolved_timestamp = timestamp or _now_iso()
    checks = _collect_live_checks()
    payload = LiveHealthResp(
        status=_aggregate_status(checks.values()),
        request_id=resolved_request_id,
        timestamp=resolved_timestamp,
        checks=checks,
    )
    return payload, _http_status(payload.status)


def build_ready_response(request: Request, *, request_id: str | None = None, timestamp: str | None = None) -> tuple[ReadyHealthResp, int]:
    resolved_request_id = request_id or _request_id()
    resolved_timestamp = timestamp or _now_iso()

    live_payload, _ = build_live_response(request_id=resolved_request_id, timestamp=resolved_timestamp)
    checks = {
        "live": _component(live_payload.status, "live baseline for ready"),
    }

    try:
        registry = registry_service.read_registry()
        checks["registry"] = _component(
            "ok",
            "space registry readable",
            metadata={"format_version": registry.format_version, "space_count": len(registry.spaces)},
        )
    except Exception as exc:
        checks["registry"] = _component("down", "space registry read failed", reason=str(exc))

    default_summary = None
    try:
        default_summary = registry_service.get_space(settings.kg_default_space)
        status, detail = _space_ready_status(None if default_summary is None else default_summary.model_dump())
        checks["default_space"] = _component(
            status,
            detail,
            metadata={"space_name": settings.kg_default_space, "summary": _build_space_snapshot(settings.kg_default_space)},
        )
    except Exception as exc:
        checks["default_space"] = _component(
            "down",
            "default space readiness evaluation failed",
            reason=str(exc),
            metadata={"space_name": settings.kg_default_space},
        )

    try:
        current_payload, current_summary = _current_space_snapshot(request)
        status, detail = _space_ready_status(current_summary)
        checks["current_space"] = _component(
            status,
            detail,
            metadata={"space": current_payload},
        )
    except Exception as exc:
        checks["current_space"] = _component("down", "current space resolution failed", reason=str(exc))

    payload = ReadyHealthResp(
        status=_aggregate_status(checks.values()),
        request_id=resolved_request_id,
        timestamp=resolved_timestamp,
        checks=checks,
    )
    return payload, _http_status(payload.status)


def build_dependencies_response(
    request: Request,
    *,
    request_id: str | None = None,
    timestamp: str | None = None,
) -> tuple[DependenciesHealthResp, int]:
    resolved_request_id = request_id or _request_id()
    resolved_timestamp = timestamp or _now_iso()

    dependencies = {
        "nebula": _probe_nebula(),
        "elasticsearch": _probe_elasticsearch(),
    }

    try:
        current_payload, current_summary = _current_space_snapshot(request)
        default_payload = _build_space_snapshot(settings.kg_default_space)
        default_summary = registry_service.get_space(settings.kg_default_space)
        current_status, current_detail = _space_dependency_status(current_summary)
        default_status, default_detail = _space_dependency_status(None if default_summary is None else default_summary.model_dump())
        dependencies["space"] = _component(
            _aggregate_status(
                [
                    _component(current_status, current_detail),
                    _component(default_status, default_detail),
                ]
            ),
            "registry-backed space readiness snapshot",
            metadata={
                "current_space": current_payload,
                "default_space": default_payload,
            },
        )
        current_index_status, current_index_detail = _index_snapshot_status(current_payload)
        default_index_status, default_index_detail = _index_snapshot_status(default_payload)
        dependencies["index"] = _component(
            _aggregate_status(
                [
                    _component(current_index_status, current_index_detail),
                    _component(default_index_status, default_index_detail),
                ]
            ),
            "index status snapshot from registry",
            metadata={
                "source": "space_registry_snapshot",
                "note": "this endpoint does not refresh index verification; it reports the latest recorded snapshot",
                "current_space": {
                    "space_name": None if current_payload is None else current_payload.get("space_name"),
                    "graph_status": None if current_payload is None else current_payload.get("graph_status"),
                    "search_status": None if current_payload is None else current_payload.get("search_status"),
                    "index_status": None if current_payload is None else current_payload.get("index_status"),
                },
                "default_space": {
                    "space_name": None if default_payload is None else default_payload.get("space_name"),
                    "graph_status": None if default_payload is None else default_payload.get("graph_status"),
                    "search_status": None if default_payload is None else default_payload.get("search_status"),
                    "index_status": None if default_payload is None else default_payload.get("index_status"),
                },
            },
        )
    except Exception as exc:
        dependencies["space"] = _component("down", "space readiness snapshot failed", reason=str(exc))
        dependencies["index"] = _component(
            "down",
            "index status snapshot failed",
            reason=str(exc),
            metadata={
                "source": "space_registry_snapshot",
                "note": "index status depends on registry-backed space metadata",
            },
        )

    payload = DependenciesHealthResp(
        status=_aggregate_status(dependencies.values()),
        request_id=resolved_request_id,
        timestamp=resolved_timestamp,
        dependencies=dependencies,
    )
    return payload, _http_status(payload.status)


def build_legacy_response(request: Request) -> tuple[LegacyHealthResp, int]:
    resolved_request_id = _request_id()
    resolved_timestamp = _now_iso()
    live_payload, _ = build_live_response(request_id=resolved_request_id, timestamp=resolved_timestamp)
    ready_payload, _ = build_ready_response(request, request_id=resolved_request_id, timestamp=resolved_timestamp)
    dependencies_payload, _ = build_dependencies_response(request, request_id=resolved_request_id, timestamp=resolved_timestamp)

    checks = {
        "live": _component(live_payload.status, "compatibility summary of /api/health/live"),
        "ready": _component(ready_payload.status, "compatibility summary of /api/health/ready"),
        "dependencies": _component(dependencies_payload.status, "compatibility summary of /api/health/dependencies"),
    }
    payload = LegacyHealthResp(
        status=_aggregate_status([*checks.values(), *dependencies_payload.dependencies.values()]),
        request_id=resolved_request_id,
        timestamp=resolved_timestamp,
        compatibility="legacy aggregate health view; prefer /api/health/live, /api/health/ready, /api/health/dependencies",
        checks=checks,
        dependencies=dependencies_payload.dependencies,
    )
    return payload, _http_status(payload.status)
