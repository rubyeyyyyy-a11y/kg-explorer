#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ONEX_FRONTEND_ROOT="${ONEX_FRONTEND_ROOT:-$(cd "$ROOT/../onex-frontend" 2>/dev/null && pwd || printf '%s' "$ROOT/../onex-frontend")}"
KG_PLATFORM_APP_ROOT="${KG_PLATFORM_APP_ROOT:-$ONEX_FRONTEND_ROOT/apps/kg-platform}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

if [ -f "$ENV_FILE" ] && [ "${KG_SYSTEM_ENV_LOADED:-0}" != "1" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  export KG_SYSTEM_ENV_LOADED=1
fi

RUN_DIR="${RUN_DIR:-$ROOT/runtime/.run}"
LOG_DIR="${LOG_DIR:-$ROOT/runtime/logs}"

BACKEND_HOST="${BACKEND_HOST:-${API_HOST:-127.0.0.1}}"
BACKEND_PORT="${BACKEND_PORT:-${API_PORT:-8000}}"
KG_PLATFORM_HOST="${KG_PLATFORM_HOST:-${FRONTEND_HOST:-127.0.0.1}}"
KG_PLATFORM_PORT="${KG_PLATFORM_PORT:-${FRONTEND_PORT:-5173}}"

BACKEND_API_PID_FILE="$RUN_DIR/backend-api.pid"
BACKEND_WORKER_PID_FILE="$RUN_DIR/backend-worker.pid"
KG_PLATFORM_PID_FILE="$RUN_DIR/kg-platform.pid"

BACKEND_API_LOG_FILE="$LOG_DIR/backend-api.log"
BACKEND_WORKER_LOG_FILE="$LOG_DIR/backend-worker.log"
KG_PLATFORM_LOG_FILE="$LOG_DIR/kg-platform.log"

BACKEND_PYTHON_BIN="$ROOT/backend/.venv/bin/python3"
if [ ! -x "$BACKEND_PYTHON_BIN" ] && [ -x "$ROOT/backend/.venv/bin/python" ]; then
  BACKEND_PYTHON_BIN="$ROOT/backend/.venv/bin/python"
fi
KG_PLATFORM_UMI_ENTRY="$KG_PLATFORM_APP_ROOT/node_modules/.bin/umi"

mkdir -p "$RUN_DIR" "$LOG_DIR"

backend_api_url() {
  printf 'http://%s:%s' "$BACKEND_HOST" "$BACKEND_PORT"
}

kg_platform_url() {
  printf 'http://%s:%s' "$KG_PLATFORM_HOST" "$KG_PLATFORM_PORT"
}

nebula_targets() {
  if [ -n "${NEBULA_HOSTS:-}" ]; then
    printf '%s\n' "$NEBULA_HOSTS"
    return
  fi
  printf '%s:%s\n' "${NEBULA_HOST:-127.0.0.1}" "${NEBULA_PORT:-9669}"
}

es_targets() {
  if [ -n "${ES_URLS:-}" ]; then
    printf '%s\n' "$ES_URLS"
    return
  fi
  printf '%s\n' "${ES_URL:-http://127.0.0.1:9200}"
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

warn() {
  echo "WARN: $*" >&2
}

info() {
  echo "[stack] $*"
}

ensure_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name not found in PATH"
}

is_pid_running() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
}

read_pid_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    return 1
  fi
  local pid
  pid="$(tr -d '[:space:]' < "$path")"
  if [ -z "$pid" ]; then
    return 1
  fi
  printf '%s\n' "$pid"
}

cleanup_stale_pid_file() {
  local path="$1"
  local pid
  pid="$(read_pid_file "$path" || true)"
  if [ -n "$pid" ] && ! is_pid_running "$pid"; then
    rm -f "$path"
  fi
}

