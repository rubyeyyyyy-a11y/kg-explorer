#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

info "repo_root=$ROOT"
info "onex_frontend_root=$ONEX_FRONTEND_ROOT"
info "kg_platform_app_root=$KG_PLATFORM_APP_ROOT"

ensure_command python3
ensure_command node
ensure_command pnpm

cd "$ROOT/backend"
if [ ! -d ".venv" ]; then
  info "creating backend/.venv"
  python3 -m venv .venv
fi

info "installing backend dependencies"
"$BACKEND_PYTHON_BIN" -m pip install --upgrade pip
"$BACKEND_PYTHON_BIN" -m pip install -r requirements.txt

cd "$ONEX_FRONTEND_ROOT"
info "installing onex-frontend workspace dependencies with pnpm"
pnpm install

info "done"
info "backend python=$BACKEND_PYTHON_BIN"
info "kg-platform umi entry=$KG_PLATFORM_UMI_ENTRY"
