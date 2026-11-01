# Functional test report — JES Studio Booking

| | |
|---|---|
| Run | 1 Nov 2026, against the local Docker stack (`http://localhost:8080`, through nginx) |
| Build | `981ff9a` plus the test files |
| Suite | [`backend/test/functional.mjs`](../backend/test/functional.mjs), raw results in [`test-results/functional.json`](test-results/functional.json) |
| Re-run | `node backend/test/functional.mjs` (creates data, so use a dev database only; it cleans up after itself) |

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