find_backend_api_pids() {
  ps -eo pid=,comm=,args= | awk -v venv_python="$BACKEND_PYTHON_BIN" -v host="$BACKEND_HOST" -v port="$BACKEND_PORT" '
    ($2 == "python" || $2 == "python3") &&
    index($0, venv_python) &&
    index($0, "uvicorn app.main:app") &&
    index($0, "--host " host) &&
    index($0, "--port " port) {
      print $1
    }
  '
}

find_backend_worker_pids() {
  ps -eo pid=,comm=,args= | awk -v venv_python="$BACKEND_PYTHON_BIN" '
    ($2 == "python" || $2 == "python3") &&
    index($0, venv_python) &&
    index($0, "-m app.worker_main") {
      print $1
    }
  ' | awk '!seen[$0]++'
}

find_kg_platform_pids() {
  list_listening_pids "$KG_PLATFORM_PORT"
}

ensure_backend_ready() {
  ensure_command python3
  [ -x "$BACKEND_PYTHON_BIN" ] || fail "backend venv python not found: $BACKEND_PYTHON_BIN"
}

ensure_kg_platform_ready() {
  ensure_command node
  ensure_command pnpm
  [ -d "$ONEX_FRONTEND_ROOT" ] || fail "onex frontend root not found: $ONEX_FRONTEND_ROOT"
  [ -d "$KG_PLATFORM_APP_ROOT" ] || fail "kg-platform app root not found: $KG_PLATFORM_APP_ROOT"
  [ -x "$KG_PLATFORM_UMI_ENTRY" ] || fail "kg-platform umi entry not found: $KG_PLATFORM_UMI_ENTRY; run bash $ROOT/scripts/dev/bootstrap_env.sh"
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-30}"
  local sleep_sec="${3:-1}"
  local i
  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_sec"
  done
  return 1
}

is_port_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -lHtn "( sport = :$port )" 2>/dev/null | awk 'NF { found=1; exit } END { exit found ? 0 : 1 }'
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  return 1
}

list_listening_pids() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp "( sport = :$port )" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | awk '!seen[$0]++'
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk '!seen[$0]++'
    return
  fi
}

is_pid_listening_on_port() {
  local pid="$1"
  local port="$2"
  [ -n "$pid" ] || return 1
  list_listening_pids "$port" | grep -Fxq "$pid"
}

http_ok() {
  local url="$1"
  local max_time="${2:-3}"
  curl -fsS --max-time "$max_time" "$url" >/dev/null 2>&1
}

join_by() {
  local delimiter="$1"
  shift
  local result=""
  local item
  for item in "$@"; do
    [ -n "$item" ] || continue
    if [ -n "$result" ]; then
      result+="$delimiter"
    fi
    result+="$item"
  done
  printf '%s\n' "$result"
}

pid_list_contains() {
  local pid_list="$1"
  local pid="$2"
  [ -n "$pid" ] || return 1
  printf '%s\n' "$pid_list" | tr ' ' '\n' | awk 'NF' | grep -Fxq "$pid"
}

normalize_pid_list() {
  awk 'NF && !seen[$0]++'
}

ensure_port_available() {
  local port="$1"
  local service_name="$2"
  if ! is_port_listening "$port"; then
    return 0
  fi
  local pids
  pids="$(list_listening_pids "$port" | tr '\n' ' ' | xargs -r echo || true)"
  fail "$service_name port $port is already in use by pid(s): ${pids:-unknown}"
}

