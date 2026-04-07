import os
from dataclasses import dataclass
from pathlib import Path


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _resolve_repo_path(raw: str, repo_root: Path) -> Path:
    path = Path(raw)
    if path.is_absolute():
        return path
    return repo_root / path


def _env_csv(name: str) -> tuple[str, ...]:
    raw = os.getenv(name)
    if raw is None:
        return ()
    return tuple(item.strip() for item in str(raw).split(",") if item.strip())


def _parse_nebula_hosts(*, raw_hosts: tuple[str, ...], fallback_host: str, fallback_port: int) -> tuple[tuple[str, int], ...]:
    parsed: list[tuple[str, int]] = []
    for item in raw_hosts:
        host = item
        port = fallback_port
        if ":" in item:
            maybe_host, maybe_port = item.rsplit(":", 1)
            try:
                port = int(maybe_port)
                host = maybe_host.strip() or fallback_host
            except ValueError:
                host = item.strip() or fallback_host
        host = host.strip() or fallback_host
        parsed.append((host, max(1, int(port))))
    if parsed:
        return tuple(parsed)
    return ((fallback_host, max(1, int(fallback_port))),)


def _parse_es_urls(*, raw_urls: tuple[str, ...], fallback_url: str) -> tuple[str, ...]:
    urls = tuple(item.rstrip("/") for item in raw_urls if item.rstrip("/"))
    if urls:
        return urls
    return (fallback_url.rstrip("/"),)


def _parse_allowed_spaces(*, raw_spaces: tuple[str, ...], default_space: str) -> tuple[str, ...]:
    ordered: list[str] = []
    for item in (default_space, *raw_spaces):
        value = str(item or "").strip()
        if value and value not in ordered:
            ordered.append(value)
    return tuple(ordered or [default_space])


REPO_ROOT = Path(__file__).resolve().parents[2]
RUN_ROOT = "./runtime"
_KG_RUNTIME_DIR = _resolve_repo_path(os.getenv("KG_RUNTIME_DIR", os.getenv("RUN_ROOT", RUN_ROOT)), REPO_ROOT)
_RUNTIME_RUN_DIR = _resolve_repo_path(os.getenv("RUNTIME_RUN_DIR", str(_KG_RUNTIME_DIR / ".run")), REPO_ROOT)
_RUNTIME_LOGS_DIR = _resolve_repo_path(os.getenv("RUNTIME_LOGS_DIR", str(_KG_RUNTIME_DIR / "logs")), REPO_ROOT)
_RUNTIME_ARTIFACTS_DIR = _resolve_repo_path(
    os.getenv("RUNTIME_ARTIFACTS_DIR", str(_KG_RUNTIME_DIR / "artifacts")),
    REPO_ROOT,
)
_KG_AUDIT_LOG_DIR = _resolve_repo_path(os.getenv("KG_AUDIT_LOG_DIR", str(_RUNTIME_LOGS_DIR)), REPO_ROOT)
_AUDIT_LOG_PATH = _resolve_repo_path(
    os.getenv("AUDIT_LOG_PATH", str(_KG_AUDIT_LOG_DIR / "edit_audit.jsonl")),
    REPO_ROOT,
)

_APP_ENV = str(os.getenv("APP_ENV", "dev")).strip() or "dev"
_LOG_LEVEL = str(os.getenv("LOG_LEVEL", "INFO")).strip().upper() or "INFO"
_API_HOST = str(os.getenv("API_HOST", "127.0.0.1")).strip() or "127.0.0.1"
_API_PORT = max(1, _env_int("API_PORT", 8000))

_LEGACY_NEBULA_HOST = str(os.getenv("NEBULA_HOST", "127.0.0.1")).strip() or "127.0.0.1"
_LEGACY_NEBULA_PORT = max(1, _env_int("NEBULA_PORT", 9669))
_NEBULA_HOSTS = _parse_nebula_hosts(
    raw_hosts=_env_csv("NEBULA_HOSTS"),
    fallback_host=_LEGACY_NEBULA_HOST,
    fallback_port=_LEGACY_NEBULA_PORT,
)
_KG_DEFAULT_SPACE = str(os.getenv("KG_DEFAULT_SPACE", os.getenv("NEBULA_SPACE", "demo_kg"))).strip() or "demo_kg"
_KG_ALLOWED_SPACES = _parse_allowed_spaces(
    raw_spaces=_env_csv("KG_ALLOWED_SPACES"),
    default_space=_KG_DEFAULT_SPACE,
)

_LEGACY_ES_URL = str(os.getenv("ES_URL", "http://127.0.0.1:9200")).strip() or "http://127.0.0.1:9200"
_ES_URLS = _parse_es_urls(raw_urls=_env_csv("ES_URLS"), fallback_url=_LEGACY_ES_URL)
_ES_INDEX_PREFIX = str(os.getenv("ES_INDEX_PREFIX", "kg")).strip().strip("_-") or "kg"
_ES_INDEX = str(os.getenv("ES_INDEX", f"{_ES_INDEX_PREFIX}_entity")).strip() or f"{_ES_INDEX_PREFIX}_entity"


