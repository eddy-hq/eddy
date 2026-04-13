#!/usr/bin/env bash
# Refresh YouTube cookies on the Ubuntu worker.
# Run this on your Mac when downloads start failing with bot-detection errors.
# Reads cookies from your local browser — no extension needed.
# Usage: ./deploy/refresh-yt-cookies.sh [chrome|firefox|safari]
set -euo pipefail

UBUNTU_HOST="100.95.170.27"
UBUNTU_USER="steveu"
UBUNTU_DEST="/home/steveu/eddy/youtube-cookies.txt"
COOKIES_TMP="$(mktemp /tmp/youtube-cookies.XXXXXX.txt)"
printf '# Netscape HTTP Cookie File\n# https://curl.se/docs/http-cookies.html\n\n' > "${COOKIES_TMP}"
BROWSER="${1:-safari}"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RESET='\033[0m'
info() { printf "${GREEN}▶ %s${RESET}\n" "$*"; }
warn() { printf "${YELLOW}! %s${RESET}\n" "$*"; }

cleanup() { rm -f "${COOKIES_TMP}"; }
trap cleanup EXIT

# yt-dlp must be available on the Mac to read browser cookies
YTDLP_BIN="$(command -v yt-dlp 2>/dev/null || true)"
if [[ -z "${YTDLP_BIN}" ]]; then
  warn "yt-dlp not found on this Mac. Install with: brew install yt-dlp"
  exit 1
fi

info "Exporting YouTube cookies from ${BROWSER}…"
"${YTDLP_BIN}" \
  --cookies-from-browser "${BROWSER}" \
  --cookies "${COOKIES_TMP}" \
  --skip-download \
  --quiet \
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

if [[ ! -s "${COOKIES_TMP}" ]]; then
  warn "Cookie file is empty — make sure you're logged into YouTube in ${BROWSER}"
  exit 1
fi

info "Copying cookies to Ubuntu worker…"
scp "${COOKIES_TMP}" "${UBUNTU_USER}@${UBUNTU_HOST}:${UBUNTU_DEST}"

info "Restarting worker…"
ssh "${UBUNTU_USER}@${UBUNTU_HOST}" "sudo systemctl restart eddy-worker"

printf "${GREEN}Done. Worker restarted with fresh cookies.${RESET}\n"
echo ""
echo "If downloads still fail after ~30s, check the worker log:"
echo "  ssh ${UBUNTU_USER}@${UBUNTU_HOST} 'sudo journalctl -fu eddy-worker'"
