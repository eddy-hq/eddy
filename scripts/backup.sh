#!/usr/bin/env bash
# Nightly SQLite backup to Ubuntu media server.
# Run via cron: 0 3 * * * /path/to/eddy/scripts/backup.sh >> /var/log/eddy-backup.log 2>&1
set -euo pipefail

# Source .env if present (for cron context where env vars may not be set)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

DB_PATH="${DATABASE_PATH:-./eddy.db}"
SSH_USER="${BACKUP_SSH_USER:?BACKUP_SSH_USER not set}"
SSH_HOST="${BACKUP_SSH_HOST:?BACKUP_SSH_HOST not set}"
DEST_PATH="${BACKUP_DEST_PATH:?BACKUP_DEST_PATH not set}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TMP_BACKUP="/tmp/eddy_backup_${TIMESTAMP}.db"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting backup"

# sqlite3 online backup (safe with WAL mode, no lock required)
sqlite3 "$DB_PATH" ".backup ${TMP_BACKUP}"

# Ensure destination directory exists
ssh "${SSH_USER}@${SSH_HOST}" "mkdir -p ${DEST_PATH}"

# Sync to Ubuntu
rsync -az --remove-source-files \
  "$TMP_BACKUP" \
  "${SSH_USER}@${SSH_HOST}:${DEST_PATH}/eddy_backup_${TIMESTAMP}.db"

# Rotate: keep only the 7 most recent backups on the remote
ssh "${SSH_USER}@${SSH_HOST}" \
  "ls -t ${DEST_PATH}/eddy_backup_*.db 2>/dev/null | tail -n +8 | xargs -r rm --"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Backup complete: eddy_backup_${TIMESTAMP}.db"
