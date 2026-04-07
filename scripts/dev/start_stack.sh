#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

cleanup_stale_pid_file "$BACKEND_API_PID_FILE"
cleanup_stale_pid_file "$BACKEND_WORKER_PID_FILE"
cleanup_stale_pid_file "$KG_PLATFORM_PID_FILE"

ensure_backend_ready
ensure_kg_platform_ready

BACKEND_API_STARTING_PID_FILE="$RUN_DIR/backend-api.pid.starting"
BACKEND_WORKER_STARTING_PID_FILE="$RUN_DIR/backend-worker.pid.starting"
KG_PLATFORM_STARTING_PID_FILE="$RUN_DIR/kg-platform.pid.starting"

cleanup_starting_pid_files() {
  rm -f \
    "$BACKEND_API_STARTING_PID_FILE" \
    "$BACKEND_WORKER_STARTING_PID_FILE" \
    "$KG_PLATFORM_STARTING_PID_FILE"
}

trap cleanup_starting_pid_files EXIT

start_detached() {
  local pid_file="$1"
  local log_file="$2"
  local workdir="$3"
  shift 3

  if command -v setsid >/dev/null 2>&1; then
    setsid bash -lc '
      pid_file="$1"
      workdir="$2"
      shift 2
      cd "$workdir"
      echo $$ > "$pid_file"
      exec "$@"
    ' bash "$pid_file" "$workdir" "$@" >>"$log_file" 2>&1 < /dev/null &
  else
    nohup bash -lc '
      pid_file="$1"
      workdir="$2"
      shift 2
      cd "$workdir"
      echo $$ > "$pid_file"
      exec "$@"
    ' bash "$pid_file" "$workdir" "$@" >>"$log_file" 2>&1 < /dev/null &
  fi
}

