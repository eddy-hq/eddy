#!/usr/bin/env bash
# Eddy Ubuntu setup — run once on the media server as steveu.
# Idempotent: safe to re-run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${REPO_DIR}/deploy"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RESET='\033[0m'; BOLD='\033[1m'
info()  { printf "${GREEN}▶ %s${RESET}\n" "$*"; }
warn()  { printf "${YELLOW}! %s${RESET}\n" "$*"; }
check() { printf "${GREEN}✓ %s${RESET}\n" "$*"; }

echo ""
printf "${BOLD}Eddy — Ubuntu setup${RESET}\n"
echo "──────────────────────────────────────────"

# ── 1. Video directory ────────────────────────────────────────────────────────
info "Video directory"
VIDEO_PATH="/mnt/ssd/eddy/videos"
sudo mkdir -p "${VIDEO_PATH}"
sudo chown -R "${USER}:${USER}" "/mnt/ssd/eddy"
check "Video path ready: ${VIDEO_PATH}"

# ── 2. Docker services (Redis + ntfy) ────────────────────────────────────────
info "Docker services"

if ! command -v docker &>/dev/null; then
  warn "Docker not found — install it first: https://docs.docker.com/engine/install/ubuntu/"
  exit 1
fi

# Copy ntfy config into place alongside docker-compose
mkdir -p "${DEPLOY_DIR}/ntfy"
cp -n "${DEPLOY_DIR}/ntfy/server.yml" "${DEPLOY_DIR}/ntfy/server.yml" 2>/dev/null || true

# Stop and remove any containers started outside of compose so compose can own them
for container in eddy-redis eddy-ntfy; do
  if docker ps -a --format '{{.Names}}' | grep -q "^${container}$"; then
    docker rm -f "${container}" > /dev/null
  fi
done

docker compose -f "${DEPLOY_DIR}/docker-compose.ubuntu.yml" up -d
check "Redis + ntfy containers running"

# ── 3. ntfy users and topics ─────────────────────────────────────────────────
info "ntfy users"

# Load .env for topic/credential values
ENV_FILE="${REPO_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  warn ".env not found at ${ENV_FILE} — copy .env.example and fill in values first"
  exit 1
fi
set -a; source "${ENV_FILE}"; set +a

# Wait for ntfy to be ready
for i in {1..10}; do
  if docker exec eddy-ntfy wget -qO- http://localhost:80/v1/health &>/dev/null; then
    break
  fi
  sleep 2
done

create_ntfy_user() {
  local user="$1" pass="$2" topic="$3"
  # Add user (pipe password twice for the prompt + confirm)
  # If user already exists ntfy exits non-zero — handle with change-pass instead
  if ! printf '%s\n%s\n' "${pass}" "${pass}" | docker exec -i eddy-ntfy ntfy user add --role=user "${user}" 2>/dev/null; then
    printf '%s\n%s\n' "${pass}" "${pass}" | docker exec -i eddy-ntfy ntfy user change-pass "${user}"
  fi
  # Reset all topic permissions for this user then grant only their current topic
  docker exec eddy-ntfy ntfy access --reset "${user}" 2>/dev/null || true
  docker exec eddy-ntfy ntfy access "${user}" "${topic}" rw
  check "ntfy user: ${user} → ${topic}"
}

# Parse "user:pass" from NTFY_CREDS_* vars
parse_creds() { echo "${1%%:*}"; }
parse_pass()  { echo "${1#*:}"; }

for var_prefix in STEVE BOY1 BOY2; do
  creds_var="NTFY_CREDS_${var_prefix}"
  topic_var="NTFY_TOPIC_${var_prefix}"
  creds="${!creds_var:-}"
  topic="${!topic_var:-}"
  if [[ -z "$creds" || -z "$topic" ]]; then
    warn "${creds_var} or ${topic_var} not set in .env — skipping"
    continue
  fi
  create_ntfy_user "$(parse_creds "$creds")" "$(parse_pass "$creds")" "$topic"
done

# ── 4. Tailscale cert (for ntfy HTTPS) ───────────────────────────────────────
info "Tailscale TLS cert"

NTFY_HOSTNAME="mediaserver.tail1b6462.ts.net"
SSL_DIR="/etc/ssl/eddy"
sudo mkdir -p "${SSL_DIR}"
sudo tailscale cert \
  --cert-file "${SSL_DIR}/ntfy.crt" \
  --key-file  "${SSL_DIR}/ntfy.key" \
  "${NTFY_HOSTNAME}"
