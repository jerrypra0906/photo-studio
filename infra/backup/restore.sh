#!/bin/sh
# Restore a dump into the running database (DESTRUCTIVE: replaces the current data).
#   docker compose -f docker-compose.prod.yml exec backup sh /restore.sh /backups/db/jes-YYYYMMDD-HHMMSS.dump [/backups/files/receipts-….tar.gz]
set -eu
dump="${1:?usage: restore.sh <dump> [receipts.tar.gz]}"
export PGPASSWORD="$POSTGRES_PASSWORD"
pg_restore --list "$dump" > /dev/null
echo "Restoring $dump into ${PGDATABASE:-jes}; existing data will be replaced."
pg_restore --host="${PGHOST:-db}" --username="${PGUSER:-jes}" --dbname="${PGDATABASE:-jes}" \
  --clean --if-exists --no-owner --single-transaction "$dump"
if [ -n "${2:-}" ]; then
  tar -xzf "$2" -C /data
  echo "receipts restored"
fi
echo "restore: done. Re-apply grants and restart: docker compose -f docker-compose.prod.yml run --rm migrate && docker compose -f docker-compose.prod.yml restart api worker"
