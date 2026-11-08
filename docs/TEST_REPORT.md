# Functional test report — JES Studio Booking

| | |
|---|---|
| Run | 1 Nov 2026, against the local Docker stack (`http://localhost:8080`, through nginx) |
| Build | `981ff9a` plus the test files |
| Suite | [`backend/test/functional.mjs`](../backend/test/functional.mjs), raw results in [`test-results/functional.json`](test-results/functional.json) |
| Re-run | `node backend/test/functional.mjs` (creates data, so use a dev database only; it cleans up after itself) |

## Round 2: before the GCP deployment (8 Nov 2026)

| Suite | What it drives | Cases | Result |
|---|---|---:|---|
| Pricing unit tests (`npm test`) | `shared/pricing` | 7 | **7 pass** |
| API smoke (`backend/test/smoke.mjs`) | REST API through nginx | 23 | **23 pass** |
| Backend functional (`backend/test/functional.mjs`) | every user story ±, dashboard, **user management** | 169 | **160 pass, 0 fail**, 9 need Google OAuth |
| Frontend E2E (`frontend`: `npx playwright test`) | real UI in mobile Chromium (Pixel 7) | 48 | **48 pass** |

**Frontend E2E coverage** ([`frontend/e2e`](../frontend/e2e)):

- **Login and session:** wrong password, empty form, redirect when signed out, reload keeps you signed in, logout, show/hide password, Staff navigation.
- **New booking:** Save disabled until the form is valid, inline phone error, live total and balance, booking number on save, a taken slot hidden and a manual clash named.
- **Booking detail:** WhatsApp message and `wa.me` link, invoice download, edit creates R1, cancel without and with a reason, completing a past session.
- **Schedule:** tapping an empty slot opens a pre-filled form; search finds and misses as expected.
- **Dashboard:** hero figure, charts, month tooltip, table view, period and basis switches.
- **Expenses and recap:** validation, Rp formatting, create and delete, CSV download.
- **Admin:** duplicate name, invalid opening hours, unknown template placeholder.
- **Users:** register with password hints, mismatched confirmation, duplicate email, edit and promote, protections on your own account, remove.
- **Account:** wrong current password, successful change, rename.
- **Staff restrictions:** 6 Owner-only URLs blocked, no adjustment field, no past dates, no "Tandai selesai".
- **Layout:** no horizontal scroll at 360 px and 430 px; dark mode.

**User-management cases** (USER-01 to USER-16): register; weak password rules; duplicate email in any letter case; edit and promote (sessions end); Owner password reset; deactivate and reactivate; protections on your own account; remove (immediate effect, history keeps the name); re-register a removed email; unknown and invalid ids; Staff refused on all user endpoints; self-service rename (no role escalation); password-change rejections and lockout; a successful change signs out other devices; audit rows; concurrent Owner demotions.

### Findings from functional testing (all fixed and re-tested)

| # | Found by | Finding | Fix |
|---|---|---|---|
| F-1 | E2E | Several page loads from one IP (e.g. a studio Wi-Fi) hit the anonymous rate limit on `/auth/refresh`, and **the app signed the user out**. | Refresh is limited per session; the client waits for `Retry-After` instead of logging out. |
| F-2 | E2E | Admin and template form labels weren't connected to their inputs, so screen readers announced unnamed fields (NFR-07). | `Field` now ties its label (and error message) to the control automatically, across every form. |
| F-3 | Backend | Two Owners demoting each other at once could leave no Owner. | Ordered row locking in a single statement. |
| F-4 | E2E (console) | The CSP blocked fonts that Vite had inlined as `data:` URIs, so some text used a fallback font. | Fonts are never inlined. |
| F-5 | E2E | Settings errors were shown twice (in the field and in a toast). | Kept on purpose (the toast confirms the failed save); the test was adjusted. |
| F-6 | E2E | Search pulled the digits out of *any* query and matched them against phone numbers, so "Lilin 2026" could match a phone containing 2026. | Phone matching only for phone-shaped queries, in booking search and client suggestions (EDGE-12a). |
| F-7 | E2E | The booking list showed a blank page when the request failed. | Error banner with "Coba lagi". |

Re-run everything: `npm test`, `node backend/test/smoke.mjs`, `node backend/test/functional.mjs`, `(cd frontend && npx playwright test)`. Leave about a minute between suites. They all sign in as the same Owner from one machine, so running them back to back can trip the production rate limits (120 requests per minute per user, 10 logins per minute per IP). That's the limits working, not a bug.

---
*Round 1 (1 Nov 2026) follows.*

