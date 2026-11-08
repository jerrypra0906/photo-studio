# Deploying JES Studio Booking to Google Cloud (single VM)

One Compute Engine VM runs everything with Docker Compose:

```
Internet ──443──► edge (Caddy: Let's Encrypt TLS, HSTS, HTTP→HTTPS)
                    └─► web (nginx: PWA + /api proxy, CSP)
                          └─► api (NestJS) ──► db (PostgreSQL 18, not published)
                              worker (calendar sync, recurring drafts, housekeeping)
                              backup (nightly pg_dump + receipts, 30-day retention)
```

Only ports 80 and 443 are open to the internet. The database, API and web containers are reachable only inside the Docker network.

## 1. Create the VM

| Setting | Value |
|---|---|
| Region | `asia-southeast2` (Jakarta) |
| Machine | `e2-medium` (2 vCPU, 4 GB) recommended. `e2-small` (2 GB) also works: the memory limits total about 1.9 GB, and the bootstrap adds 2 GB of swap |
| Boot disk | Ubuntu 24.04 LTS, 30 GB balanced persistent disk |
| Network tags | `jes-web` |
| External IP | Reserve a **static** IP |

```bash
gcloud compute addresses create jes-ip --region=asia-southeast2
gcloud compute instances create jes-booking --zone=asia-southeast2-a --machine-type=e2-medium \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=30GB \
  --boot-disk-type=pd-balanced --address=jes-ip --tags=jes-web --shielded-secure-boot
```

## 2. Firewall

```bash
# web traffic
gcloud compute firewall-rules create jes-web --target-tags=jes-web --allow=tcp:80,tcp:443 --source-ranges=0.0.0.0/0
# SSH only through Identity-Aware Proxy (no public SSH)
gcloud compute firewall-rules create jes-ssh-iap --target-tags=jes-web --allow=tcp:22 --source-ranges=35.235.240.0/20
```

Remove the default `default-allow-ssh` rule if your project has it. Connect with `gcloud compute ssh jes-booking --tunnel-through-iap`.

## 3. DNS

Point an `A` record for your domain (for example `book.jesspace.studio`) at the static IP **before** first start, so Caddy can obtain the certificate.

## 4. Bootstrap the server

```bash
git clone git@github.com:jerrypra0906/photo-studio.git /srv/jes/app   # or copy a release tarball
cd /srv/jes/app
bash infra/gcp/setup-vm.sh      # Docker, swap, unattended upgrades, log caps, /srv/jes/backups
exit                            # log in again so the docker group applies
```

## 5. Configure secrets

```bash
cd /srv/jes/app
cp .env.production.example .env
chmod 600 .env
nano .env    # fill every value; generate secrets as the file explains
```

Production settings that matter: `DOMAIN`, `APP_URL=https://<domain>`, `COOKIE_SECURE=true`, strong `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `JWT_SECRET`, a 32-byte `ENCRYPTION_KEY`, and the first Owner and Staff logins. For stronger secret handling, store `.env` in **Secret Manager** and write it out at deploy time: `gcloud secrets versions access latest --secret=jes-env > .env`.

## 6. Start

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps        # all services healthy, migrate exited 0
```

Open `https://<domain>`, sign in as the seeded Owner, and right away:

1. Change the Owner password (**Admin → Akun saya**).
2. Fill in the studio profile and bank details (**Admin → Pengaturan studio**).
3. Register the staff accounts (**Admin → Pengguna → + Daftarkan**). Remove or change the seeded Staff login.

## 7. Verify the deployment

Run the architecture and transport checks on the VM (it needs Node 22 for the test runner):

```bash
PROJECT=jes-booking BASE=https://<domain> HTTP=http://<domain> node backend/test/prod-check.mjs
```

All 22 checks should pass: TLS, HSTS, HTTP redirect, client-IP handling, backups and a restore drill, restart and log policies, memory limits, healthchecks, least privilege, closed ports, pinned images, cache headers, graceful shutdown.

## 8. Backups

- **Nightly dumps.** The `backup` service writes `jes-YYYYMMDD-HHMMSS.dump` plus a receipts archive to `BACKUP_DIR` (default `/srv/jes/backups`) at 02:30 WIB, and keeps 30 days. A dump is published only after `pg_restore` can read it.
- **Off-site copy.** Copy the dumps to Cloud Storage in another region. Create the bucket once with `gcloud storage buckets create gs://<bucket> --location=asia-southeast1 --uniform-bucket-level-access`, then add a host cron job:
  ```cron
  15 3 * * * gcloud storage rsync -r /srv/jes/backups gs://<bucket>/jes-backups
  ```
  The VM's service account needs `roles/storage.objectAdmin` on that bucket only.
- **Disk snapshots.** Attach a daily snapshot schedule with 14-day retention to the boot disk (Compute Engine → Snapshots → Schedules). This covers the Caddy certificates and anything outside the dumps.
- **Restore** (destructive):
  ```bash
  docker compose -f docker-compose.prod.yml exec backup sh /restore.sh /backups/db/jes-<stamp>.dump /backups/files/receipts-<stamp>.tar.gz
  docker compose -f docker-compose.prod.yml run --rm migrate
  docker compose -f docker-compose.prod.yml restart api worker
  ```
- **Recovery targets:** RPO ≤ 24 h (nightly dump), RTO about 1 h (new VM from a snapshot, or a fresh VM plus a dump restore).

## 9. Monitoring

- **Uptime check** (Cloud Monitoring): HTTPS `GET https://<domain>/api/v1/health` every 5 minutes, with an alert to the owner's email.
- **Logs:** `docker compose -f docker-compose.prod.yml logs -f api worker`. Logs rotate at 10 MB × 5 per container. For retention, install the Ops Agent and collect the Docker JSON logs.
- **Backup freshness:** the `backup` container turns *unhealthy* if no successful backup has run in 26 hours. `docker compose ps` shows it.

## 10. Updating

```bash
cd /srv/jes/app && git pull
docker compose -f docker-compose.prod.yml up -d --build      # migrate runs first; api/worker restart gracefully
docker image prune -f
```

Each release should pass CI (`.github/workflows/ci.yml`) before you pull it on the server.

## Google Calendar

In Google Cloud Console, create an OAuth client (Web application) with the redirect URI `https://<domain>/api/v1/integrations/google/callback`. Put the client ID and secret in `.env`, then run `docker compose -f docker-compose.prod.yml up -d api worker`. Connect from **Admin → Google Calendar**, using a test calendar first.
