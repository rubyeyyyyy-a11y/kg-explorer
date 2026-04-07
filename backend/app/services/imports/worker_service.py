import logging
import os
import threading

from app.services.imports import cleanup_executor_service, executor_service

logger = logging.getLogger(__name__)
_POLL_INTERVAL_SEC = max(0.1, float(os.getenv("IMPORT_WORKER_POLL_INTERVAL_SEC", "1.0")))


def startup_recover_and_start() -> None:
    executor_service.startup_recover_and_start()
    cleanup_executor_service.startup_recover_and_start()


def poll_once() -> None:
    if executor_service.has_queued_records():
        executor_service.ensure_worker_running()
    if cleanup_executor_service.has_queued_records():
        cleanup_executor_service.ensure_worker_running()


def run_available_jobs_once() -> None:
    executor_service.drain_queue()
    cleanup_executor_service.drain_queue()


def run_forever(*, stop_event: threading.Event, poll_interval_sec: float = _POLL_INTERVAL_SEC) -> None:
    startup_recover_and_start()
    logger.info("worker_loop_started poll_interval_sec=%.3f", poll_interval_sec)
    while not stop_event.is_set():
        poll_once()
        stop_event.wait(poll_interval_sec)
    logger.info("worker_loop_stopped")
