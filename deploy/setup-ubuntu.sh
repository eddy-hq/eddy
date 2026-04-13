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
mkdir -p "${VIDEO_PATH}"
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
  # Create user (ignore error if already exists)
  docker exec eddy-ntfy ntfy user add --role=user "${user}" 2>/dev/null || true
  docker exec eddy-ntfy ntfy user change-pass "${user}" <<< "${pass}"$'\n'"${pass}" 2>/dev/null || true
  # Grant read+write on their own topic only
  docker exec eddy-ntfy ntfy access "${user}" "${topic}" rw 2>/dev/null || true
  check "ntfy user: ${user} → ${topic}"
}

# Parse "user:pass" from NTFY_CREDS_* vars
parse_creds() { echo "${1%%:*}"; }
parse_pass()  { echo "${1#*:}"; }

if [[ -n "${NTFY_CREDS_STEVE:-}" && -n "${NTFY_TOPIC_STEVE:-}" ]]; then
  create_ntfy_user "$(parse_creds "${NTFY_CREDS_STEVE}")" "$(parse_pass "${NTFY_CREDS_STEVE}")" "${NTFY_TOPIC_STEVE}"
fi
if [[ -n "${NTFY_CREDS_SON1:-}" && -n "${NTFY_TOPIC_SON1:-}" ]]; then
  create_ntfy_user "$(parse_creds "${NTFY_CREDS_SON1}")" "$(parse_pass "${NTFY_CREDS_SON1}")" "${NTFY_TOPIC_SON1}"
fi
if [[ -n "${NTFY_CREDS_SON2:-}" && -n "${NTFY_TOPIC_SON2:-}" ]]; then
  create_ntfy_user "$(parse_creds "${NTFY_CREDS_SON2}")" "$(parse_pass "${NTFY_CREDS_SON2}")" "${NTFY_TOPIC_SON2}"
fi

# ── 4. nginx ──────────────────────────────────────────────────────────────────
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
check "nginx configured and running"

# ── 5. Eddy worker systemd service ───────────────────────────────────────────
info "Eddy worker systemd service"

# Ensure Node is available at the path the unit expects
if ! command -v npm &>/dev/null; then
  warn "npm not found — install Node LTS first (nvm recommended)"
  exit 1
fi

# Point unit at this repo
sudo cp "${DEPLOY_DIR}/systemd/eddy-worker.service" /etc/systemd/system/eddy-worker.service
sudo sed -i "s|WorkingDirectory=.*|WorkingDirectory=${REPO_DIR}|" /etc/systemd/system/eddy-worker.service
sudo systemctl daemon-reload
sudo systemctl enable eddy-worker
sudo systemctl restart eddy-worker
check "eddy-worker service enabled and started"

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