collect_service_state() {
  local pid_file="$1"
  local port="$2"
  local url="$3"
  local pid_finder="$4"
  local -n out="$5"

  local pid_file_present=0
  local pid=""
  local pid_running=0
  local matched_pids=""
  local process_detected=0
  local port_listening=0
  local http_reachable=0
  local status=""
  local detail=""
  local details=()

  [ -f "$pid_file" ] && pid_file_present=1
  pid="$(read_pid_file "$pid_file" || true)"
  if [ -n "$pid" ] && is_pid_running "$pid"; then
    pid_running=1
  fi

  matched_pids="$($pid_finder | normalize_pid_list | tr '\n' ' ' | xargs -r echo || true)"
  if [ "$pid_running" -eq 1 ] && ! pid_list_contains "$matched_pids" "$pid"; then
    matched_pids="$(printf '%s\n%s\n' "$pid" "$matched_pids" | normalize_pid_list | tr '\n' ' ' | xargs -r echo || true)"
  fi
  [ -n "$matched_pids" ] && process_detected=1

  if is_port_listening "$port"; then
    port_listening=1
  fi

  if http_ok "$url"; then
    http_reachable=1
  fi

  if [ "$pid_file_present" -eq 1 ] && [ -z "$pid" ]; then
    details+=("invalid_pidfile")
  fi
  if [ "$pid_file_present" -eq 1 ] && [ -n "$pid" ] && [ "$pid_running" -eq 0 ]; then
    details+=("stale_pidfile")
  fi
  if [ "$pid_file_present" -eq 0 ] && { [ "$process_detected" -eq 1 ] || [ "$port_listening" -eq 1 ] || [ "$http_reachable" -eq 1 ]; }; then
    details+=("pidfile_missing")
  fi
  if [ "$pid_running" -eq 0 ] && [ -n "$pid" ] && [ "$process_detected" -eq 1 ]; then
    details+=("pidfile_pid_not_owner")
  fi
  if [ "$process_detected" -eq 0 ] && [ "$port_listening" -eq 1 ]; then
    details+=("port_alive_pid_missing")
  fi
  if [ "$process_detected" -eq 0 ] && [ "$http_reachable" -eq 1 ]; then
    details+=("http_alive_pid_missing")
  fi
  if [ "$process_detected" -eq 1 ] && [ "$port_listening" -eq 0 ]; then
    details+=("pid_alive_port_closed")
  fi
  if [ "$port_listening" -eq 1 ] && [ "$http_reachable" -eq 0 ]; then
    details+=("port_alive_http_failed")
  fi

  if [ "$pid_file_present" -eq 1 ] && [ "$pid_running" -eq 0 ] && [ "$process_detected" -eq 0 ] && [ "$port_listening" -eq 0 ] && [ "$http_reachable" -eq 0 ]; then
    status="stale_pidfile"
  elif [ "$process_detected" -eq 0 ] && [ "$port_listening" -eq 0 ] && [ "$http_reachable" -eq 0 ]; then
    status="stopped"
  elif [ "$pid_file_present" -eq 1 ] && [ "$pid_running" -eq 1 ] && [ "$port_listening" -eq 1 ] && [ "$http_reachable" -eq 1 ]; then
    status="running"
  else
    status="degraded"
  fi

  detail="$(join_by "," "${details[@]}")"

  out=(
    [pid_file]="$pid_file"
    [pid_file_present]="$pid_file_present"
    [pid]="$pid"
    [pid_running]="$pid_running"
    [matched_pids]="$matched_pids"
    [process_detected]="$process_detected"
    [port]="$port"
    [port_listening]="$port_listening"
    [url]="$url"
    [http_reachable]="$http_reachable"
    [status]="$status"
    [detail]="$detail"
  )
}

