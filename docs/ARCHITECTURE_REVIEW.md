# Architecture review: single-server GCP deployment

| | |
|---|---|
| Date | 8 Nov 2026 |
| Target | One Compute Engine VM running the frontend, backend and PostgreSQL with Docker Compose |
| Scope | Runtime topology, transport security, data durability, operability, resource sizing, build and release, container hardening |
| Method | Review of `docker-compose*.yml`, Dockerfiles, nginx/Caddy config, API bootstrap and worker. Then **executed**: the production stack was run locally as a separate project (`jes-prodtest`, Caddy with a local CA) and checked property by property by [`backend/test/prod-check.mjs`](../backend/test/prod-check.mjs). Raw results are in [`test-results/prod-check.json`](test-results/prod-check.json) |
| Result | **16 findings, all fixed. Verification: 22/22 checks pass** (19 architecture checks plus 3 production penetration checks) |

## Target architecture

```
                 GCP firewall: 80/443 from anywhere, 22 only via IAP
Internet ─HTTPS─► edge  Caddy 2.11.9 · Let's Encrypt · HSTS · HTTP→HTTPS · replaces any client X-Forwarded-For
                   └─► web   nginx-unprivileged 1.27.5 · PWA (hashed assets, no-cache shell) · CSP · /api proxy
                         └─► api     NestJS · TRUST_PROXY=2 · rate limits · jes_app role (DML only)
                             worker  outbox → Google Calendar · recurring drafts · housekeeping · heartbeat
                             db      PostgreSQL 18.6 · tuned for 2–4 GB · not published
                             backup  nightly verified pg_dump + receipts · 30 days · restore.sh
```

| Container | Memory limit | Root FS | Capabilities | Healthcheck |
|---|---|---|---|---|
| edge | 128 MB | default | NET_BIND_SERVICE only | Caddy admin endpoint, internal only |
| web | 96 MB | read-only | none | `GET /` |
| api | 448 MB (heap 320 MB) | read-only | none | `/api/v1/ready` (DB) |
| worker | 256 MB (heap 192 MB) | read-only | none | heartbeat younger than 120 s |
| db | 768 MB | default (entrypoint) | default | `pg_isready` |
| backup | 256 MB | default | default | last success within 26 h |

All six containers restart automatically, run with `no-new-privileges`, and rotate their logs (10 MB × 5).

## Findings and fixes