## Result

**146 API cases: 137 passed, 0 failed, 9 not executable.** (Re-run after the security fixes; that run added EDGE-15b: Staff cannot complete bookings or record payments.) Another **6 UI checks passed** in the browser at 375 px.

The 145 cases split into 67 positive (+) and 78 negative (−) scenarios. Every user story US-01 to US-29 is covered, plus 20 edge cases the PRD implies but doesn't list (EDGE-xx, BR-xx). The 9 cases that couldn't run all need a real Google account and OAuth client.

| Area | + | − | Pass | Fail | Not run |
|---|---:|---:|---:|---:|---:|
| Access: US-01 login, US-02 staff | 3 | 8 | 11 | 0 | 0 |
| Create booking: US-03 to US-11 | 14 | 24 | 38 | 0 | 0 |
| Manage bookings: US-12 to US-15 | 10 | 8 | 18 | 0 | 0 |
| Invoice and WhatsApp: US-16, US-17 | 7 | 4 | 11 | 0 | 0 |
| Admin: US-18 to US-21 | 8 | 9 | 17 | 0 | 0 |
| Expenses and fees: US-22 to US-25 | 7 | 9 | 16 | 0 | 0 |
| Recap, export, close: US-23, US-26, US-27 | 10 | 7 | 17 | 0 | 0 |
| Google Calendar: US-28, US-29 | 8 | 9 | 8 | 0 | 9 |
| **Total** | **67** | **78** | **136** | **0** | **9** |

## What the suite proves (highlights)

- **Pricing.** Every PRD §6.3 worked example gives the exact total. Add-ons priced per hour, per booking and per person are all correct.
- **No double booking.** Five simultaneous saves of the same slot give exactly one success and four "slot taken" errors. The 30-minute buffer and the after-hours, closed-day and slot-grid rules all hold.
- **Snapshots.** Changing a master price never changes existing bookings. When editing, the owner chooses whether to keep the old prices or apply the new ones.
- **Revisions.** Changes visible on the invoice create R1, R2 and so on. A notes-only edit doesn't. A reschedule keeps the booking number and the Reschedule template shows the old and new times.
- **Concurrency.** A retry with the same Idempotency-Key never creates a duplicate. Saving with an out-of-date version (If-Match) returns `409 STALE`.
- **Roles.** Staff gets `403` and no data on all 15 Owner-only endpoints. A price adjustment sent by Staff is ignored. Staff cannot pick past dates or edit Completed bookings.
- **Finance.** The monthly recap reconciles to the rupiah: revenue by type + add-ons + adjustments = total, and drafts are excluded and reported. The receivables, Collected basis, loss month, empty month and the CSV layout all checked out.
- **Month close.** Bookings and expenses in a closed month can't be changed in any way: edit, add, pay, or reschedule into or out of the month. Reopening needs a reason.
- **Calendar resilience (simulated outage).** A booking saves in 7 ms with status Pending. Retries back off from 30 s, then end in Failed with the error shown. Retry re-queues the booking, a cancel queues a calendar delete, and an edit replaces the queued job.

## UI checks (browser, 375 px)

| Check | Story | Result |
|---|---|---|
| Staff menu shows Home · Schedule · + · Bookings · Account (no Finance or Admin) | US-02.1 | Pass |
| Staff opening `/admin/settings` or `/finance` sees "Anda tidak memiliki akses" and no data | US-02.2 | Pass |
| Price-adjustment field is hidden for Staff | US-02.3 | Pass |
| Duration "−" is disabled at 1 hour | US-04.3 | Pass |
| Date picker blocks past dates for Staff | US-05.5 | Pass |
| Save stays disabled until the form is valid | US-11 / §8.4 | Pass |

Already checked in earlier sessions: the live total, client suggestions, the WhatsApp sheet, the invoice sheet, the schedule grid, the recap screen, and light/dark mode.

## Not executable (9)

US-28.1, 28.2, 28.3, 28.5 and US-29.1, 29.3, 29.5, 29.8, 29.9. These need Google consent, real event create/patch/delete calls, and token revocation. They become runnable once `GOOGLE_CLIENT_ID/SECRET` are set and a **test** calendar is connected.

## Observations (not failures)

1. **A booking can be marked Completed before its session has happened.** The PRD only shows bookings under "To close" after they end, but doesn't forbid early completion. The fee draft is then dated in the future. Consider blocking completion until the start time has passed.
2. **Staff can mark bookings Completed and record payments.** The PRD's role table is silent on this. Because it changes revenue figures, the security review lists it as a finding (SEC-B4).
