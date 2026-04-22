#!/usr/bin/env bash
# Eddy service health check. Prints green/red for each service layer.
# Exit code 0 = all required services healthy. Exit code 1 = something is down.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
RESET='\033[0m'
BOLD='\033[1m'

PASS="${GREEN}✓${RESET}"
FAIL="${RED}✗${RESET}"
SKIP="${YELLOW}–${RESET}"

failures=0

check() {
  local label="$1"
  local result="$2"   # "ok" | "fail" | "skip"
  local detail="${3:-}"
  if [[ "$result" == "ok" ]]; then
    printf "  ${PASS} ${label}"
  elif [[ "$result" == "skip" ]]; then
    printf "  ${SKIP} ${label}"
  else
    printf "  ${FAIL} ${label}"
    failures=$((failures + 1))
  fi
  [[ -n "$detail" ]] && printf " ${YELLOW}(${detail})${RESET}"
  printf "\n"
}

echo ""
printf "${BOLD}Eddy Health Check${RESET}\n"
echo "────────────────────────────────────────"

# ── M4 local services ────────────────────────────────────────────────────────
printf "\n${BOLD}M4 — Local services${RESET}\n"

# Ollama
if curl -sf --max-time 3 "${OLLAMA_URL:-http://localhost:11434}/api/tags" > /dev/null 2>&1; then
  check "Ollama" "ok"
else
  check "Ollama" "fail" "is Ollama running?"
fi

# Guard model
GUARD_MODEL="${OLLAMA_GUARD_MODEL:-gemma4:e4b}"
if curl -sf --max-time 3 "${OLLAMA_URL:-http://localhost:11434}/api/tags" 2>/dev/null \
    | python3 -c "import json,sys; m=json.load(sys.stdin)['models']; exit(0 if any('${GUARD_MODEL%:*}' in x['name'] for x in m) else 1)" 2>/dev/null; then
  check "Guard model (${GUARD_MODEL})" "ok"
else
  check "Guard model (${GUARD_MODEL})" "fail" "run: ollama pull ${GUARD_MODEL}"
fi

# Eddy server
PORT="${PORT:-3737}"
if curl -sf --max-time 3 "http://localhost:${PORT}/health" > /dev/null 2>&1; then
  check "Eddy server (port ${PORT})" "ok"
else
  check "Eddy server (port ${PORT})" "skip" "not running (start with: npm run dev)"
fi

# Redis — local, managed by Homebrew launchd
if redis-cli -u "${REDIS_URL:-redis://localhost:6379}" ping 2>/dev/null | grep -q PONG; then
  check "Redis" "ok"
else
  check "Redis" "fail" "run: brew services start redis"
fi

# ── Ubuntu services ──────────────────────────────────────────────────────────
printf "\n${BOLD}Ubuntu — Media server${RESET}\n"

SSH_USER="${VIDEO_SSH_USER:-steveu}"
SSH_HOST="${VIDEO_SSH_HOST:-100.95.170.27}"
SSH_KEY="${VIDEO_SSH_KEY:-$HOME/.ssh/id_ed25519_eddy}"
SSH_KEY="${SSH_KEY/\~/$HOME}"
SSH_OPTS="-i ${SSH_KEY} -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

# SSH connectivity
if ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" "exit 0" 2>/dev/null; then
  check "SSH to Ubuntu" "ok"
  SSH_OK=true
else
  check "SSH to Ubuntu" "fail" "check ~/.ssh/id_ed25519_eddy"
  SSH_OK=false
fi

if [[ "$SSH_OK" == true ]]; then
  # yt-dlp — non-interactive SSH won't load .profile, so check common paths
  YTDLP_VER=$(ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" \
    "for p in /usr/local/bin/yt-dlp \$HOME/.local/bin/yt-dlp; do [ -x \"\$p\" ] && \$p --version 2>/dev/null && break; done" \
    2>/dev/null || echo "")
  if [[ -n "$YTDLP_VER" ]]; then
    check "yt-dlp" "ok" "${YTDLP_VER}"
  else
    check "yt-dlp" "fail" "not found at /usr/local/bin or ~/.local/bin (on Ubuntu)"
  fi

  # Video path
  REMOTE_PATH="${VIDEO_OUTPUT_PATH:-/home/steveu/eddy/videos}"
  if ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" "test -w '${REMOTE_PATH}'" 2>/dev/null; then
    check "Video path (${REMOTE_PATH})" "ok"
  else
    check "Video path (${REMOTE_PATH})" "fail" "path missing or not writable"
  fi

  # ntfy
  NTFY_URL="${NTFY_BASE_URL:-http://100.95.170.27:2586}"
  if docker exec eddy-ntfy wget -qO- http://localhost:80/v1/health &>/dev/null 2>/dev/null ||
     ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" "docker exec eddy-ntfy wget -qO- http://localhost:80/v1/health > /dev/null 2>&1" 2>/dev/null; then
    check "ntfy" "ok"
  else
    check "ntfy" "fail" "run: deploy/setup-ubuntu.sh"
  fi

  # nginx — a 200, 403 (no listing) or 404 from the host all confirm nginx is up
  NGINX_URL="${NGINX_VIDEO_BASE_URL:-http://100.95.170.27/videos}"
  NGINX_HOST=$(echo "$NGINX_URL" | python3 -c "import sys; from urllib.parse import urlparse; u=urlparse(sys.stdin.read().strip()); print(f'{u.scheme}://{u.netloc}')")
  NGINX_STATUS=$(ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" \
    "curl -s -o /dev/null -w '%{http_code}' --max-time 3 '${NGINX_HOST}/videos/' 2>/dev/null" 2>/dev/null || echo "")
  if echo "${NGINX_STATUS}" | grep -qE '^(200|403|404)$'; then
    check "nginx" "ok"
  else
    check "nginx" "fail" "run: deploy/setup-ubuntu.sh"
  fi

  # Eddy worker systemd service (user-level)
  WORKER_STATE=$(ssh $SSH_OPTS "${SSH_USER}@${SSH_HOST}" \
    "systemctl --user is-active eddy-worker 2>/dev/null" 2>/dev/null || echo "unknown")
  if [[ "${WORKER_STATE}" == "active" ]]; then
    check "Eddy worker (systemd)" "ok"
  else
    check "Eddy worker (systemd)" "fail" "run: deploy/setup-ubuntu.sh (state: ${WORKER_STATE})"
  fi

  # Plex
  PLEX_URL_VAR="${PLEX_URL:-http://100.95.170.27:32400}"
  PLEX_TOKEN_VAR="${PLEX_TOKEN:-}"
  if [[ -n "$PLEX_TOKEN_VAR" ]] && curl -sf --max-time 5 "${PLEX_URL_VAR}/library/sections?X-Plex-Token=${PLEX_TOKEN_VAR}" > /dev/null 2>&1; then
    check "Plex API" "ok"
  else
    check "Plex API" "fail" "check PLEX_URL / PLEX_TOKEN in .env"
  fi
else
  check "yt-dlp" "skip" "SSH unavailable"
  check "Video path" "skip" "SSH unavailable"
  check "ntfy" "skip" "SSH unavailable"
  check "nginx" "skip" "SSH unavailable"
  check "Eddy worker (systemd)" "skip" "SSH unavailable"
  check "Plex API" "skip" "SSH unavailable"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────"
if [[ $failures -eq 0 ]]; then
  printf "${GREEN}${BOLD}All checks passed${RESET}\n\n"
  exit 0
else
  printf "${RED}${BOLD}${failures} check(s) failed${RESET}\n\n"
  exit 1
fi