@dataclass(frozen=True)
class Settings:
    app_env: str
    log_level: str
    api_host: str
    api_port: int

    nebula_hosts: tuple[tuple[str, int], ...]
    nebula_host: str
    nebula_port: int
    nebula_user: str
    nebula_password: str
    nebula_admin_user: str
    nebula_admin_password: str
    nebula_pool_size: int
    nebula_space: str
    nebula_timeout_ms: int

    edge_type: str

    search_topk: int
    search_include_edges_default: bool
    search_min_query_len: int
    search_candidate_limit: int
    search_desc_candidate_limit: int

    es_enabled: bool
    es_urls: tuple[str, ...]
    es_url: str
    es_username: str
    es_password: str
    es_index_prefix: str
    es_index: str
    es_timeout_ms: int
    es_bulk_timeout_ms: int
    es_bulk_upsert_batch_size: int
    es_bulk_upsert_max_bytes: int
    es_topk: int

    kg_default_space: str
    kg_allowed_spaces: tuple[str, ...]
    kg_import_enabled: bool
    kg_discovery_enabled: bool
    kg_runtime_dir: Path
    kg_audit_log_dir: Path

    dev_instance_trace: bool
    runtime_root: Path
    runtime_run_dir: Path
    runtime_logs_dir: Path
    runtime_artifacts_dir: Path
    audit_log_path: Path


settings = Settings(
    app_env=_APP_ENV,
    log_level=_LOG_LEVEL,
    api_host=_API_HOST,
    api_port=_API_PORT,
    nebula_hosts=_NEBULA_HOSTS,
    nebula_host=_NEBULA_HOSTS[0][0],
    nebula_port=_NEBULA_HOSTS[0][1],
    nebula_user=os.getenv("NEBULA_USER", "root"),
    nebula_password=os.getenv("NEBULA_PASSWORD", "nebula"),
    nebula_admin_user=os.getenv("NEBULA_ADMIN_USER", os.getenv("NEBULA_USER", "root")),
    nebula_admin_password=os.getenv("NEBULA_ADMIN_PASSWORD", os.getenv("NEBULA_PASSWORD", "nebula")),
    nebula_pool_size=max(1, _env_int("NEBULA_POOL_SIZE", 10)),
    nebula_space=_KG_DEFAULT_SPACE,
    nebula_timeout_ms=_env_int("NEBULA_TIMEOUT_MS", 5000),
    edge_type=os.getenv("EDGE_TYPE", "REL2").strip() or "REL2",
    search_topk=max(1, _env_int("TOPK", 100)),
    search_include_edges_default=_env_bool("SEARCH_INCLUDE_EDGES_DEFAULT", False),
    search_min_query_len=max(1, _env_int("SEARCH_MIN_QUERY_LEN", 3)),
    search_candidate_limit=max(1, _env_int("CANDIDATE_LIMIT", 300)),
    search_desc_candidate_limit=max(1, min(_env_int("DESC_CANDIDATE_LIMIT", 50), 50)),
    es_enabled=_env_bool("ES_ENABLED", True),
    es_urls=_ES_URLS,
    es_url=_ES_URLS[0],
    es_username=str(os.getenv("ES_USERNAME", "")).strip(),
    es_password=str(os.getenv("ES_PASSWORD", "")).strip(),
    es_index_prefix=_ES_INDEX_PREFIX,
    es_index=_ES_INDEX,
    es_timeout_ms=max(100, _env_int("ES_TIMEOUT_MS", 5000)),
    es_bulk_timeout_ms=max(100, _env_int("ES_BULK_TIMEOUT_MS", 12000)),
    es_bulk_upsert_batch_size=max(1, _env_int("ES_BULK_UPSERT_BATCH_SIZE", 250)),
    es_bulk_upsert_max_bytes=max(16 * 1024, _env_int("ES_BULK_UPSERT_MAX_BYTES", 2 * 1024 * 1024)),
    es_topk=max(1, min(_env_int("ES_TOPK", _env_int("TOPK", 100)), 500)),
    kg_default_space=_KG_DEFAULT_SPACE,
    kg_allowed_spaces=_KG_ALLOWED_SPACES,
    kg_import_enabled=_env_bool("KG_IMPORT_ENABLED", True),
    kg_discovery_enabled=_env_bool("KG_DISCOVERY_ENABLED", True),
    kg_runtime_dir=_KG_RUNTIME_DIR,
    kg_audit_log_dir=_KG_AUDIT_LOG_DIR,
    dev_instance_trace=_env_bool("DEV_INSTANCE_TRACE", True),
    runtime_root=_KG_RUNTIME_DIR,
    runtime_run_dir=_RUNTIME_RUN_DIR,
    runtime_logs_dir=_RUNTIME_LOGS_DIR,
    runtime_artifacts_dir=_RUNTIME_ARTIFACTS_DIR,
    audit_log_path=_AUDIT_LOG_PATH,
)
