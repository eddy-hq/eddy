#!/usr/bin/env bash
# Self-healing watchdog. Run by launchd every 60s.
# Checks: Tailscale → SSH → eddy-worker.
# Notifies via ntfy on any corrective action or unrecoverable failure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
LOG_FILE="${SCRIPT_DIR}/../logs/watchdog.log"

if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

SSH_USER="${VIDEO_SSH_USER:-steveu}"
SSH_HOST="${VIDEO_SSH_HOST:-100.95.170.27}"
SSH_KEY="${VIDEO_SSH_KEY:-$HOME/.ssh/id_ed25519_eddy}"
SSH_KEY="${SSH_KEY/\~/$HOME}"
SSH_OPTS="-i ${SSH_KEY} -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

NTFY_URL="${NTFY_BASE_URL:-}"
NTFY_TOPIC="${NTFY_TOPIC_STEVE:-}"
NTFY_CREDS="${NTFY_CREDS_STEVE:-}"
TAILSCALE="/opt/homebrew/bin/tailscale"

log() {
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") [$1] ${*:2}" >> "$LOG_FILE"
}

notify() {
  local title="$1" body="$2"
  [[ -z "$NTFY_URL" || -z "$NTFY_TOPIC" ]] && return 0
  curl -sf --max-time 5 \
    -u "$NTFY_CREDS" \
    -H "Title: $title" \
    -H "Priority: high" \
    -d "$body" \
    "$NTFY_URL/$NTFY_TOPIC" > /dev/null 2>&1 || true
}

ts_state() {
  "$TAILSCALE" status --json 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('BackendState','unknown'))" 2>/dev/null \
    || echo "unknown"
}

# ── Tailscale ────────────────────────────────────────────────────────────────
STATE=$(ts_state)

if [[ "$STATE" == "NeedsLogin" ]]; then
  log "ERROR" "Tailscale needs login — cannot auto-recover"
  notify "Eddy watchdog — action needed" "Tailscale needs login. Run: tailscale login"
  exit 1
fi

if [[ "$STATE" != "Running" ]]; then
  log "WARN" "Tailscale state=${STATE}, attempting tailscale up"
  "$TAILSCALE" up 2>/dev/null || true
  sleep 6
  STATE=$(ts_state)
  if [[ "$STATE" == "Running" ]]; then
    log "INFO" "Tailscale recovered"
    notify "Eddy watchdog" "Tailscale reconnected automatically"
  else
    log "ERROR" "Tailscale still not running (state=${STATE})"
    notify "Eddy watchdog — action needed" "Tailscale is ${STATE} and could not auto-recover"
    exit 1
  fi
fi

# ── SSH connectivity ─────────────────────────────────────────────────────────
if ! ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" "exit 0" 2>/dev/null; then
  log "ERROR" "SSH to Ubuntu failed despite Tailscale being up"
  notify "Eddy watchdog — action needed" "Tailscale is up but SSH to Ubuntu failed — server may be down"
  exit 1
fi

# ── Eddy worker ──────────────────────────────────────────────────────────────
WORKER_STATE=$(ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" \
  "systemctl --user is-active eddy-worker 2>/dev/null" 2>/dev/null || echo "unknown")

if [[ "$WORKER_STATE" != "active" ]]; then
  log "WARN" "eddy-worker state=${WORKER_STATE}, restarting"
  ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" \
    "systemctl --user restart eddy-worker" 2>/dev/null || true
  sleep 5
  WORKER_STATE=$(ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" \
    "systemctl --user is-active eddy-worker 2>/dev/null" 2>/dev/null || echo "unknown")
  if [[ "$WORKER_STATE" == "active" ]]; then
    log "INFO" "eddy-worker recovered"
    notify "Eddy watchdog" "Download worker was down — restarted and active"
  else
    log "ERROR" "eddy-worker still not active (state=${WORKER_STATE})"
    notify "Eddy watchdog — action needed" "Download worker restart failed (state: ${WORKER_STATE})"
  fi
fi

log "INFO" "watchdog run complete"