collect_process_state() {
  local pid_file="$1"
  local pid_finder="$2"
  local -n out="$3"

  local pid_file_present=0
  local pid=""
  local pid_running=0
  local matched_pids=""
  local process_detected=0
  local status=""
  local detail=""
  local details=()

  [ -f "$pid_file" ] && pid_file_present=1
  pid="$(read_pid_file "$pid_file" || true)"
  if [ -n "$pid" ] && is_pid_running "$pid"; then
    pid_running=1
  fi

  matched_pids="$($pid_finder | normalize_pid_list | tr '\n' ' ' | xargs -r echo || true)"
  if [ "$pid_running" -eq 1 ] && ! pid_list_contains "$matched_pids" "$pid"; then
    matched_pids="$(printf '%s\n%s\n' "$pid" "$matched_pids" | normalize_pid_list | tr '\n' ' ' | xargs -r echo || true)"
  fi
  [ -n "$matched_pids" ] && process_detected=1

  if [ "$pid_file_present" -eq 1 ] && [ -z "$pid" ]; then
    details+=("invalid_pidfile")
  fi
  if [ "$pid_file_present" -eq 1 ] && [ -n "$pid" ] && [ "$pid_running" -eq 0 ]; then
    details+=("stale_pidfile")
  fi
  if [ "$pid_file_present" -eq 0 ] && [ "$process_detected" -eq 1 ]; then
    details+=("pidfile_missing")
  fi
  if [ "$pid_running" -eq 0 ] && [ -n "$pid" ] && [ "$process_detected" -eq 1 ]; then
    details+=("pidfile_pid_not_owner")
  fi
  if [ "$pid_running" -eq 1 ] && ! pid_list_contains "$matched_pids" "$pid"; then
    details+=("pid_alive_process_mismatch")
  fi

  if [ "$pid_file_present" -eq 1 ] && [ "$pid_running" -eq 0 ] && [ "$process_detected" -eq 0 ]; then
    status="stale_pidfile"
  elif [ "$process_detected" -eq 0 ]; then
    status="stopped"
  elif [ "$pid_file_present" -eq 1 ] && [ "$pid_running" -eq 1 ] && pid_list_contains "$matched_pids" "$pid"; then
    status="running"
  else
    status="degraded"
  fi

  detail="$(join_by "," "${details[@]}")"

  out=(
    [pid_file]="$pid_file"
    [pid_file_present]="$pid_file_present"
    [pid]="$pid"
    [pid_running]="$pid_running"
    [matched_pids]="$matched_pids"
    [process_detected]="$process_detected"
    [status]="$status"
    [detail]="$detail"
  )
}

wait_for_pid_service_ready() {
  local pid="$1"
  local port="$2"
  local url="$3"
  local attempts="${4:-30}"
  local sleep_sec="${5:-1}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if ! is_pid_running "$pid"; then
      return 1
    fi
    if is_pid_listening_on_port "$pid" "$port" && http_ok "$url"; then
      return 0
    fi
    sleep "$sleep_sec"
  done
  return 1
}

wait_for_service_ready() {
  local pid="$1"
  local port="$2"
  local url="$3"
  local attempts="${4:-30}"
  local sleep_sec="${5:-1}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if ! is_pid_running "$pid"; then
      return 1
    fi
    if is_port_listening "$port" && http_ok "$url"; then
      return 0
    fi
    sleep "$sleep_sec"
  done
  return 1
}

wait_for_process_stable() {
  local pid="$1"
  local attempts="${2:-10}"
  local sleep_sec="${3:-1}"
  local i
  for ((i = 1; i <= attempts; i += 1)); do
    if ! is_pid_running "$pid"; then
      return 1
    fi
    sleep "$sleep_sec"
  done
  return 0
}

service_has_runtime_activity() {
  local -n state_ref="$1"
  [ "${state_ref[process_detected]}" -eq 1 ] || [ "${state_ref[port_listening]}" -eq 1 ] || [ "${state_ref[http_reachable]}" -eq 1 ]
}

process_has_runtime_activity() {
  local -n state_ref="$1"
  [ "${state_ref[process_detected]}" -eq 1 ]
}

wait_for_service_shutdown() {
  local pid_file="$1"
  local port="$2"
  local url="$3"
  local pid_finder="$4"
  local attempts="${5:-20}"
  local sleep_sec="${6:-0.5}"
  local i
  local -A state=()

  for ((i = 1; i <= attempts; i += 1)); do
    collect_service_state "$pid_file" "$port" "$url" "$pid_finder" state
    if ! service_has_runtime_activity state; then
      return 0
    fi
    sleep "$sleep_sec"
  done

  return 1
}

wait_for_process_shutdown() {
  local pid_file="$1"
  local pid_finder="$2"
  local attempts="${3:-20}"
  local sleep_sec="${4:-0.5}"
  local i
  local -A state=()

  for ((i = 1; i <= attempts; i += 1)); do
    collect_process_state "$pid_file" "$pid_finder" state
    if ! process_has_runtime_activity state; then
      return 0
    fi
    sleep "$sleep_sec"
  done

  return 1
}

