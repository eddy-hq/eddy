#!/usr/bin/env bash
# Self-healing watchdog. Long-running daemon launched by launchd
# (KeepAlive=true). Runs checks every INTERVAL seconds in an internal
# loop — launchd's StartInterval was coalesced unreliably on macOS.
# Checks: M4 Express /health → Tailscale → SSH → eddy-worker.
# Records an ALERT line on any corrective action or unrecoverable failure.
# Log-only: there is no delivery channel until APNs ships with the iOS shell.
set -uo pipefail

INTERVAL="${WATCHDOG_INTERVAL:-60}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
LOG_FILE="${SCRIPT_DIR}/../logs/watchdog.log"
DIAG_DIR="${SCRIPT_DIR}/../logs/watchdog-diag"

if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

# SSH user/host/identity come from the operator's ~/.ssh/config under the
# `eddy-mediaserver` Host alias.
SSH_TARGET="eddy-mediaserver"
SSH_OPTS="-o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

TAILSCALE="/usr/local/bin/tailscale"

log() {
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ") [$1] ${*:2}" >> "$LOG_FILE"
}

# Log-only notification. Kept as a separate level (ALERT) from the ordinary
# WARN/ERROR lines so the things that would have been pushed are greppable:
#   grep ALERT logs/watchdog.log
notify() {
  local title="$1" body="$2"
  log "ALERT" "${title}: ${body}"
}

ts_state() {
  "$TAILSCALE" status --json 2>/dev/null \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('BackendState','unknown'))" 2>/dev/null \
    || echo "unknown"
}

