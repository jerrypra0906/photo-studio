# JES Studio Booking — PRD/TD review and build plan

Reviewed 1 Nov 2026 against:

- **PRD — JES Studio Booking (Mobile Web App)** v0.1, read in full.
- **TD Jes Space Studio**, Summary tab only (stack, decisions D1–D9, architecture, environments, security, key flows). The **Backend, Frontend and Database tabs did not come through the Drive connector**, so the database and API design below are derived from the PRD and the TD summary. Compare them against those tabs before production.

## 1. What the product is (understanding)

A single-studio, owner-operated booking app for phones. It replaces three hand-maintained copies of each booking (Google Calendar, WhatsApp, the "income 2026" sheet) with a single source of truth:

1. **Booking.** Pick a type (Studio Only 170K/h, Photo Package 599K/h), hours, slot, client, photographer and add-ons. The price is computed automatically and snapshotted. The database blocks double booking.
2. **Communicate.** A PDF invoice (A5, revisioned) and WhatsApp templates (copy or wa.me).
3. **Calendar.** One-way push to the existing "Jessie" Google Calendar through an outbox and a worker, so a Google outage never blocks a save.
4. **Money.** Expenses (manual, auto-drafted photographer fees, recurring monthly drafts) and a monthly recap (revenue by session date, expenses by date paid, net profit, receivables), with CSV/PDF export and month close.

The pricing formula and the worked examples in §6.3 all check out. So does the recap arithmetic in §6.5 (11.828.000 − 5.300.000 = 6.528.000, 55%).

## 2. Critique — gaps, contradictions and risks

### Must resolve (they change data or behaviour)

| # | Finding | Where | Decision taken in this build |
|---|---|---|---|
| C1 | **The buffer and the exclusion constraint conflict.** BR-01 adds a configurable buffer to the occupied range. If the constraint computes `end + current buffer`, changing the setting later makes existing rows invalid or inconsistent. | BR-01, D2 | Store `block_end_at = end_at + buffer` on the booking when it is saved. The exclusion constraint uses `[start_at, block_end_at)`. |
| C2 | **The photographer overlap check is redundant.** With one room (Assumption 1), two non-cancelled bookings can never overlap, so a photographer can never be double-booked inside the studio. The check only matters if photographers also work off-site or a second room is added. | FR-03, BR-02, US-07.2 | Rely on the studio constraint. The UI still marks photographers as busy from the same data. Revisit this if a second room is added. |
| C3 | **The booking number's date is ambiguous.** The examples (JES-261030-001 for a 30 Oct session) imply the session date, but a reschedule must not change the number. | BR-03 | Use the session date at creation. The number never changes after that. A per-day counter row is locked in the save transaction. |
| C4 | **"Every edit bumps the invoice revision"** would also bump on a notes change or an "invoice sent" toggle. | L2-1.3.5 | Bump only when an invoice-visible field changes: type, time, hours, client, photographer, add-ons, adjustment or DP. |
| C5 | **DP vs paid is ambiguous.** It isn't clear whether `dp_amount` is the DP agreed or the DP received. The invoice says "DP paid", and payment status has three values. | FR-14, §9.1 | `dp_amount` is the DP received. `paid_amount` is the total received (it is at least the DP). Payment status is derived from the amounts and never entered separately. |
| C6 | **The recap does not reconcile when there is an adjustment.** The breakdown is "by type + add-ons", so a −420K promo disappears from it. | §6.5, FR-23 | Add an **Adjustments** revenue line so the breakdown sums to the total. |
| C7 | **"Collected" basis is grouped by session month**, but the app has no payment dates, so it isn't true cash basis. | 4.3.2, Q8 | Ship it as "Collected (by session month)" and label it so. Payment dates are a Phase 1.1 item. |
| C8 | **The closed-month lock must check both the old and the new month.** Otherwise you could reschedule a booking out of a closed month, or into one. | BR-13 | A database trigger checks the OLD and the NEW row for bookings and expenses. |
| C9 | **Fields are missing from the data model:** the after-hours override reason (US-05.4), the studio WhatsApp number (invoice header, §9.2), the calendar title keyword per type ("group", "sewa" in 5.2.3), and the optimistic-lock version and idempotency keys the TD relies on (If-Match, Idempotency-Key). | §9.1 | Added: `after_hours_reason`, `settings.studio_phone`, `booking_types.calendar_keyword`, `bookings.version`, and an `idempotency_keys` table. |

### Should fix (consistency and scope)

- **Phasing contradiction.** The price adjustment (FR-15) is in Phase 1.1, but worked example §6.3 #5 and US-10 depend on it, and the field is cheap to build. **It is included in the MVP.** Staff role (FR-16) and CSV export (FR-17) are also cheap and are included.
- **Cost constraint vs hosting.** The PRD §2.3 asks for a "low running cost … small serverless backend". The TD proposes 2 API replicas, a 2 vCPU / 4 GB app server and a separate DB server or RDS for roughly 30–60 bookings a month. **Recommendation:** run one API replica and one worker. Use the smallest RDS tier, or PostgreSQL on the same ECS with pgBackRest to OSS.
- **Three queue mechanisms.** The TD uses an outbox table, LISTEN/NOTIFY *and* pg-boss. **Recommendation:** the outbox plus NOTIFY is enough for calendar sync. A once-a-day loop in the worker covers recurring drafts. This build drops pg-boss.
- **Separate API subdomain.** `api.book.jesspace.studio` forces CORS and cross-origin cookie handling. **Recommendation:** serve the API same-origin under `book.jesspace.studio/api` through nginx. That is how the local build works.
- **D8 `studio_id` on every table** adds a column with no tenant isolation behind it (no row-level security or tenant guard). That's YAGNI for a single studio, so it is left out. Adding it later is one migration.
- **Calendar default.** L2-5.1.3 says the default is the "primary" calendar, but D9 and Q12 decided on **"Jessie"**. App events get a private extended property `jesBooking=<id>` so they can be told apart from manual ones.
- FR numbering skips FR-19. The Settings model has no `studio_phone`. US-02.3 hides the adjustment from Staff, but nothing says whether Staff can set a DP (assumed yes).
- **No-show:** only Confirmed bookings can be cancelled. A no-show is noticed after the end time, while the booking is still Confirmed and listed under "To close", so cancelling with reason "No-show" still works.