wait_for_pid_file() {
  local pid_file="$1"
  local attempts="${2:-20}"
  local i
  for ((i = 1; i <= attempts; i += 1)); do
    if read_pid_file "$pid_file" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

existing_backend_api_pids="$(find_backend_api_pids | tr '\n' ' ' | xargs -r echo || true)"
existing_backend_worker_pids="$(find_backend_worker_pids | tr '\n' ' ' | xargs -r echo || true)"
existing_kg_platform_pids="$(find_kg_platform_pids | tr '\n' ' ' | xargs -r echo || true)"

if [ -n "$existing_backend_api_pids" ] || [ -n "$existing_backend_worker_pids" ] || [ -n "$existing_kg_platform_pids" ] || [ -f "$BACKEND_API_PID_FILE" ] || [ -f "$BACKEND_WORKER_PID_FILE" ] || [ -f "$KG_PLATFORM_PID_FILE" ]; then
  info "existing managed stack detected, stopping before restart"
  bash "$ROOT/scripts/dev/stop_stack.sh" >/dev/null 2>&1 || true
fi

ensure_port_available "$BACKEND_PORT" "backend-api"
ensure_port_available "$KG_PLATFORM_PORT" "kg-platform"

cleanup_starting_pid_files
: > "$BACKEND_API_LOG_FILE"
: > "$BACKEND_WORKER_LOG_FILE"
: > "$KG_PLATFORM_LOG_FILE"

info "starting backend-api"
start_detached "$BACKEND_API_STARTING_PID_FILE" "$BACKEND_API_LOG_FILE" "$ROOT/backend" \
  "$BACKEND_PYTHON_BIN" -m uvicorn app.main:app --host "$BACKEND_HOST" --port "$BACKEND_PORT" --log-level info

wait_for_pid_file "$BACKEND_API_STARTING_PID_FILE" || fail "backend-api pid file was not created: $BACKEND_API_STARTING_PID_FILE"
backend_api_pid="$(read_pid_file "$BACKEND_API_STARTING_PID_FILE" || true)"
if [ -z "$backend_api_pid" ] || ! is_pid_running "$backend_api_pid"; then
  rm -f "$BACKEND_API_STARTING_PID_FILE" "$BACKEND_API_PID_FILE"
  fail "backend-api failed to start; see $BACKEND_API_LOG_FILE"
fi

if ! wait_for_pid_service_ready "$backend_api_pid" "$BACKEND_PORT" "$(backend_api_url)/api/health/live" 30 1; then
  tail -n 40 "$BACKEND_API_LOG_FILE" || true
  rm -f "$BACKEND_API_STARTING_PID_FILE" "$BACKEND_API_PID_FILE"
  bash "$ROOT/scripts/dev/stop_stack.sh" >/dev/null 2>&1 || true
  fail "backend-api live check failed: $(backend_api_url)/api/health/live"
fi
mv "$BACKEND_API_STARTING_PID_FILE" "$BACKEND_API_PID_FILE"

info "starting backend-worker"
start_detached "$BACKEND_WORKER_STARTING_PID_FILE" "$BACKEND_WORKER_LOG_FILE" "$ROOT/backend" \
  "$BACKEND_PYTHON_BIN" -m app.worker_main

wait_for_pid_file "$BACKEND_WORKER_STARTING_PID_FILE" || fail "backend-worker pid file was not created: $BACKEND_WORKER_STARTING_PID_FILE"
backend_worker_pid="$(read_pid_file "$BACKEND_WORKER_STARTING_PID_FILE" || true)"
if [ -z "$backend_worker_pid" ] || ! is_pid_running "$backend_worker_pid"; then
  tail -n 40 "$BACKEND_WORKER_LOG_FILE" || true
  rm -f "$BACKEND_WORKER_STARTING_PID_FILE" "$BACKEND_WORKER_PID_FILE"
  bash "$ROOT/scripts/dev/stop_stack.sh" >/dev/null 2>&1 || true
  fail "backend-worker failed to start; see $BACKEND_WORKER_LOG_FILE"
fi

if ! wait_for_process_stable "$backend_worker_pid" 5 1; then
  tail -n 40 "$BACKEND_WORKER_LOG_FILE" || true
  rm -f "$BACKEND_WORKER_STARTING_PID_FILE" "$BACKEND_WORKER_PID_FILE"
  bash "$ROOT/scripts/dev/stop_stack.sh" >/dev/null 2>&1 || true
  fail "backend-worker exited during startup; see $BACKEND_WORKER_LOG_FILE"
fi
mv "$BACKEND_WORKER_STARTING_PID_FILE" "$BACKEND_WORKER_PID_FILE"

info "starting kg-platform"
start_detached "$KG_PLATFORM_STARTING_PID_FILE" "$KG_PLATFORM_LOG_FILE" "$KG_PLATFORM_APP_ROOT" \
  env \
  APP_ENV="${APP_ENV:-dev}" \
  HOST="$KG_PLATFORM_HOST" \
  PORT="$KG_PLATFORM_PORT" \
  API_BASE_PATH="${API_BASE_PATH:-/api}" \
  API_TIMEOUT_MS="${API_TIMEOUT_MS:-15000}" \
  UI_EXPOSE_SOURCE_SWITCH="${UI_EXPOSE_SOURCE_SWITCH:-1}" \
  UI_ENABLE_MOCK_FALLBACK="${UI_ENABLE_MOCK_FALLBACK:-1}" \
  DEV_API_PROXY_TARGET="${DEV_API_PROXY_TARGET:-$(backend_api_url)}" \
  "$KG_PLATFORM_UMI_ENTRY" dev

wait_for_pid_file "$KG_PLATFORM_STARTING_PID_FILE" || fail "kg-platform pid file was not created: $KG_PLATFORM_STARTING_PID_FILE"
kg_platform_pid="$(read_pid_file "$KG_PLATFORM_STARTING_PID_FILE" || true)"
if [ -z "$kg_platform_pid" ] || ! is_pid_running "$kg_platform_pid"; then
  tail -n 40 "$KG_PLATFORM_LOG_FILE" || true
  rm -f "$KG_PLATFORM_STARTING_PID_FILE" "$KG_PLATFORM_PID_FILE"
  bash "$ROOT/scripts/dev/stop_stack.sh" >/dev/null 2>&1 || true
  fail "kg-platform failed to start; see $KG_PLATFORM_LOG_FILE"
fi

if ! wait_for_service_ready "$kg_platform_pid" "$KG_PLATFORM_PORT" "$(kg_platform_url)" 30 1; then
  tail -n 40 "$KG_PLATFORM_LOG_FILE" || true
  rm -f "$KG_PLATFORM_STARTING_PID_FILE" "$KG_PLATFORM_PID_FILE"
  bash "$ROOT/scripts/dev/stop_stack.sh" >/dev/null 2>&1 || true
  fail "kg-platform entry check failed: $(kg_platform_url)"
fi
mv "$KG_PLATFORM_STARTING_PID_FILE" "$KG_PLATFORM_PID_FILE"

echo "backend-api: pid=$backend_api_pid url=$(backend_api_url) log=$BACKEND_API_LOG_FILE"
echo "backend-worker: pid=$backend_worker_pid log=$BACKEND_WORKER_LOG_FILE"
echo "kg-platform: pid=$kg_platform_pid url=$(kg_platform_url) log=$KG_PLATFORM_LOG_FILE"

ready_payload_file="$(make_tmp_file)"
dependencies_payload_file="$(make_tmp_file)"
trap 'rm -f "$ready_payload_file" "$dependencies_payload_file"; cleanup_starting_pid_files' EXIT

ready_http_code="$(fetch_endpoint_to_file "$(backend_api_url)/api/health/ready" "$ready_payload_file" 8 || true)"
if [ -n "$ready_http_code" ] && [ -s "$ready_payload_file" ]; then
  print_health_endpoint_report "/api/health/ready" "$ready_http_code" "$ready_payload_file"
else
  warn "unable to fetch /api/health/ready"
fi

dependencies_http_code="$(fetch_endpoint_to_file "$(backend_api_url)/api/health/dependencies" "$dependencies_payload_file" 8 || true)"
if [ -n "$dependencies_http_code" ] && [ -s "$dependencies_payload_file" ]; then
  print_health_endpoint_report "/api/health/dependencies" "$dependencies_http_code" "$dependencies_payload_file"
  print_dependencies_report "$dependencies_payload_file"
else
  warn "unable to fetch /api/health/dependencies"
fi
