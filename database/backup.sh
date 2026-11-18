#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/secure_qr}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

mysqldump \
  --single-transaction \
  --routines \
  --triggers \
  -h "${MYSQL_HOST:-127.0.0.1}" \
  -P "${MYSQL_PORT:-3306}" \
  -u "${MYSQL_USER:-secure_qr_user}" \
  -p"${MYSQL_PASSWORD}" \
  "${MYSQL_DATABASE:-secure_qr_db}" | gzip > "${BACKUP_DIR}/secure_qr_${TIMESTAMP}.sql.gz"

echo "Backup created: ${BACKUP_DIR}/secure_qr_${TIMESTAMP}.sql.gz"
