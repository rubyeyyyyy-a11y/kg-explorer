#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../dev/common.sh"

status=0

print_http_service_state() {
  local name="$1"
  local log_file="$2"
  local -n state_ref="$3"

  printf '%s: %s log=%s\n' "$name" "$(service_state_summary "$3")" "$log_file"

  if [ "${state_ref[status]}" != "running" ]; then
    status=1
  fi
}

print_process_state() {
  local name="$1"
  local log_file="$2"
  local -n state_ref="$3"

  printf '%s: %s log=%s\n' "$name" "$(process_state_summary "$3")" "$log_file"

  if [ "${state_ref[status]}" != "running" ]; then
    status=1
  fi
}

declare -A backend_api_state=()
declare -A backend_worker_state=()
declare -A kg_platform_state=()

collect_service_state "$BACKEND_API_PID_FILE" "$BACKEND_PORT" "$(backend_api_url)/api/health/live" find_backend_api_pids backend_api_state
collect_process_state "$BACKEND_WORKER_PID_FILE" find_backend_worker_pids backend_worker_state
collect_service_state "$KG_PLATFORM_PID_FILE" "$KG_PLATFORM_PORT" "$(kg_platform_url)" find_kg_platform_pids kg_platform_state

print_http_service_state "backend-api" "$BACKEND_API_LOG_FILE" backend_api_state
print_process_state "backend-worker" "$BACKEND_WORKER_LOG_FILE" backend_worker_state
print_http_service_state "kg-platform" "$KG_PLATFORM_LOG_FILE" kg_platform_state

if [ "${backend_api_state[http_reachable]}" -ne 1 ]; then
  echo "dependencies: skipped api_unreachable nebula_targets=$(nebula_targets) es_targets=$(es_targets)"
  exit "$status"
fi

live_payload_file="$(make_tmp_file)"
ready_payload_file="$(make_tmp_file)"
dependencies_payload_file="$(make_tmp_file)"
trap 'rm -f "$live_payload_file" "$ready_payload_file" "$dependencies_payload_file"' EXIT

live_http_code="$(fetch_endpoint_to_file "$(backend_api_url)/api/health/live" "$live_payload_file" 8 || true)"
ready_http_code="$(fetch_endpoint_to_file "$(backend_api_url)/api/health/ready" "$ready_payload_file" 8 || true)"
dependencies_http_code="$(fetch_endpoint_to_file "$(backend_api_url)/api/health/dependencies" "$dependencies_payload_file" 8 || true)"

if [ -n "$live_http_code" ] && [ -s "$live_payload_file" ]; then
  print_health_endpoint_report "/api/health/live" "$live_http_code" "$live_payload_file"
  if [ "$(health_json_status "$live_payload_file")" != "ok" ]; then
    status=1
  fi
else
  echo "/api/health/live: unavailable"
  status=1
fi

if [ -n "$ready_http_code" ] && [ -s "$ready_payload_file" ]; then
  print_health_endpoint_report "/api/health/ready" "$ready_http_code" "$ready_payload_file"
else
  echo "/api/health/ready: unavailable"
  status=1
fi

if [ -n "$dependencies_http_code" ] && [ -s "$dependencies_payload_file" ]; then
  print_health_endpoint_report "/api/health/dependencies" "$dependencies_http_code" "$dependencies_payload_file"
  print_dependencies_report "$dependencies_payload_file"
else
  echo "/api/health/dependencies: unavailable"
  echo "dependencies: direct_hint nebula_targets=$(nebula_targets) es_targets=$(es_targets)"
  status=1
fi

exit "$status"