| ID | Sev. | Finding | Fix | Verified by |
|---|---|---|---|---|
| ARCH-01 | **High** | No TLS: logins, tokens and client data would cross the internet in clear text. Cookies weren't `Secure`, and there was no HSTS. | **Caddy** edge with automatic Let's Encrypt certificates, HTTP→HTTPS redirect, HSTS for 1 year, and the `Server`/`Via` headers removed. `COOKIE_SECURE=true` in production. TLS 1.2+ only. | ARCH-01a–e |
| ARCH-02 | **High** | No automated backups (PRD NFR-06 requires daily backups with 30-day retention). Losing the disk would lose all bookings and money records. | `backup` service: a nightly `pg_dump` (custom format, checked with `pg_restore --list` before it's published) plus a receipts archive, with 30-day retention, a freshness healthcheck and `restore.sh`. The deploy guide adds an off-site Cloud Storage copy and disk snapshots. | ARCH-02a, ARCH-02b (restore drill: identical row counts) |
| ARCH-03 | **High** | No restart policies: a crash or VM reboot would leave the studio offline. | `restart: unless-stopped` on every long-running service. Docker `live-restore` is set in the VM bootstrap. | ARCH-03 |
| ARCH-04 | Medium | Docker logs were unbounded and could fill a 30 GB disk. | json-file rotation of 10 MB × 5 per container, also as the daemon default. | ARCH-04 |
| ARCH-05 | Medium | No resource limits or database tuning: one runaway process could take down a small VM. | Memory limits per service (about 1.9 GB total), Node heap caps, and Postgres tuned (`shared_buffers` 256 MB, `max_connections` 50, slow-query and lock-wait logging). 2 GB of swap is added by the bootstrap. | ARCH-05 |
| ARCH-06 | Medium | Adding a TLS proxy means there are now two proxies in front of the API. With `trust proxy 1`, the API would see the proxy's IP for every user, so all users would share one rate-limit and lockout bucket. A wrong setting could instead let clients spoof their IP. | `TRUST_PROXY` setting (1 locally, 2 in production). Caddy replaces any client-supplied `X-Forwarded-For`. | ARCH-06a (forged header ignored, real client IP recorded) |
| ARCH-07 | Medium | The worker and web containers had no healthchecks, so a hung worker would go unnoticed. | Worker heartbeat file plus healthcheck, a web `GET /` check, and an edge check. Dependencies start in health order. | ARCH-07 |
| ARCH-08 | Medium | Floating image tags (`node:22-alpine`, `postgres:18-alpine`, …) meant a rebuild could silently pull different software. | Pinned to `node:22.23.4-alpine`, `postgres:18.6-alpine`, `nginx-unprivileged:1.27.5-alpine` and `caddy:2.11.9-alpine`. | ARCH-08 |
| ARCH-09 | Medium | `index.html` could be cached heuristically, so phones might keep running the old app after a deploy. | `Cache-Control: no-cache` on the app shell and manifest; hashed assets are cached for a year, `immutable`. | ARCH-09 |
| ARCH-10 | Low | Vite inlined small font files as `data:` URIs, and the CSP (correctly) blocked them, so some text rendered in a fallback font. *Found by the E2E run.* | Fonts are never inlined; the CSP stays strict. | ARCH-10 |
| ARCH-11 | Low | The worker ignored SIGTERM, so Docker killed it after the grace period, possibly in the middle of a calendar call. | SIGTERM/SIGINT handling: stop the timers, let the current job finish, close the pool, exit. | ARCH-11 (stops in about 0.2 s) |
| ARCH-12 | Medium | Containers ran with a writable root filesystem and the default capabilities. | `read_only` root plus `/tmp` tmpfs for web, api and worker; `cap_drop: ALL`; `no-new-privileges` on all. | ARCH-12 |
| ARCH-13 | Low | No CI, so a broken build could be pulled onto the server. | GitHub Actions: `npm ci`, a type-checked build of every workspace, unit tests, `npm audit --audit-level=high`, and both Docker images. | ARCH-13 |
| ARCH-14 | Medium | Host hardening wasn't defined (firewall, SSH, OS updates). | [`infra/gcp/setup-vm.sh`](../infra/gcp/setup-vm.sh) (Docker from the official repository, swap, unattended upgrades, fail2ban, log defaults) and [`DEPLOY_GCP.md`](DEPLOY_GCP.md) (firewall 80/443 only, SSH through IAP only, static IP, Shielded VM). | PEN-02 (only the edge is reachable), deploy guide |
| ARCH-15 | Low | Secrets lived in a plain `.env` with no production template. | [`.env.production.example`](../.env.production.example), `chmod 600` in the deploy steps, Secret Manager option. The owner DB password is not given to the api or worker. | Deploy guide, compose review |
| ARCH-16 | Info | A single VM is a single point of failure. | Accepted for a one-studio app. RPO ≤ 24 h, RTO about 1 h (snapshot or dump restore), Cloud Monitoring uptime check, documented in the deploy guide. | Deploy guide §8–9 |

## Kept as is (reviewed, no change needed)

- **Separate `migrate` job with owner credentials.** The api and worker run as `jes_app` (DML only, audit tables append-only).
- **In-memory rate limiter.** Correct for one API replica. Move it to Postgres or Redis before running two replicas.
- **Outbox plus LISTEN/NOTIFY.** A calendar outage never blocks saving a booking, and the worker restarts are safe with `FOR UPDATE SKIP LOCKED`.
- **Receipt storage on a Docker volume.** It's covered by the backups. Cloud Storage would only be needed with multiple servers.

## How to re-run

```bash
# locally, against a production-mode copy (separate project, ports 8081/8443, local CA)
printf 'DOMAIN=localhost\nACME_EMAIL=t@example.com\nTLS_MODE=internal\nHTTP_PORT=8081\nHTTPS_PORT=8443\nBACKUP_DIR=/tmp/jes-backups\n' > /tmp/prodtest.env
docker compose -p jes-prodtest -f docker-compose.prod.yml --env-file .env --env-file /tmp/prodtest.env up -d --build
PROJECT=jes-prodtest ENV_FILES=/tmp/prodtest.env node backend/test/prod-check.mjs

# on the VM
PROJECT=jes-booking BASE=https://<domain> HTTP=http://<domain> node backend/test/prod-check.mjs
```