# nginx needs to read the key
sudo chmod 640 "${SSL_DIR}/ntfy.key"
sudo chgrp www-data "${SSL_DIR}/ntfy.key"
check "Tailscale cert written to ${SSL_DIR}"

# ── 5. nginx ──────────────────────────────────────────────────────────────────
info "nginx"

if ! command -v nginx &>/dev/null; then
  info "Installing nginx"
  sudo apt-get update -qq && sudo apt-get install -y nginx
fi

for conf in eddy-videos eddy-ntfy; do
  sudo cp "${DEPLOY_DIR}/nginx/${conf}.conf" "/etc/nginx/sites-available/${conf}"
  if [[ ! -L "/etc/nginx/sites-enabled/${conf}" ]]; then
    sudo ln -s "/etc/nginx/sites-available/${conf}" "/etc/nginx/sites-enabled/${conf}"
  fi
done

# Remove default site if it conflicts on port 80
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  sudo rm /etc/nginx/sites-enabled/default
  warn "Removed nginx default site (was on port 80)"
fi

sudo nginx -t
sudo systemctl enable nginx
sudo systemctl reload nginx
check "nginx configured and running (HTTP :80 videos, HTTPS :443 ntfy)"

# ── 6. Eddy worker systemd service ───────────────────────────────────────────
info "Eddy worker systemd service"

# Resolve npm path — nvm init lives in .bashrc (not login shell), so source it explicitly
NPM_PATH="$(bash -c '. ~/.bashrc 2>/dev/null; which npm 2>/dev/null' || \
           ls ~/.nvm/versions/node/*/bin/npm 2>/dev/null | sort -V | tail -1 || \
           command -v npm 2>/dev/null || true)"
if [[ -z "${NPM_PATH}" ]]; then
  warn "npm not found — install Node LTS first (nvm recommended)"
  exit 1
fi
TSX_PATH="${REPO_DIR}/node_modules/.bin/tsx"
if [[ ! -x "${TSX_PATH}" ]]; then
  warn "tsx not found at ${TSX_PATH} — run: npm install (in ${REPO_DIR})"
  exit 1
fi

# Node bin dir (nvm) — needed so tsx can find node at runtime
NODE_BIN_DIR="$(dirname "${NPM_PATH}")"

# yt-dlp — pip installs to ~/.local/bin which systemd doesn't include in PATH
YTDLP_PATH="$(command -v yt-dlp 2>/dev/null || echo "${HOME}/.local/bin/yt-dlp")"
if [[ ! -x "${YTDLP_PATH}" ]]; then
  warn "yt-dlp not found — install with: pip install yt-dlp"
  exit 1
fi
check "yt-dlp found at ${YTDLP_PATH}"

# Write the service file directly with all paths resolved
sudo tee /etc/systemd/system/eddy-worker.service > /dev/null <<EOF
[Unit]
Description=Eddy download worker
After=network.target docker.service
Wants=docker.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=${USER}
WorkingDirectory=${REPO_DIR}
Environment=PATH=${NODE_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=YTDLP_BIN=${YTDLP_PATH}
ExecStartPre=/bin/bash -c 'until docker exec eddy-redis redis-cli ping 2>/dev/null | grep -q PONG; do sleep 2; done'
ExecStart=${TSX_PATH} ${REPO_DIR}/src/workers/download.ts
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=eddy-worker
EnvironmentFile=${REPO_DIR}/.env

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable eddy-worker
sudo systemctl restart eddy-worker
check "eddy-worker service enabled and started"

# ── 7. bgutil PO-token server ─────────────────────────────────────────────────
info "bgutil PO-token server"
BGUTIL_SERVICE="${DEPLOY_DIR}/bgutil-pot-server.service"
if [[ ! -f "${BGUTIL_SERVICE}" ]]; then
  warn "bgutil-pot-server.service not found at ${BGUTIL_SERVICE} — skipping"
else
  sudo cp "${BGUTIL_SERVICE}" /etc/systemd/system/bgutil-pot-server.service
  sudo systemctl daemon-reload
  sudo systemctl enable bgutil-pot-server
  sudo systemctl restart bgutil-pot-server
  check "bgutil-pot-server enabled and started"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "──────────────────────────────────────────"
printf "${GREEN}${BOLD}Ubuntu setup complete.${RESET}\n"
echo ""
echo "Next steps:"
echo "  1. Install ntfy iOS app on each device"
echo "     Server: http://\${TAILSCALE_IP:-100.95.170.27}:2586"
echo "     Subscribe to each user's topic with their credentials"
echo "  2. Install the iOS Shortcut on kids' devices (see docs/shortcut.md)"
echo "  3. Run: npm run health  (from M4)"
echo ""
