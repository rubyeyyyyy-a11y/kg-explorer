#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../dev/common.sh"

SMOKE_FULL_API="${SMOKE_FULL_API:-0}"

declare -A backend_api_state=()
declare -A backend_worker_state=()
declare -A kg_platform_state=()

collect_service_state "$BACKEND_API_PID_FILE" "$BACKEND_PORT" "$(backend_api_url)/api/health/live" find_backend_api_pids backend_api_state
collect_process_state "$BACKEND_WORKER_PID_FILE" find_backend_worker_pids backend_worker_state
collect_service_state "$KG_PLATFORM_PID_FILE" "$KG_PLATFORM_PORT" "$(kg_platform_url)" find_kg_platform_pids kg_platform_state

require_service_http "backend-api" backend_api_state
require_process_running "backend-worker" backend_worker_state
require_service_http "kg-platform" kg_platform_state

printf '[smoke-stack] backend-api: %s\n' "$(service_state_summary backend_api_state)"
printf '[smoke-stack] backend-worker: %s\n' "$(process_state_summary backend_worker_state)"
printf '[smoke-stack] kg-platform: %s\n' "$(service_state_summary kg_platform_state)"

live_payload_file="$(make_tmp_file)"
ready_payload_file="$(make_tmp_file)"
dependencies_payload_file="$(make_tmp_file)"
trap 'rm -f "$live_payload_file" "$ready_payload_file" "$dependencies_payload_file"' EXIT

live_http_code="$(fetch_endpoint_to_file "$(backend_api_url)/api/health/live" "$live_payload_file" 10 || true)"
ready_http_code="$(fetch_endpoint_to_file "$(backend_api_url)/api/health/ready" "$ready_payload_file" 10 || true)"
dependencies_http_code="$(fetch_endpoint_to_file "$(backend_api_url)/api/health/dependencies" "$dependencies_payload_file" 10 || true)"

[ -n "$live_http_code" ] && [ -s "$live_payload_file" ] || fail "failed to fetch /api/health/live"
[ -n "$ready_http_code" ] && [ -s "$ready_payload_file" ] || fail "failed to fetch /api/health/ready"
[ -n "$dependencies_http_code" ] && [ -s "$dependencies_payload_file" ] || fail "failed to fetch /api/health/dependencies"

print_health_endpoint_report "/api/health/live" "$live_http_code" "$live_payload_file"
print_health_endpoint_report "/api/health/ready" "$ready_http_code" "$ready_payload_file"
print_health_endpoint_report "/api/health/dependencies" "$dependencies_http_code" "$dependencies_payload_file"
print_dependencies_report "$dependencies_payload_file"

live_status="$(health_json_status "$live_payload_file")"
ready_status="$(health_json_status "$ready_payload_file")"
dependencies_status="$(health_json_status "$dependencies_payload_file")"
dependencies_mode="$(dependencies_classification "$dependencies_payload_file")"

if [ "$live_status" != "ok" ]; then
  fail "smoke failed: /api/health/live status=$live_status"
fi

if [ "$dependencies_mode" = "dependency_connection_failed" ]; then
  fail "smoke failed: dependencies connection failure detected"
fi

if [ "$ready_status" != "ok" ] || [ "$dependencies_mode" = "dependency_reachable_readiness_incomplete" ] || [ "$dependencies_status" = "degraded" ]; then
  echo "[smoke-stack] result=warning reason=dependencies_reachable_but_readiness_incomplete"
  echo "[smoke-stack] note=backend-api_and_worker_are_up_but_space_or_index_is_not_fully_ready"
  exit 2
fi

if [ "$SMOKE_FULL_API" = "1" ]; then
  echo "[smoke-stack] running full backend smoke_api.sh"
  bash "$ROOT/scripts/verify/smoke_api.sh"
fi

echo "[smoke-stack] completed"