service_state_summary() {
  local -n state_ref="$1"
  local pidfile_display="missing"
  local pid_display="${state_ref[pid]:-missing}"
  local matched_display="${state_ref[matched_pids]:-none}"
  local port_display="closed"
  local http_display="fail"
  local summary=""

  if [ "${state_ref[pid_file_present]}" -eq 1 ]; then
    pidfile_display="present"
  fi
  if [ "${state_ref[port_listening]}" -eq 1 ]; then
    port_display="listening"
  fi
  if [ "${state_ref[http_reachable]}" -eq 1 ]; then
    http_display="ok"
  fi

  summary="$(printf 'status=%s pidfile=%s pid=%s pid_running=%s matched_pids=%s port=%s:%s http=%s url=%s' \
    "${state_ref[status]}" \
    "$pidfile_display" \
    "$pid_display" \
    "${state_ref[pid_running]}" \
    "$matched_display" \
    "${state_ref[port]}" \
    "$port_display" \
    "$http_display" \
    "${state_ref[url]}")"

  if [ -n "${state_ref[detail]}" ]; then
    summary="$summary detail=${state_ref[detail]}"
  fi

  printf '%s\n' "$summary"
}

process_state_summary() {
  local -n state_ref="$1"
  local pidfile_display="missing"
  local pid_display="${state_ref[pid]:-missing}"
  local matched_display="${state_ref[matched_pids]:-none}"
  local summary=""

  if [ "${state_ref[pid_file_present]}" -eq 1 ]; then
    pidfile_display="present"
  fi

  summary="$(printf 'status=%s pidfile=%s pid=%s pid_running=%s matched_pids=%s' \
    "${state_ref[status]}" \
    "$pidfile_display" \
    "$pid_display" \
    "${state_ref[pid_running]}" \
    "$matched_display")"

  if [ -n "${state_ref[detail]}" ]; then
    summary="$summary detail=${state_ref[detail]}"
  fi

  printf '%s\n' "$summary"
}

require_service_http() {
  local name="$1"
  local state_var_name="$2"
  local -n service_state_ref="$2"
  local hint="${3:-start with bash scripts/dev/start_stack.sh}"

  if [ "${service_state_ref[http_reachable]}" -eq 1 ]; then
    return 0
  fi

  fail "$name is not reachable; $(service_state_summary "$state_var_name"); $hint"
}

require_process_running() {
  local name="$1"
  local state_var_name="$2"
  local -n process_state_ref="$2"
  local hint="${3:-start with bash scripts/dev/start_stack.sh}"

  if [ "${process_state_ref[process_detected]}" -eq 1 ]; then
    return 0
  fi

  fail "$name is not running; $(process_state_summary "$state_var_name"); $hint"
}

stop_pid_gracefully() {
  local pid="$1"
  local name="$2"
  if ! is_pid_running "$pid"; then
    return 0
  fi
  kill "$pid" >/dev/null 2>&1 || true
  local i
  for ((i = 1; i <= 20; i += 1)); do
    if ! is_pid_running "$pid"; then
      return 0
    fi
    sleep 0.5
  done
  echo "force killing $name pid=$pid"
  kill -9 "$pid" >/dev/null 2>&1 || true
}

make_tmp_file() {
  mktemp "$RUN_DIR/stack.XXXXXX"
}

fetch_endpoint_to_file() {
  local url="$1"
  local output_file="$2"
  local max_time="${3:-8}"
  curl -sS --max-time "$max_time" -o "$output_file" -w '%{http_code}' "$url"
}

health_json_status() {
  local payload_file="$1"
  python3 - "$payload_file" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fp:
    payload = json.load(fp)
print(str(payload.get("status") or "unknown"))
PY
}

