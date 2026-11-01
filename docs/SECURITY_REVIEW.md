# Security architecture review and penetration test — JES Studio Booking

| | |
|---|---|
| Date | 1 Nov 2026 |
| Scope | Local Docker stack (nginx web, NestJS API and worker, PostgreSQL 18), source at `981ff9a`, configs in `infra/` and `docker-compose.yml` |
| Method | Architecture and code review (white box), plus an automated pen test run from the outside with knowledge of the code (grey/white box): [`backend/test/security.mjs`](../backend/test/security.mjs), raw results in [`test-results/security.json`](test-results/security.json) |
| Out of scope | Live Google OAuth (not configured), production infrastructure (ECS, RDS, OSS, TLS) which doesn't exist yet, and social engineering |

> **Status, 1 Nov 2026 (later the same day): all 18 findings are fixed and re-tested, and the pen test passes 56/56.**
> See §6 Remediation. Sections 1–5 below are kept as the original assessment.

## 1. Summary

**56 attack cases: 38 defended, 18 findings.** One finding is High, 9 are Medium, 5 are Low and 3 are informational. No Critical issues. Stored XSS was also checked by hand in the browser and is defended.

The core design is sound:

- SQL is fully parameterised; 40 injection probes produced no error, leak or delay.
- Every route checks the role on the server, and the 22 Owner-only endpoints all refused Staff.
- Server-owned fields (status, total, paid amount, booking number) can't be set from the request body.
- Passwords use Argon2id; refresh tokens are rotated and reuse kills the whole session; the Google token is encrypted with AES-GCM.
- Uploads are checked by their actual content, not their declared type.
- The browser-facing headers are strict.

**Most of the findings sit at the edges**: what gets logged, what the local Docker setup exposes, rate limiting, and two gaps in token and role scoping. All 18 are cheap to fix.

### Fix first

1. **SEC-G10 (High).** Refresh tokens are being written to the API logs.
2. **SEC-A6 (Medium).** The Google OAuth `state` token is accepted as an API access token.
3. **SEC-B4 (Medium).** Staff can rewrite recorded payments.
4. **SEC-A8 / E5 / G1 (Medium).** The API (:3000) and database (:5433) are published on every network interface, which also lets anyone bypass the login lockout.
5. **SEC-F1 / A9 (Medium).** There's no API rate limit (the TD requires 120 requests/min) and no global login throttle.

## 2. Architecture review

### 2.1 Assets

| Asset | Sensitivity |
|---|---|
| Client names and WhatsApp numbers (personal data) | High: privacy (PRD NFR-04) |
| Revenue, expenses and receivables | High: business confidential, integrity matters for the recap |
| Owner session (refresh cookie, 30 days) | High: full control |
| Google Calendar refresh token | High: writes to the studio calendar |
| Bank details (shown on invoices) | Medium: integrity (payment redirection fraud) |
| Receipts (photos and PDFs) | Medium |

### 2.2 Trust boundaries and data flow

```
Phone browser ──HTTPS(prod)──► nginx :8080 ──► API :3000 ──► PostgreSQL :5432
   access JWT in memory            │ CSP, XFO,       │ AuthGuard + roles        ▲
   refresh cookie (httpOnly)       │ nosniff          │ Zod validation           │ LISTEN/NOTIFY
                                   │                  ▼                          │
                                   │            files volume (receipts)     worker ──► Google Calendar API
                                   │                                              (OAuth refresh token, AES-GCM at rest)
  ⚠ dev compose also publishes API :3000 and DB :5433 on 0.0.0.0, bypassing nginx
```

### 2.3 TD §3.4 controls: designed vs built

| Control | Status | Evidence |
|---|---|---|
| HTTPS only, HSTS, TLS 1.2+ | ⏳ Production only | Local stack is HTTP; `COOKIE_SECURE` must be `true` behind TLS |
| CSP, X-Frame-Options, nosniff, Referrer-Policy | ✅ (via nginx) / ⚠ not on :3000 | SEC-E3 ✅, SEC-E5 ✘ |
| Argon2id passwords | ✅ | SEC-G4 (m=64 MiB, t=3, p=4) |
| 15-min access JWT in memory, 30-day rotating refresh cookie (httpOnly, SameSite=Strict) | ✅ | SEC-A5, A11, A12; theft detection revokes the family |
| Role guard on every endpoint; Finance/Admin Owner only | ✅ with one gap | SEC-B1 ✅ (22 endpoints), SEC-B4 ✘ |
| Secrets via env, never in git or images | ✅ | SEC-G6, G7 |
| Google refresh token AES-256-GCM | ✅ | Code review: `common/crypto.ts` (random 96-bit IV, auth tag checked) |
| Zod on every body and query; parameterised SQL | ✅ | SEC-C1, C2, B6 |
| Rate limits: login 5/10 min per IP+email | ✅ (through nginx) / ✘ bypassable on :3000 | SEC-A7 ✅, SEC-A8 ✘ |
| Rate limits: API 120 req/min per user | ❌ Not built | SEC-F1 |
| Upload ≤ 5 MB, content sniffed, random keys, signed URLs | ✅ (signed URLs N/A: local volume, streamed only after login) | SEC-D1, D2, D3 |
| Audit: booking history, expense audit | ✅ partial | SEC-G9: no audit for settings, masters, users or logins |

