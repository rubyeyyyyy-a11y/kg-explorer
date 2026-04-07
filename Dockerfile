FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/backend

WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r ./backend/requirements.txt

COPY backend/ ./backend/

RUN mkdir -p /app/runtime/.run /app/runtime/logs /app/runtime/artifacts

WORKDIR /app/backend

FROM base AS api

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]

FROM base AS worker

CMD ["python", "-m", "app.worker_main"]