### Open questions that still block go-live (from PRD §10.3)

Q2 (opening hours and buffer per weekday), Q5 (DP rule), Q9 (photographer fees per session or per hour), Q11 (import of Jan–Oct history), Q12 (clean-up of manual events). The seed data uses reasonable defaults for each one, marked `TODO(Q#)`.

## 3. Build plan

### Architecture (local Docker)

```
browser ──► web (nginx :8080) ──/api──► api (NestJS :3000) ──► db (PostgreSQL 18)
                                         worker (same image) ──┘   │ LISTEN gcal_outbox
                                                └──► Google Calendar API (when connected)
```

| Area | TD says | This build | Why |
|---|---|---|---|
| Monorepo | pnpm + Turborepo, apps/web, apps/api | npm workspaces: `frontend/`, `backend/`, `shared/` | pnpm isn't installed on this Mac, and you had already created `frontend/` and `backend/` |
| Data access | Drizzle ORM + drizzle-kit | Plain SQL migrations + `pg` | The design leans on Postgres-specific features (exclusion constraints, triggers, `uuidv7()`, NOTIFY), and these are clearer in raw SQL. Drizzle can be added later. |
| Jobs | pg-boss | Outbox table + LISTEN/NOTIFY + a daily loop | See the critique above |
| Files | Alibaba OSS | Docker volume `files` | Local only. A storage interface makes OSS a drop-in replacement. |
| Everything else | — | As in the TD: NestJS 11, React 19, Vite, Tailwind 4, TanStack Query, Zod, pdfmake, argon2id, JWT + rotating refresh cookie, googleapis | — |

### Milestones

1. **Foundation.** Workspace, shared package (pricing, money and date helpers, Zod schemas, template renderer), Docker Compose, migrations and seed (current price list, photographers, add-ons, categories, templates, owner and staff users).
2. **Booking core.** Auth and roles. Masters CRUD. Availability. Create, edit, cancel and complete a booking, with snapshots, history, revisions, idempotency and If-Match.
3. **Communicate.** PDF invoice (A5), WhatsApp templates with copy and wa.me.
4. **Money.** Expenses with receipts, photographer and MUA fee drafts, recurring drafts, recap (billed or collected), CSV/PDF export, month close and reopen.
5. **Calendar.** OAuth connect, calendar picker, outbox worker with backoff 30 s → 2 m → 10 m → 1 h, Retry, Resync all. **Needs a Google OAuth client** (`GOOGLE_CLIENT_ID/SECRET` in `.env`). Without it the app runs in "Not connected" mode, which is allowed by US-29.10.
6. **Frontend.** Login, Home, Schedule (week strip + day grid), Bookings, New/Edit booking with a sticky total, Booking detail, Finance, Recap, Admin. Mobile-first with a bottom tab bar, in Bahasa Indonesia.
7. **Verify.** The pricing unit tests use the §6.3 examples. API smoke tests cover double booking (409), snapshot, revision, fee draft and recap. Then a click-through in the browser at 390 px.

### Not in this local build

Staging and production infrastructure (ECS, RDS, OSS, CI/CD, SLS, Sentry), the English UI toggle, Google sign-in for app login, and the Phase 2 items (FR-27/28 trend and margin).

## 4. Build status (1 Nov 2026, local Docker)

| Area | State | Verified by |
|---|---|---|
| Pricing (§6.2–6.3) | Done | 7 unit tests (all §6.3 examples) |
| Bookings: create/edit/reschedule/cancel/complete, snapshot, revisions, history, idempotency, If-Match, DB-level no-overlap | Done | API smoke test (23 checks), including 3 parallel saves of the same slot (one wins) |
| Roles (Owner/Staff) | Done | Smoke test: Staff gets 403 on finance/admin, adjustment ignored, no past dates |
| PDF invoice (A5) and WhatsApp templates | Done | PDF rendered and inspected (23 KB); message and wa.me link in the browser |
| Expenses, fee drafts, recurring drafts, recap (billed/collected), CSV/PDF, month close/reopen | Done | Smoke test; worker created the November Internet draft |
| Google Calendar sync (outbox, backoff, reconnect, resync) | **Code complete, not tested against Google** | Needs an OAuth client in `.env` |
| Mobile UI (all screens S1–S19) | Done | Clicked through at 375 px: login, new booking, detail, WhatsApp, invoice, schedule, recap |
| PWA install / service worker | Built | **Not verified.** The preview browser blocks service workers; test on a phone |

Further findings during the build:

- **Template line removal (§9.3).** The PRD's default template puts `{type}` and `{photographer}` on one line. Line removal would then drop the type for Studio Only bookings, so the default template puts them on separate lines.
- **Inline PDF preview (S7).** An embedded PDF does not render on Android Chrome. The preview sheet shows a summary plus Download, Share and Open PDF instead.
