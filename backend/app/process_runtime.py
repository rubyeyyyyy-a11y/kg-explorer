import logging
import os
import socket
import uuid
from pathlib import Path

from app.config import settings
from app.core.config import ensure_audit_log_dir
from app.db import nebula as nebula_db
from app.services.spaces import registry_service

logger = logging.getLogger(__name__)
REPO_ROOT = Path(__file__).resolve().parents[1]


def build_instance_id(process_role: str) -> str:
    return f"{REPO_ROOT.name}:{process_role}:{uuid.uuid4().hex[:12]}"


def prepare_process_runtime() -> None:
    ensure_audit_log_dir()
    registry_service.register_default_space()


def log_process_start(*, process_role: str, instance_id: str) -> None:
    logger.warning(
        "process_start process_role=%s instance_id=%s repo=%s host=%s app_env=%s edge_type=%s nebula=%s:%s space=%s pid=%d",
        process_role,
        instance_id,
        str(REPO_ROOT),
        socket.gethostname(),
        settings.app_env,
        nebula_db.EDGE_TYPE,
        nebula_db.NEBULA_HOST,
        nebula_db.NEBULA_PORT,
        nebula_db.NEBULA_SPACE,
        os.getpid(),
    )