### 2.4 STRIDE summary

| Threat | Main control | Residual risk |
|---|---|---|
| **S**poofing | Argon2id, lockout, rotating refresh tokens, signed JWT | OAuth state accepted as access token (A6); lockout bypass on :3000 (A8); password spraying (A9) |
| **T**ampering | Role guard, Zod, server-side pricing, DB constraints, month-lock trigger | Staff can rewrite payments (B4) |
| **R**epudiation | `booking_history`, `expense_audit` with user and time | No audit trail for admin and settings changes (G9) |
| **I**nformation disclosure | Role-filtered responses, no secrets in API output, generic errors | Refresh tokens in logs (G10); `/ready` internals (F6); nginx version (E4) |
| **D**enial of service | 200 KB body cap, 5 MB uploads, array caps | No API rate limit (F1); unbounded `login_attempts` (F7); 413 reported as 500 (F2) |
| **E**levation of privilege | Least-privilege containers for the API and worker | DB role is a superuser (G3); DB published on the LAN (G1) |

## 3. Findings

Severity is a CVSS-style judgement for this deployment: one studio, a few trusted users, a small number of bookings.

| ID | Severity | Finding | Recommendation |
|---|---|---|---|
| **SEC-G10** | **High** | `pino-http` logs response headers, including `Set-Cookie: jes_rt=…`. Anyone who can read logs (the TD ships them to Alibaba SLS) gets a 30-day Owner session. | Add `res.headers["set-cookie"]` to `redact`, or use a response serializer without headers. Then rotate all sessions (`UPDATE refresh_tokens SET revoked_at=now()`). |
| SEC-A6 | Medium | The OAuth `state` JWT is signed with the same secret and has no type or audience claim. The AuthGuard accepts it as a bearer token (role undefined), which gives Staff-level access for 10 minutes: every booking, client phone numbers, and creating or cancelling bookings. The state appears in URLs: browser history, Google's consent URL and Referer. | Put `typ: 'access'` in access tokens and require it in the guard, or sign the state with a different key. Also reject tokens with no `role`. |
| SEC-B4 | Medium | Staff can call `POST /bookings/:id/payment`, and can complete bookings with any paid amount. This changes revenue, receivables and the Collected-basis recap, which the PRD says are Owner-only. | Make `/payment` Owner-only. For `/complete`, either make it Owner-only or let Staff complete only with the DP already recorded. Decide this together with the PRD. |
| SEC-A8 | Medium | The API is published on `0.0.0.0:3000` with `trust proxy 1`, so a client hitting it directly controls `X-Forwarded-For`. The test bypassed the login lockout: 8 failures from rotating spoofed IPs, then success. | Don't publish :3000 (remove `ports` from `api`). In production only nginx is reachable. Also key the lockout on email alone as a second layer. |
| SEC-E5 / D3 | Medium | The same direct port serves responses with no CSP, nosniff or frame headers. A JPEG/HTML polyglot receipt is served without `nosniff`. | Same fix as A8. Optionally add `helmet()` in Nest as defence in depth. |
| SEC-F1 | Medium | No general API rate limit: 300 requests in about 1 s, none throttled. The TD requires 120 req/min per user. It's an easy way to burn CPU on PDF generation. | `@nestjs/throttler` (per user, or per IP for anonymous requests), plus nginx `limit_req` on `/api/` and stricter limits on `/auth/*` and `*.pdf`. |
| SEC-A9 | Medium | Lockout is per IP+email, so trying one password against 25 accounts was never throttled (password spraying). | Add a global or per-IP limit on failed logins (for example 20/10 min per IP) through the throttler above. |
| SEC-G3 | Medium | The app connects as `jes`, the PostgreSQL **superuser** (`POSTGRES_USER`). Any future SQL injection would become file read/write and `COPY … PROGRAM` (command execution). | Create a `jes_app` role that owns nothing, with DML-only grants, for the API and worker. Keep the superuser for migrations only. |
| SEC-G1 | Medium (dev) | PostgreSQL is published on `0.0.0.0:5433`, so it's reachable from the LAN or Wi-Fi. The password is strong (G2 passed), but this shouldn't be open. | Bind to `127.0.0.1:5433:5432`, or remove the port. The production TD already says private IP only. |
| SEC-C5 | Low | CSV/formula injection: a client named `=HYPERLINK("http://evil…")` is exported unescaped. Google Sheets or Excel evaluates it when the owner opens the recap CSV. | Prefix cells starting with `= + - @ \t \r` with `'` (text cells only, not the Amount column). |
| SEC-G8 | Low | `npm audit` shows 3 high advisories: multer GHSA-q7qp-rjg7-q26m (through `@nestjs/platform-express`) and zod GHSA-mrhx-c7xc-m3w5. Neither is exploitable as used here: no async `fileFilter`, and bodies are capped at 200 KB with array `max()` limits. | Upgrade `@nestjs/platform-express` to the patched release and zod to ≥ 4.6.6. The zod 4 upgrade needs small schema changes. |
| SEC-A13 | Low | A deactivated user's access token keeps working for up to 15 minutes (refresh is blocked). | Accepted risk for a 15-minute token. To close it, check `users.active` in the guard (cache it for a few seconds). |
| SEC-F2 | Low | A body over 200 KB is rejected, but as `500` instead of `413`. That would trigger the TD's ">2 % 5xx" alert. | Map `entity.too.large` to 413 in `AllExceptionsFilter`. |
| SEC-F7 | Low | Every failed login inserts a row, and old rows are purged only when someone logs in successfully. An anonymous flood grows the table without limit. | Purge in the worker every hour (`DELETE … WHERE at < now() - interval '1 day'`). Rate limiting (F1) caps the inflow. |
| SEC-F6 | Info | The public `/ready` endpoint exposes `queueBacklog`. | Return only `{ok}` publicly, and keep details behind auth or an internal port. |
| SEC-E4 | Info | `Server: nginx/1.27.5` reveals the version. | `server_tokens off;` |
| SEC-G5 | Info | The nginx master process runs as root (worker processes don't). | Use `nginxinc/nginx-unprivileged` and listen on 8080. |
| SEC-A12 / A15 / G9 / E3 | Info | `Secure` cookie flag is off locally (config); password policy is length only (≥ 8); no audit of settings, master or user changes; CSP allows inline styles. | Set `COOKIE_SECURE=true` in production. Consider 10+ chars plus a breached-password check. Add an `admin_audit` table. Inline styles can stay. |

## 4. Defended attacks (38)

- **Authentication:**
  - No token → 401 on all 13 data endpoints.
  - JWTs that are forged, `alg:none`, tampered or expired are rejected.
  - Brute force through nginx is locked, and a spoofed `X-Forwarded-For` is ignored there.
  - No account enumeration: same message, and 25 ms vs 25 ms response time.
  - Refresh-token replay after rotation revokes the whole session family.
  - Logout, password change and deactivation revoke refresh sessions.
  - Weak passwords are rejected.
- **Authorization:**
  - All 22 Owner-only endpoints return 403 for Staff with no data.
  - Staff can't promote themselves.
  - Staff can't see a booking's linked costs or margin.
  - Staff can't set an adjustment, even by crafting the request.
  - Server-owned fields can't be set from the body (mass assignment).
  - Idempotency keys are scoped per user.
  - Secrets never appear in API output.
- **Injection:**
  - 5 SQL payloads × 8 parameters: no error, leak or delay.
  - Path IDs are UUID-validated.
  - Stored XSS is rendered as text (checked in the browser on both detail and list).
  - Template placeholders inside client data aren't expanded.
  - CR/LF in a client name can't inject headers into the PDF download.
  - wa.me parameters are encoded.
- **Uploads:**
  - HTML, SVG and shell scripts are rejected even when labelled as images.
  - 6 MB uploads are rejected.
  - Uploaded file names are ignored; files get random keys.
- **Browser:**
  - No CORS access for foreign origins.
  - CSRF fails because the cookie alone isn't enough: every change needs the Bearer token.
  - CSP, `X-Frame-Options: DENY`, nosniff and Referrer-Policy are present through nginx.
  - The OAuth callback rejects a forged state and can't be used as an open redirect.
- **Errors and DoS:**
  - No stack traces and no `X-Powered-By`.
  - PDF generation requires login.
  - Oversized arrays are rejected in milliseconds.
- **Infrastructure:**
  - Default database credentials are refused.
  - No secrets are baked into images.
  - Secrets are strong (≥ 256-bit JWT secret, 32-byte encryption key).
  - The API and worker run as the non-root `node` user.
  - Booking and expense audit trails exist.

## 5. Re-test

```bash
node backend/test/security.mjs     # 56 cases; a PASS means the attack was defended
```

Fixing the 18 findings should turn the run fully green. The checks for A8, E5 and G1 pass once the ports are no longer published.

## 6. Remediation (all 18 fixed, re-tested 56/56)

| ID | Fix | Where |
|---|---|---|
| SEC-G10 | `pino-http` redacts `res.headers["set-cookie"]` as well as the request auth and cookie headers. All existing refresh sessions were revoked after deploying (46 rows). | `backend/src/main.ts` |
| SEC-A6 | Access tokens carry `typ: "access"` and `aud: "jes-api"`, pinned to HS256. The guard rejects anything else, including tokens with no valid role. The OAuth state uses its own audience, `jes-gcal-state`. | `common/http.ts`, `google.service.ts` |
| SEC-B4 | `POST /bookings/:id/complete` and `/payment` are Owner-only. The UI hides "Tandai selesai" and "Catat pembayaran" and the "Perlu ditutup" list from Staff. | `bookings.controller.ts`, `BookingDetail.tsx`, `Home.tsx` |
| SEC-A8 | The API port is no longer published (`expose` only), so X-Forwarded-For can only come from nginx. New per-account lockout: 10 failures in 15 min from any mix of IPs. | `docker-compose.yml`, `auth.controller.ts`, migration `003` |
| SEC-E5 / D3 | Same as above, plus the API sets its own `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `CORP` and `CSP default-src 'none'`. nginx adds the web-app headers only to non-API locations, so no header is sent twice. | `common/rate-limit.ts`, `infra/nginx/*` |
| SEC-F1 | Rate limiter: 120 req/min per user (TD §3.4), 60/min per IP for anonymous calls, 10 login attempts/min per IP. Replies `429 RATE_LIMITED` with `Retry-After` and `RateLimit-*` headers. Kept in memory, which suits the single API instance; a second replica would need a shared store. | `common/rate-limit.ts` |
| SEC-A9 | At most 20 failed logins per IP per 10 min, whatever the account. | `auth.controller.ts` |
| SEC-G3 | A one-shot `migrate` service runs migrations, seed and role setup with the owner account. The API and worker connect as `jes_app`: not superuser, no CREATE or TRUNCATE, DML only, and `booking_history` / `expense_audit` are append-only. The owner password is no longer in the API or worker environment. | `backend/src/migrate.ts`, `docker-compose.yml` |
| SEC-G1 | PostgreSQL is published on `127.0.0.1:5433` only. | `docker-compose.yml` |
| SEC-C5 | CSV text cells starting with `= + - @ TAB CR` get a `'` prefix. Numbers are untouched. | `finance.controller.ts` |
| SEC-G8 | zod 3 → **4.6.7** in all three packages; multer → **2.5.0** (an npm override applies it to Nest's copy too). `npm audit --omit=dev`: **0 vulnerabilities**. | `package.json` files, lockfile |
| SEC-A13 | The guard re-checks `users.active` and the role, cached for 5 s. Deactivating a user clears the cache, so the lockout is immediate. | `common/http.ts`, `masters.controller.ts` |
| SEC-F2 | A body-size error maps to `413 TOO_LARGE` instead of 500. | `common/http.ts` |
| SEC-F7 | The in-memory login limit closes the parallel-burst race. The worker purges `login_attempts` older than a day (and idempotency keys older than 7 days) every hour. | `rate-limit.ts`, `worker.ts` |
| SEC-F6 | Public `/ready` returns `{ ok }` only. Queue depth stays behind Owner auth. | `integrations.controller.ts` |
| SEC-E4 | `server_tokens off`. | `infra/nginx/default.conf` |
| SEC-G5 | `nginxinc/nginx-unprivileged`; the whole web container runs as `nginx` on port 8080. | `infra/web.Dockerfile` |

### Issue found and fixed during remediation

The first attempt to force multer 2.5.0 meant hand-editing `package-lock.json`. That left multer's nested `type-is@1.6.18` resolving the top-level `media-typer@1.1.1` instead of its own `0.3.0`, so every upload was treated as non-multipart and **receipt upload broke**. The functional suite caught it (US-22.1, EDGE-22a). The subtree was reinstalled cleanly, and the fixed state was verified in the image before the final test run.

### Final verification

| Suite | Result |
|---|---|
| Pricing unit tests | 7/7 |
| Smoke (API) | 23/23 |
| Functional | 146 cases: 137 pass, 0 fail, 9 need Google OAuth |
| Penetration test | **56/56 defended** |
| Browser | Login, reload persistence, Owner recap, no CSP violations |

### Operational notes from the fixes

- All traffic from one network shares the per-IP login limits. An office NAT would therefore lock logins for 10 minutes after 20 failed attempts, which is unlikely in normal use. The test suites reset the throttle at start (`DELETE FROM login_attempts`).
- If the API is ever scaled to more than one replica (TD §3.2 proposes two), move the rate-limit counters to a shared store first.
- For production: set `COOKIE_SECURE=true` behind TLS, add HSTS on the TLS server block, and keep `migrate` as a separate step in the CI/CD deploy (TD §3.3).
