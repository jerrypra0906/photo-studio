#!/bin/sh
# Nightly logical backup (NFR-06): PostgreSQL custom-format dump + receipt files, kept for RETENTION_DAYS.
# Runs inside the postgres image so pg_dump matches the server version. Off-site copy: see docs/DEPLOY_GCP.md.
set -eu
: "${PGHOST:=db}" "${PGUSER:=jes}" "${PGDATABASE:=jes}" "${RETENTION_DAYS:=30}" "${BACKUP_AT:=02:30}"
export PGHOST PGUSER PGDATABASE
export PGPASSWORD="$POSTGRES_PASSWORD"
mkdir -p /backups/db /backups/files

run_backup() {
  stamp=$(TZ=Asia/Jakarta date +%Y%m%d-%H%M%S)
  tmp="/backups/db/.jes-$stamp.partial"
  pg_dump --format=custom --compress=9 --no-owner --file="$tmp"
  # publish only an archive that pg_restore can read
  pg_restore --list "$tmp" > /dev/null
  mv "$tmp" "/backups/db/jes-$stamp.dump"
  if [ -d /data/files ]; then
    tar -czf "/backups/files/receipts-$stamp.tar.gz" -C /data files
  fi
  find /backups/db -name 'jes-*.dump' -mtime +"$RETENTION_DAYS" -exec rm -f {} \;
  find /backups/files -name 'receipts-*.tar.gz' -mtime +"$RETENTION_DAYS" -exec rm -f {} \;
  date -u +%s > /backups/.last-success
  echo "backup: jes-$stamp.dump ok"
}

if [ "${1:-}" = "now" ]; then
  run_backup
  exit 0
fi

# one backup at start, then daily at BACKUP_AT (WIB)
run_backup || echo "backup: FAILED at start" >&2
while true; do
  now=$(date -u +%s)
  # WIB is UTC+7 with no DST
  h=${BACKUP_AT%:*}; m=${BACKUP_AT#*:}
  h=${h#0}; m=${m#0}
  today_utc=$(( (now + 25200) / 86400 * 86400 - 25200 ))
  next=$(( today_utc + ${h:-0} * 3600 + ${m:-0} * 60 ))
  [ "$next" -le "$now" ] && next=$(( next + 86400 ))
  sleep $(( next - now ))
  run_backup || echo "backup: FAILED" >&2
done