capture_diag() {
  local reason="$1"
  mkdir -p "$DIAG_DIR" 2>/dev/null || return 0
  local ts; ts="$(date -u +"%Y%m%dT%H%M%SZ")"
  local file="${DIAG_DIR}/${ts}-${reason}.log"
  {
    echo "=== watchdog diag: ${reason} @ ${ts} ==="
    echo
    echo "--- tailscale status --json ---"
    "$TAILSCALE" status --json 2>&1 || true
    echo
    echo "--- tailscale netcheck ---"
    "$TAILSCALE" netcheck 2>&1 || true
    echo
    echo "--- pmset -g assertions ---"
    pmset -g assertions 2>&1 | head -80 || true
    echo
    echo "--- pmset -g ---"
    pmset -g 2>&1 || true
    echo
    echo "--- sleep/wake events (last 60, filtered) ---"
    pmset -g log 2>/dev/null \
      | grep -Ei 'sleep|wake|darkwake|assertion|display' \
      | tail -60 || true
  } > "$file" 2>&1
  log "INFO" "diag captured → $(basename "$file")"
  # Keep only the most recent 20 diag files.
  /bin/ls -t "$DIAG_DIR"/*.log 2>/dev/null | tail -n +21 | xargs rm -f 2>/dev/null || true
}

# Run all checks once. Uses a subshell so any `exit` inside a stage only
# aborts this iteration — the outer daemon loop keeps running.
IOS_EXPIRY_FILE="${IOS_DIST_PATH:-$HOME/data/eddy/ios}/profile-expiry"
IOS_EXPIRY_STAMP="${SCRIPT_DIR}/../logs/.ios-expiry-alerted"
IOS_EXPIRY_WARN_DAYS=30

check_ios_profile_expiry() {
  [[ -f "$IOS_EXPIRY_FILE" ]] || return 0
  local expiry expiry_epoch days_left today
  expiry="$(head -1 "$IOS_EXPIRY_FILE")"
  expiry_epoch="$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$expiry" +%s 2>/dev/null)" || {
    log "WARN" "iOS profile expiry unreadable: ${IOS_EXPIRY_FILE}"
    return 0
  }
  days_left=$(( (expiry_epoch - $(date -u +%s)) / 86400 ))
  (( days_left <= IOS_EXPIRY_WARN_DAYS )) || return 0

  today="$(date -u +%Y-%m-%d)"
  [[ "$(cat "$IOS_EXPIRY_STAMP" 2>/dev/null)" == "$today" ]] && return 0
  echo "$today" > "$IOS_EXPIRY_STAMP"

  if (( days_left < 0 )); then
    notify "Eddy watchdog — action needed" "iOS provisioning profile has expired — the app will not launch. Run ios/scripts/release-adhoc.sh and reinstall"
  else
    notify "Eddy watchdog — action needed" "iOS provisioning profile expires in ${days_left} days. Run ios/scripts/release-adhoc.sh and reinstall"
  fi
}

run_checks() (
  # ── M4 Express server ──────────────────────────────────────────────────────
  # Local check, independent of Tailscale/SSH. launchd's KeepAlive is the
  # primary recovery mechanism; this is defence-in-depth and the notification
  # path.
  PORT="${PORT:-3737}"
  if ! curl -sf --max-time 5 "http://localhost:${PORT}/health" > /dev/null 2>&1; then
    log "WARN" "M4 Express /health not responding, kickstarting com.eddy.server"
    launchctl kickstart -k "gui/$(id -u)/com.eddy.server" 2>/dev/null || true
    sleep 8
    if curl -sf --max-time 5 "http://localhost:${PORT}/health" > /dev/null 2>&1; then
      log "INFO" "M4 Express server recovered"
      notify "Eddy watchdog" "Express server was down — kickstarted and healthy"
    else
      log "ERROR" "M4 Express server still not responding after kickstart"
      notify "Eddy watchdog — action needed" "Express server down, kickstart did not recover it"
    fi
  fi

  # ── iOS provisioning profile ───────────────────────────────────────────────
  # Ad hoc profiles last a year and the app stops launching the day one
  # lapses. ios/scripts/release-adhoc.sh records the expiry; say so once a day
  # from 30 days out. Here rather than last because the checks below exit
  # early when the tailnet is down.
  check_ios_profile_expiry

  # ── Tailscale ──────────────────────────────────────────────────────────────
  STATE=$(ts_state)

  if [[ "$STATE" == "NeedsLogin" ]]; then
    log "ERROR" "Tailscale needs login — cannot auto-recover"
    notify "Eddy watchdog — action needed" "Tailscale needs login. Run: tailscale login"
    exit 1
  fi

  if [[ "$STATE" != "Running" ]]; then
    log "WARN" "Tailscale state=${STATE}, attempting tailscale up"
    capture_diag "ts-${STATE}"
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

  # ── SSH connectivity ───────────────────────────────────────────────────────
  if ! ssh $SSH_OPTS "${SSH_TARGET}" "exit 0" 2>/dev/null; then
    log "ERROR" "SSH to Ubuntu failed despite Tailscale being up"
    notify "Eddy watchdog — action needed" "Tailscale is up but SSH to Ubuntu failed — server may be down"
    exit 1
  fi

  # ── Eddy worker ────────────────────────────────────────────────────────────
  WORKER_STATE=$(ssh $SSH_OPTS "${SSH_TARGET}" \
    "systemctl --user is-active eddy-worker 2>/dev/null" 2>/dev/null || echo "unknown")

  if [[ "$WORKER_STATE" != "active" ]]; then
    log "WARN" "eddy-worker state=${WORKER_STATE}, restarting"
    ssh $SSH_OPTS "${SSH_TARGET}" \
      "systemctl --user restart eddy-worker" 2>/dev/null || true
    sleep 5
    WORKER_STATE=$(ssh $SSH_OPTS "${SSH_TARGET}" \
      "systemctl --user is-active eddy-worker 2>/dev/null" 2>/dev/null || echo "unknown")
    if [[ "$WORKER_STATE" == "active" ]]; then
      log "INFO" "eddy-worker recovered"
      notify "Eddy watchdog" "Download worker was down — restarted and active"
    else
      log "ERROR" "eddy-worker still not active (state=${WORKER_STATE})"
      notify "Eddy watchdog — action needed" "Download worker restart failed (state: ${WORKER_STATE})"
    fi
  fi
)

# Exit cleanly on SIGTERM/SIGINT so launchd sees a normal stop.
trap 'log "INFO" "watchdog exiting on signal"; exit 0' TERM INT

log "INFO" "watchdog daemon starting (interval=${INTERVAL}s)"
while true; do
  run_checks || true
  log "DEBUG" "tick"
  # Background sleep + wait so signals interrupt the sleep immediately
  # instead of waiting up to INTERVAL seconds.
  sleep "$INTERVAL" &
  wait $!
done
