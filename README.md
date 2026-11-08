# JES Studio Booking

Mobile-first booking, invoicing and P&L app for JES Space Studio. It implements the PRD (bookings, PDF invoices, WhatsApp templates, expenses, monthly recap and one-way Google Calendar sync).

- Review of the PRD/TD and the build plan: [docs/REVIEW_AND_PLAN.md](docs/REVIEW_AND_PLAN.md)

## Run locally (Docker)

```bash
cp .env.example .env   # then fill the secrets (a filled .env is already present on this machine)
docker compose up -d --build
```

| URL | What |
|---|---|
| http://localhost:8080 | The app, and the only entry point (nginx serves the PWA and proxies `/api`) |
| http://localhost:8080/api/v1/health | API health, through nginx (the API port itself is not published) |
| `127.0.0.1:5433` | PostgreSQL 18, from this machine only. Admin `jes` (`POSTGRES_PASSWORD`); the app uses `jes_app` (`APP_DB_PASSWORD`) |

`docker compose up` runs a one-shot `migrate` service first (migrations, seed, `jes_app` role). Then the API and worker start with the least-privilege role.
The `jes-api:local` image is built by the `migrate` service and reused by `api` and `worker`. After backend changes, run `docker compose up -d --build` (or `docker compose build migrate`), not `--build api`.

## Owner dashboard (Keuangan)

Three tabs share one month switcher (the month carries across tabs), and each figure appears in one place only:

- **Ringkasan** answers four questions for the selected month: how it went (net profit, income, expenses and bookings vs last month), how it compares with other months (net-profit chart with rank and average; tap a month to switch to it), **which package performed best** (revenue including add-ons, bookings, average per booking, change vs last month, best-selling add-ons) and **what the biggest expenses are** (share and change; tap one to see its expenses). A "needs action" card appears only for unconfirmed costs or unpaid balances.
- **Pengeluaran** is the working view: confirm drafts, see the month's costs by day, filter by category, add new ones.
- **Laporan** is the formal monthly statement: income and expense lines, net profit, receivables, the billed/collected basis, CSV/PDF export and month close.

The data comes from `GET /api/v1/reports/trend?months=12&end=YYYY-MM&basis=BILLED|COLLECTED`. Every month equals that month's recap (checked by test DASH-01).

To see the dashboard with realistic history on a dev database:

```bash
node backend/test/demo-data.mjs            # ~11 months of tagged [demo] bookings and expenses, about 5 min
node backend/test/demo-data.mjs --remove   # delete everything tagged [demo]
```

Seeded logins come from `.env` (`SEED_OWNER_*`, `SEED_STAFF_*`). The seed data has the current price list (Studio Only 170K/h, Photo Package 599K/h), photographers, add-ons, expense categories and WhatsApp templates. Fill in the bank details in **Admin → Pengaturan studio** before generating invoices.

## Layout

```
shared/     pricing(), money/phone/WIB helpers, Zod schemas, template renderer (used by both sides)
backend/    NestJS 11 API (src/main.ts) + worker (src/worker.ts), SQL migrations in db/migrations
frontend/   React 19 + Vite + Tailwind 4 PWA
infra/      Dockerfiles and nginx config
```

## Tests

```bash
npm test                                           # pricing unit tests (PRD §6.3 worked examples)
node backend/test/smoke.mjs http://localhost:8080  # 23 quick API checks against the running stack
node backend/test/functional.mjs                   # 170 backend functional cases: every user story ±, dashboard, user management
(cd frontend && npx playwright test)               # 51 frontend E2E cases in mobile Chromium (first run: npx playwright install chromium)
node backend/test/security.mjs                     # 63 penetration-test cases (docs/SECURITY_REVIEW.md)
node backend/test/prod-check.mjs                   # 22 production architecture + transport checks (docs/ARCHITECTURE_REVIEW.md)
```

Reports: [docs/TEST_REPORT.md](docs/TEST_REPORT.md), [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md), [docs/ARCHITECTURE_REVIEW.md](docs/ARCHITECTURE_REVIEW.md).

## Deploying to production (GCP)

One VM, Docker Compose, Caddy for TLS, nightly backups: see **[docs/DEPLOY_GCP.md](docs/DEPLOY_GCP.md)** and `docker-compose.prod.yml`. The local `docker-compose.yml` is for development only.

## Users

Owners register, edit and remove accounts in **Admin → Pengguna**. There is no public sign-up. Everyone can change their own name and password in **Akun saya**. Passwords need at least 10 characters with a letter and a digit.

The smoke test creates bookings on random far-future dates and in a random 2025 month, so run it only against a dev database.

## Google Calendar

The code is complete but has not been tested against a real Google account yet. To enable it:

1. In Google Cloud Console, enable the **Google Calendar API** and create an OAuth client of type **Web application**.
2. Add the redirect URI `http://localhost:8080/api/v1/integrations/google/callback`. For production use `https://<domain>/api/v1/integrations/google/callback`.
3. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`, then run `docker compose up -d api worker`.
4. In the app, go to **Admin → Google Calendar → Hubungkan**, sign in as jes.space.studio, and pick the "Jessie" calendar. For testing, use a separate calendar first (TD §3.1).

Until it is connected, bookings save normally and show no sync badge (US-29.10).

## Useful commands

```bash
docker compose logs -f api worker
docker compose exec db psql -U jes -d jes
docker compose down          # stop (data kept in volumes)
docker compose down -v       # stop and wipe the database
```
