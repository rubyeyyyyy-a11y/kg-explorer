import logging
import signal
import threading

from app import runtime_setup  # noqa: F401
from app.process_runtime import build_instance_id, log_process_start, prepare_process_runtime
from app.services.imports import worker_service

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

logger = logging.getLogger(__name__)
INSTANCE_ID = build_instance_id("worker")


def main() -> None:
    stop_event = threading.Event()

    def _handle_signal(signum, _frame) -> None:
        logger.info("worker_stop_signal signal=%s", signum)
        stop_event.set()

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, _handle_signal)

    prepare_process_runtime()
    log_process_start(process_role="worker", instance_id=INSTANCE_ID)
    worker_service.run_forever(stop_event=stop_event)


if __name__ == "__main__":
    main()
