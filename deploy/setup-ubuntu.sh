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

# ── 2. Environment ────────────────────────────────────────────────────────────
ENV_FILE="${REPO_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  warn ".env not found at ${ENV_FILE} — copy .env.example and fill in values first"
  exit 1
fi
set -a; source "${ENV_FILE}"; set +a
check ".env loaded"

# ── 3. nginx ──────────────────────────────────────────────────────────────────
# Serves videos + thumbs over HTTP :80 on the tailnet. Nothing here needs TLS:
# the PWA reaches Eddy through Caddy on the M4, which rewrites media URLs.
info "nginx"

if ! command -v nginx &>/dev/null; then
  info "Installing nginx"
  sudo apt-get update -qq && sudo apt-get install -y nginx
fi

sudo cp "${DEPLOY_DIR}/nginx/eddy-videos.conf" /etc/nginx/sites-available/eddy-videos
if [[ ! -L /etc/nginx/sites-enabled/eddy-videos ]]; then
  sudo ln -s /etc/nginx/sites-available/eddy-videos /etc/nginx/sites-enabled/eddy-videos
fi

# Remove default site if it conflicts on port 80
if [[ -L /etc/nginx/sites-enabled/default ]]; then
  sudo rm /etc/nginx/sites-enabled/default
  warn "Removed nginx default site (was on port 80)"
fi

sudo nginx -t
sudo systemctl enable nginx
sudo systemctl reload nginx
check "nginx configured and running (HTTP :80 videos)"

# ── 4. Eddy worker systemd service ───────────────────────────────────────────
info "Eddy worker systemd service"

# Resolve Node bin dir — prefer nvm's latest installed version, fall back to PATH
NODE_BIN_DIR="$(ls -d ~/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
if [[ -z "${NODE_BIN_DIR}" || ! -x "${NODE_BIN_DIR}/node" ]]; then
  NODE_BIN_DIR="$(dirname "$(command -v node 2>/dev/null || true)")"
fi
if [[ -z "${NODE_BIN_DIR}" || ! -x "${NODE_BIN_DIR}/node" ]]; then
  warn "node not found — install Node LTS first (nvm recommended)"
  exit 1
fi
check "Node found at ${NODE_BIN_DIR}/node"

TSX_PATH="${REPO_DIR}/node_modules/.bin/tsx"
if [[ ! -x "${TSX_PATH}" ]]; then
  warn "tsx not found at ${TSX_PATH} — run: npm install (in ${REPO_DIR})"
  exit 1
fi

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
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${USER}
WorkingDirectory=${REPO_DIR}
Environment=PATH=${NODE_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=YTDLP_BIN=${YTDLP_PATH}
ExecStart=${NODE_BIN_DIR}/node ${REPO_DIR}/dist/workers/download.js
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

# ── 5. bgutil PO-token server ─────────────────────────────────────────────────
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
echo "  1. Install the iOS Shortcut on kids' devices (see docs/shortcut.md)"
echo "  2. Run: npm run health  (from M4)"
echo ""
