# Deployment plan: photostudio.gbjessdaph.org on the Leviathan server

| | |
|---|---|
| Server | `instance-20260826-083653` (id 5721783038508210967), `asia-southeast1-a`, e2-medium (2 vCPU, 4 GB), Debian 13 |
| IPs | private `10.148.0.2`, public `136.85.45.18` |
| Shared with | **Leviathan** (`/home/jpmrsimple/leviathan`, compose project `leviathan`): `leviathan-caddy-1` owns ports 80/443, plus `leviathan-web` (:8080), `leviathan-api` (:8000), `leviathan-db` (:5433) |
| Domain | `photostudio.gbjessdaph.org` (Cloudflare DNS). The apex `gbjessdaph.org` and `www` stay on Leviathan |
| First login | Owner `desi.novianti.mail@gmail.com` |

## What was found (inspected 8 Nov 2026, read-only)

| Item | State | Consequence for the plan |
|---|---|---|
| Ports in use | 22, 53, 80, 443, 5355, 5433, 8000, 8080, 20201, 20202 | Photostudio publishes **no public port**. Only `127.0.0.1:8090` is used, for health checks on the server (free and not reachable from outside) |
| Reverse proxy | Leviathan's Caddy 2.11.4 (container) owns 80/443. Caddyfile is bind-mounted from `/home/jpmrsimple/leviathan/Caddyfile`; no `--watch` (changes apply only after `caddy reload`) | **No second Caddy.** Add one site block for the subdomain to Leviathan's Caddyfile, validate it first, then reload gracefully (no downtime for the apex) |
| Docker networks | Leviathan containers share `leviathan_default`; Leviathan's Caddy proxies to `web:80`, and Leviathan also has an `api` | Only the photostudio **web (nginx)** container joins `leviathan_default`, under the unique alias `photostudio-web`, so Caddy can reach it. API, worker and database stay on photostudio's private network. **Names must not collide:** Compose registers the service name on every network a container joins, so the web service is called `ps-web` (not `web`) and nginx reaches the API through the alias `jes-api` (not `api`). During the first install the service was still called `web`; it was disconnected from `leviathan_default` within minutes, the apex kept returning 200, and the rename fixed it for good |
| Memory | 3.9 GB total, about 2.4 GB available, **no swap**. Leviathan uses about 550 MB | Photostudio memory limits total about 1.1 GB (db 384 MB, api 320 MB, worker 192 MB, web 64 MB, backup 128 MB); real use is about 300–400 MB |
| Disk | 9.7 GB, **1.8 GB free (82%)**. Leviathan has 0.8 GB of old build cache | **Nothing is built on the server.** Images are built on the Mac for linux/amd64, uploaded and loaded (about 0.5 GB). Recommended separately: grow the disk to 20 GB, which can be done online |
| DNS | Cloudflare. Apex and `www` are **DNS only** → 136.85.45.18. `photostudio` exists but is **proxied (orange)** and returns 525 | **You:** set `photostudio` to **DNS only (grey cloud)**, A → `136.85.45.18`. Otherwise Let's Encrypt can't validate through Cloudflare's HTTPS redirect. The apex records stay untouched |

## Architecture on the shared host

```
Internet ─443─► leviathan-caddy-1 (unchanged for gbjessdaph.org, www)
                 └─ photostudio.gbjessdaph.org ─► photostudio-web (nginx, on leviathan_default + photostudio net)
                                                     └─► api ─► db (postgres 18.6, photostudio net only)
                                                         worker, backup (photostudio net only)
```

`TRUST_PROXY=2` (Caddy → nginx → api), `COOKIE_SECURE=true`, HSTS for the subdomain only (no `includeSubDomains` on the apex). Volumes `photostudio_*`. Files and backups live under `/srv/photostudio`.

## Steps

### Phase A: install photostudio (no effect on Leviathan)
1. Add a shared-host compose file (`deploy/gbjessdaph/docker-compose.yml`): no edge container, web on `leviathan_default`, smaller memory limits, `127.0.0.1:8090`.
2. Change the seed so it skips the Staff account when no Staff email is set. Only Desi's Owner account is created.
3. Build `jes-api` and `jes-web` for **linux/amd64** on the Mac, `docker save | gzip`, upload through the IAP tunnel to `/srv/photostudio`, `docker load`, delete the tarballs.
4. On the server, generate fresh secrets in `/srv/photostudio/.env` (`chmod 600`). Desi's initial password goes to `/srv/photostudio/INITIAL_OWNER_PASSWORD` (`chmod 600`, root only). It is never printed or committed.
5. `docker compose -p photostudio up -d`, then check health through `127.0.0.1:8090`.
6. **Leviathan check:** containers still up, `https://gbjessdaph.org` still returns 200, memory and disk OK.

### Phase B: publish the subdomain (after the DNS change)
7. Back up the Leviathan Caddyfile (`Caddyfile.bak-<timestamp>`). Append the `photostudio.gbjessdaph.org` block **in place**, keeping the same inode because the file is bind-mounted. Run `caddy validate`, then `caddy reload` (graceful).
8. Verify: the apex is still 200 with its certificate unchanged, and `https://photostudio.gbjessdaph.org` serves the app with a valid Let's Encrypt certificate, HSTS and HTTP→HTTPS.
9. Run the read-only production checks against the live URL. **No test data is created in production.** The functional and E2E suites are never run here.

### Status (8 Nov 2026): live
- Caddyfile backup: `/home/jpmrsimple/leviathan/Caddyfile.bak-20261108-160004`. The block was appended in place (same inode), validated, and Caddy was reloaded gracefully. Caddy logged no errors.
- `https://photostudio.gbjessdaph.org`: 200, Let's Encrypt certificate (expires 6 Feb 2027, auto-renewed by Caddy), HSTS, CSP, HTTP→HTTPS 308, `/api/v1/health` ok, bad login 401, unauthenticated API 401.
- `gbjessdaph.org` and `www`: still 200 with their own certificate. Leviathan containers were never restarted.

### Rollback (any point)
- Subdomain: restore `Caddyfile.bak-<timestamp>`, then `docker exec leviathan-caddy-1 caddy reload --config /etc/caddy/Caddyfile`.
- App: `docker compose -p photostudio down` (volumes are kept). Leviathan is never restarted or modified apart from the one Caddyfile block.

## After go-live (Desi)
1. Sign in at `https://photostudio.gbjessdaph.org` with `desi.novianti.mail@gmail.com` and the initial password (read it on the server: `sudo cat /srv/photostudio/INITIAL_OWNER_PASSWORD`).
2. Change the password in **Akun saya**, then delete the file: `sudo rm /srv/photostudio/INITIAL_OWNER_PASSWORD`.
3. Fill in **Pengaturan studio** (bank details are needed for invoices) and register staff in **Pengguna**.
