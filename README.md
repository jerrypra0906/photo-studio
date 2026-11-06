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

## Owner dashboard

**Keuangan → Dashboard** (Owner only) shows:

- the last finished month's net profit (hero figure), with income, expenses, margin and bookings vs the month before;
- the running month on a separate strip, so half a month is never compared with a full one;
- income vs expenses per month, and the net-profit trend against the average, for 6 or 12 months, by billed or collected basis;
- window and year-to-date totals, best and worst month, income sources and the largest costs.

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
node backend/test/functional.mjs                   # 152 functional cases, every user story ± and the dashboard (docs/TEST_REPORT.md)
node backend/test/security.mjs                     # 56 penetration-test cases (docs/SECURITY_REVIEW.md)
```

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