print_health_endpoint_report() {
  local endpoint_name="$1"
  local http_code="$2"
  local payload_file="$3"
  python3 - "$endpoint_name" "$http_code" "$payload_file" <<'PY'
import json
import sys

endpoint_name = sys.argv[1]
http_code = sys.argv[2]
payload_file = sys.argv[3]

with open(payload_file, "r", encoding="utf-8") as fp:
    payload = json.load(fp)

status = str(payload.get("status") or "unknown")
checks = payload.get("checks") or payload.get("dependencies") or {}
parts = []
for name in ("startup", "registry", "default_space", "current_space", "nebula", "elasticsearch", "space", "index"):
    component = checks.get(name)
    if not isinstance(component, dict):
        continue
    component_status = str(component.get("status") or "unknown")
    parts.append(f"{name}={component_status}")

suffix = ""
if parts:
    suffix = " components=" + ",".join(parts)

print(f"{endpoint_name}: http={http_code} status={status}{suffix}")
PY
}

dependencies_classification() {
  local payload_file="$1"
  python3 - "$payload_file" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fp:
    payload = json.load(fp)

deps = payload.get("dependencies") or {}

def comp(name):
    value = deps.get(name)
    return value if isinstance(value, dict) else {}

nebula = comp("nebula")
es = comp("elasticsearch")
space = comp("space")
index = comp("index")

nebula_status = str(nebula.get("status") or "unknown")
es_status = str(es.get("status") or "unknown")
space_status = str(space.get("status") or "unknown")
index_status = str(index.get("status") or "unknown")

if nebula_status == "down" or es_status == "down":
    print("dependency_connection_failed")
elif space_status in {"degraded", "down"} or index_status in {"degraded", "down"}:
    print("dependency_reachable_readiness_incomplete")
else:
    print("ok")
PY
}

print_dependencies_report() {
  local payload_file="$1"
  python3 - "$payload_file" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fp:
    payload = json.load(fp)

deps = payload.get("dependencies") or {}

def comp(name):
    value = deps.get(name)
    return value if isinstance(value, dict) else {}

def compact_component(name):
    item = comp(name)
    status = str(item.get("status") or "unknown")
    detail = str(item.get("detail") or "").strip()
    reason = str(item.get("reason") or "").strip()
    metadata = item.get("metadata") or {}
    segment = f"{name}={status}"
    if detail:
        segment += f" detail={detail}"
    if reason:
        segment += f" reason={reason}"
    if name == "index":
        current_space = metadata.get("current_space") or {}
        default_space = metadata.get("default_space") or {}
        current_search = current_space.get("search_status")
        default_search = default_space.get("search_status")
        current_index = current_space.get("index_status") or {}
        default_index = default_space.get("index_status") or {}
        current_index_status = current_index.get("status")
        default_index_status = default_index.get("status")
        extras = []
        if current_search is not None:
            extras.append(f"current_search={current_search}")
        if default_search is not None:
            extras.append(f"default_search={default_search}")
        if current_index_status is not None:
            extras.append(f"current_index={current_index_status}")
        if default_index_status is not None:
            extras.append(f"default_index={default_index_status}")
        if extras:
            segment += " " + " ".join(extras)
    print(f"dependencies: {segment}")

nebula = comp("nebula")
es = comp("elasticsearch")
space = comp("space")
index = comp("index")

nebula_status = str(nebula.get("status") or "unknown")
es_status = str(es.get("status") or "unknown")
space_status = str(space.get("status") or "unknown")
index_status = str(index.get("status") or "unknown")

if nebula_status == "down" or es_status == "down":
    print("dependencies: classification=dependency_connection_failed note=nebula_or_elasticsearch_unreachable")
elif space_status in {"degraded", "down"} or index_status in {"degraded", "down"}:
    print("dependencies: classification=dependency_reachable_readiness_incomplete note=space_or_index_not_fully_ready")
else:
    print("dependencies: classification=ok note=all_dependencies_green")

for name in ("nebula", "elasticsearch", "space", "index"):
    compact_component(name)
PY
}
