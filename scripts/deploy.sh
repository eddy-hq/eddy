#!/usr/bin/env bash
# Deploy Eddy: push to GitHub, update Ubuntu worker, optionally restart M4 server.
#
# Ubuntu only runs the BullMQ worker — no build step needed there.
# The M4 server restart builds (tsc + vite) locally before relaunching.
#
# Usage:
#   deploy.sh              — push + deploy Ubuntu worker
#   deploy.sh --server     — also build + restart the M4 Express server
#   deploy.sh --server-only — build + restart M4 server without touching Ubuntu
#   deploy.sh --full       — push + Ubuntu deploy + M4 server restart
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

SSH_USER="${VIDEO_SSH_USER:-steveu}"
SSH_HOST="${VIDEO_SSH_HOST:-100.95.170.27}"
SSH_KEY="${VIDEO_SSH_KEY:-$HOME/.ssh/id_ed25519_eddy}"
SSH_KEY="${SSH_KEY/\~/$HOME}"
SSH_OPTS="-i ${SSH_KEY} -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; RESET='\033[0m'; BOLD='\033[1m'
info()  { printf "${GREEN}▶ %s${RESET}\n" "$*"; }
warn()  { printf "${YELLOW}! %s${RESET}\n" "$*"; }
ok()    { printf "${GREEN}✓ %s${RESET}\n" "$*"; }
fail()  { printf "${RED}✗ %s${RESET}\n" "$*"; exit 1; }
step()  { printf "\n${BOLD}%s${RESET}\n" "$*"; }

DO_UBUNTU=true
DO_SERVER=false

for arg in "$@"; do
  case "$arg" in
    --server)      DO_SERVER=true ;;
    --server-only) DO_UBUNTU=false; DO_SERVER=true ;;
    --full)        DO_SERVER=true ;;
    *) warn "Unknown flag: $arg"; exit 1 ;;
  esac
done

echo ""
printf "${BOLD}Eddy deploy${RESET}\n"
echo "────────────────────────────────────────"

# ── Git push ─────────────────────────────────────────────────────────────────
if [[ "$DO_UBUNTU" == true ]]; then
  step "1/3  Git push"
  BRANCH=$(git -C "$SCRIPT_DIR/.." rev-parse --abbrev-ref HEAD)
  if ! git -C "$SCRIPT_DIR/.." diff --quiet || ! git -C "$SCRIPT_DIR/.." diff --cached --quiet; then
    warn "You have uncommitted changes — committing before pushing is recommended"
  fi
  git -C "$SCRIPT_DIR/.." push origin "$BRANCH"
  LOCAL_SHA=$(git -C "$SCRIPT_DIR/.." rev-parse HEAD)
  ok "Pushed $BRANCH (${LOCAL_SHA:0:7})"
fi

# ── Ubuntu worker deploy ──────────────────────────────────────────────────────
if [[ "$DO_UBUNTU" == true ]]; then
  step "2/3  Ubuntu worker"

  UBUNTU_SHA=$(ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" \
    "git -C ~/eddy rev-parse HEAD 2>/dev/null" || echo "unknown")

  if [[ "$UBUNTU_SHA" == "$LOCAL_SHA" ]]; then
    warn "Ubuntu already at ${LOCAL_SHA:0:7} — forcing redeploy anyway"
  else
    info "Ubuntu at ${UBUNTU_SHA:0:7} → deploying ${LOCAL_SHA:0:7}"
  fi

  ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" "
    set -euo pipefail
    cd ~/eddy
    git pull --ff-only origin
    npm ci --omit=dev
    systemctl --user restart eddy-worker
    sleep 2
    systemctl --user is-active eddy-worker
  "
  ok "Worker deployed and active"
fi

# ── M4 server restart ─────────────────────────────────────────────────────────
if [[ "$DO_SERVER" == true ]]; then
  STEP_NUM=$([[ "$DO_UBUNTU" == true ]] && echo "3/3" || echo "1/1")
  step "${STEP_NUM}  M4 server restart"
  info "Building…"
  npm --prefix "$SCRIPT_DIR/.." run build
  ok "Build complete"
  launchctl kickstart -k "gui/$(id -u)/com.eddy.server"
  sleep 3
  PORT="${PORT:-3737}"
  if curl -sf --max-time 5 "http://localhost:${PORT}/health" > /dev/null 2>&1; then
    ok "Server restarted and healthy (port ${PORT})"
  else
    warn "Server restarted but /health not responding yet (may still be starting)"
  fi
fi

echo ""
echo "────────────────────────────────────────"
printf "${GREEN}${BOLD}Deploy complete${RESET}\n\n"
