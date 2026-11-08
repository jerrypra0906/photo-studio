// Penetration test — grey/white-box, against the LOCAL dev stack only.
// A PASS means the attack was defended; a FAIL is a finding. Usage: node backend/test/security.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import jwt from 'jsonwebtoken';
import { ENV, OWNER, STAFF, api, login, resetLoginThrottle, runner, sleep, sql } from './lib.mjs';

const R = runner('security');
resetLoginThrottle();
const DIRECT = 'http://localhost:3000/api/v1';
const directReachable = await fetch(`${DIRECT}/health`).then(() => true, () => false);
// tokens shaped exactly like the app's own (typ/aud), so each case tests only the property it names
const accessLike = (claims, opts = {}) => jwt.sign({ typ: 'access', ...claims }, ENV.JWT_SECRET, { audience: 'jes-api', ...opts });
const owner = await login(OWNER);
const staff = await login(STAFF);
const me = (await api(owner, 'GET', '/auth/me')).data;
const run = Date.now().toString(36);
const types = (await api(owner, 'GET', '/booking-types')).data;
const SO = types.find((t) => t.name === 'Studio Only');
const day = () => `20${50 + Math.floor(Math.random() * 40)}-0${1 + Math.floor(Math.random() * 9)}-1${Math.floor(Math.random() * 9)}`;
const tempUser = async (role = 'STAFF') => {
  const u = { email: `sec-${run}-${Math.random().toString(36).slice(2, 7)}@jes.local`, password: 'Sec-Test-Pass-1' };
  const r = await api(owner, 'POST', '/users', { name: 'Sec test', ...u, role });
  return { ...u, id: r.data.id };
};
const cleanupBookings = [];

// =====================================================================
R.area('A. Authentication & session');
const PROTECTED = ['/bookings', '/schedule?from=2026-01-01&to=2026-01-02', '/clients?q=ab', '/settings', '/templates', '/booking-types', '/photographers', '/addons', '/expenses', '/users', '/reports/recap?month=2026-01', '/integrations/google', '/auth/me'];
await R.test('SEC-A1', '−', `All ${PROTECTED.length} data endpoints refuse anonymous requests (401)`, async () => {
  for (const p of PROTECTED) assert.equal((await api(null, 'GET', p)).status, 401, p);
});
await R.test('SEC-A2', '−', 'JWT signed with a different secret is rejected', async () => {
  const t = jwt.sign({ sub: me.id, role: 'OWNER', name: 'x', email: 'x' }, 'not-the-secret');
  assert.equal((await api(t, 'GET', '/users')).status, 401);
});
await R.test('SEC-A3', '−', 'Unsigned JWT (alg: none) is rejected', async () => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const t = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: me.id, role: 'OWNER' })}.`;
  assert.equal((await api(t, 'GET', '/users')).status, 401);
});
await R.test('SEC-A4', '−', 'Tampered payload (Staff token edited to role OWNER, original signature) is rejected', async () => {
  const [h, p, s] = staff.split('.');
  const body = JSON.parse(Buffer.from(p, 'base64url'));
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...body, role: 'OWNER' })).toString('base64url')}.${s}`;
  assert.equal((await api(forged, 'GET', '/users')).status, 401);
});
await R.test('SEC-A5', '−', 'Expired access token is rejected', async () => {
  const t = accessLike({ sub: me.id, role: 'OWNER', name: me.name, email: me.email, exp: Math.floor(Date.now() / 1000) - 10 });
  assert.equal((await api(t, 'GET', '/users')).status, 401);
});
await R.test('SEC-A6', '−', 'Token confusion: the Google OAuth "state" token cannot be used as an API access token', async () => {
  // state = jwt.sign({ sub, p: 'gcal' }) with the same secret; it travels in URLs (browser history, Google logs, Referer)
  const state = jwt.sign({ sub: me.id, p: 'gcal' }, ENV.JWT_SECRET, { expiresIn: '10m', audience: 'jes-gcal-state' });
  // also without audience, as the pre-fix code issued it
  assert.equal((await api(jwt.sign({ sub: me.id, p: 'gcal' }, ENV.JWT_SECRET, { expiresIn: '10m' }), 'GET', '/bookings')).status, 401);
  const r = await api(state, 'GET', '/bookings');
  const pii = await api(state, 'GET', '/clients?q=62');
  assert.equal(r.status, 401, `state token accepted as bearer: GET /bookings → ${r.status}, GET /clients → ${pii.status} (${Array.isArray(pii.data) ? pii.data.length : 0} client phone numbers)`);
});
await R.test('SEC-A7', '−', 'Login brute force: 6th attempt locked (via nginx, X-Forwarded-For spoofing ignored)', async () => {
  const u = await tempUser();
  for (let i = 0; i < 5; i++) await api(null, 'POST', '/auth/login', { email: u.email, password: 'x' }, { 'x-forwarded-for': `10.0.0.${i}` });
  const r = await api(null, 'POST', '/auth/login', u, { 'x-forwarded-for': '10.9.9.9' });
  assert.equal(r.status, 429);
});
await R.test('SEC-A8', '−', 'Login brute force cannot be bypassed by rotating source IPs (API not exposed; per-account lockout)', async () => {
  assert.equal(directReachable, false, 'API :3000 is directly reachable, so X-Forwarded-For can be spoofed');
  // simulate a distributed attack: 10 failures for one account from 10 different IPs
  const u = await tempUser();
  sql(`INSERT INTO login_attempts (key) SELECT '198.51.100.' || g || '|' || '${u.email}' FROM generate_series(1, 10) g`);
  const r = await api(null, 'POST', '/auth/login', u);
  assert.equal(r.status, 429, `correct password after 10 failures from 10 IPs → ${r.status}`);
});
await R.test('SEC-A9', '−', 'Password spraying: many accounts × 1 password is throttled globally', async () => {
  const statuses = [];
  for (let i = 0; i < 25; i++) statuses.push((await api(null, 'POST', '/auth/login', { email: `spray${i}-${run}@jes.local`, password: 'Password123!' }, { __noRetry: true })).status);
  assert.ok(statuses.includes(429), `25 attempts against 25 accounts: ${statuses.filter((s) => s === 429).length} throttled`);
});
resetLoginThrottle();
await R.test('SEC-A10', '−', 'No account enumeration: same message and similar timing for existing vs unknown email', async () => {
  const t = async (email) => { const r = await api(null, 'POST', '/auth/login', { email, password: 'wrong' }); return [r.data.message, r.ms]; };
  const u = await tempUser();
  const known = [], unknown = [];
  for (let i = 0; i < 4; i++) { known.push(await t(u.email)); unknown.push(await t(`ghost${i}-${run}@jes.local`)); }
  assert.equal(known[0][0], unknown[0][0]);
  const avg = (a) => a.reduce((s, x) => s + x[1], 0) / a.length;
  const diff = Math.abs(avg(known) - avg(unknown));
  assert.ok(diff < 60, `timing gap ${diff.toFixed(0)} ms`);
  return `avg ${avg(known).toFixed(0)} ms vs ${avg(unknown).toFixed(0)} ms`;
});
await R.test('SEC-A11', '−', 'Refresh-token theft: replaying a rotated token after the grace window kills the whole session family', async () => {
  const l = await api(null, 'POST', '/auth/login', OWNER);
  const c1 = l.headers.get('set-cookie').split(';')[0];
  const r2 = await api(null, 'POST', '/auth/refresh', undefined, { cookie: c1 });
  const c2 = r2.headers.get('set-cookie').split(';')[0];
  await sleep(31_000);
  assert.equal((await api(null, 'POST', '/auth/refresh', undefined, { cookie: c1 })).status, 401, 'old token replay');
  assert.equal((await api(null, 'POST', '/auth/refresh', undefined, { cookie: c2 })).status, 401, 'legit token also revoked');
});
await R.test('SEC-A12', '−', 'Refresh cookie is HttpOnly, SameSite=Strict, scoped to /api/v1/auth', async () => {
  const c = (await api(null, 'POST', '/auth/login', OWNER)).headers.get('set-cookie');
  assert.match(c, /HttpOnly/i); assert.match(c, /SameSite=Strict/i); assert.match(c, /Path=\/api\/v1\/auth/);
  return /;\s*Secure/i.test(c) ? 'Secure set' : 'Secure flag off (COOKIE_SECURE=false for local http) — must be true in production';
});
await R.test('SEC-A13', '−', 'Deactivating a user ends their access immediately', async () => {
  const u = await tempUser();
  const t = await login(u);
  await api(owner, 'PATCH', `/users/${u.id}`, { name: 'Sec test', email: u.email, role: 'STAFF', active: false });
  const r = await api(t, 'GET', '/bookings');
  assert.equal(r.status, 401, `deactivated user's access token still works → ${r.status} (valid up to 15 min)`);
});
await R.test('SEC-A14', '−', 'Password change revokes existing refresh sessions', async () => {
  const u = await tempUser();
  const c = (await api(null, 'POST', '/auth/login', u)).headers.get('set-cookie').split(';')[0];
  await api(owner, 'PATCH', `/users/${u.id}`, { name: 'Sec test', email: u.email, role: 'STAFF', active: true, password: 'New-Pass-123456' });
  assert.equal((await api(null, 'POST', '/auth/refresh', undefined, { cookie: c })).status, 401);
});
await R.test('SEC-A15', '−', 'Weak passwords are rejected for new users (min length)', async () => {
  const r = await api(owner, 'POST', '/users', { name: 'weak', email: `weak-${run}@jes.local`, password: '1234567', role: 'STAFF' });
  assert.equal(r.status, 400);
  return 'min 8 chars; no complexity/breached-password check';
});

// =====================================================================
R.area('B. Authorization (vertical / horizontal)');
const OWNER_ONLY = [
  ['GET', '/expenses'], ['GET', '/expense-categories'], ['GET', '/users'], ['GET', '/reports/recap?month=2026-10'], ['GET', '/reports/recap.csv?month=2026-10'],
  ['GET', '/reports/recap.pdf?month=2026-10'], ['GET', '/reports/trend'], ['GET', '/integrations/google'], ['GET', '/integrations/google/auth-url'], ['POST', '/integrations/google/resync'],
  ['POST', '/integrations/google/disconnect'], ['PUT', '/integrations/google/calendar', { calendarId: 'x' }], ['POST', '/booking-types', {}], ['DELETE', `/booking-types/${SO.id}`],
  ['POST', '/photographers', {}], ['POST', '/addons', {}], ['POST', '/expense-categories', {}], ['PUT', '/settings', {}], ['PUT', '/templates/NEW', { body: 'x' }],
  ['POST', '/users', {}], ['PATCH', `/users/${me.id}`, {}], ['DELETE', `/users/${me.id}`], ['POST', '/reports/months/2020-01/close'], ['POST', '/reports/months/2020-01/reopen', { reason: 'xxx' }],
];
await R.test('SEC-B1', '−', `Staff → ${OWNER_ONLY.length} Owner-only endpoints all return 403 with no data`, async () => {
  for (const [m, p, b] of OWNER_ONLY) {
    const r = await api(staff, m, p, b);
    assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
    assert.deepEqual(Object.keys(r.data).sort(), ['code', 'message']);
  }
});
await R.test('SEC-B2', '−', 'Staff cannot promote themselves (PATCH own user → 403)', async () => {
  const sme = (await api(staff, 'GET', '/auth/me')).data;
  assert.equal((await api(staff, 'PATCH', `/users/${sme.id}`, { name: 'x', email: sme.email, role: 'OWNER', active: true })).status, 403);
});
let booking;
await R.test('SEC-B3', '−', 'Staff view of a booking hides finance data (linked costs, margin)', async () => {
  booking = (await api(owner, 'POST', '/bookings', { typeId: SO.id, hours: 1, date: day(), startTime: '10:00', clientName: 'Sec target', clientPhone: '081311112222' })).data;
  cleanupBookings.push(booking.id);
  const r = (await api(staff, 'GET', `/bookings/${booking.id}`)).data;
  assert.equal(r.expenses, undefined); assert.equal(r.margin, undefined);
});
await R.test('SEC-B4', '−', 'Staff cannot change recorded payments (finance data) on a completed booking', async () => {
  await api(owner, 'POST', `/bookings/${booking.id}/complete`, { paidAmount: 170000 });
  const r = await api(staff, 'POST', `/bookings/${booking.id}/payment`, { paidAmount: 0 });
  const after = (await api(owner, 'GET', `/bookings/${booking.id}`)).data.paidAmount;
  assert.equal(r.status, 403, `staff reset paid 170.000 → ${after} (HTTP ${r.status}); this changes the Owner's revenue/receivables`);
});
await R.test('SEC-B5', '−', 'Staff cannot set a price adjustment, even by crafting the request', async () => {
  const r = await api(staff, 'POST', '/bookings', { typeId: SO.id, hours: 1, date: day(), startTime: '12:00', clientName: 'Adj', adjustment: -170000, adjustmentReason: 'free' });
  assert.equal(r.data.total, 170000);
  cleanupBookings.push(r.data.id);
});
await R.test('SEC-B6', '−', 'Mass assignment: server-owned fields in the body are ignored (status, total, paid, number, createdBy)', async () => {
  const r = await api(owner, 'POST', '/bookings', { typeId: SO.id, hours: 1, date: day(), startTime: '14:00', clientName: 'Mass', status: 'COMPLETED', total: 1, paidAmount: 999999, bookingNo: 'X', createdBy: 'x', gcalEventId: 'x', version: 99 });
  assert.equal(r.data.status, 'CONFIRMED'); assert.equal(r.data.total, 170000); assert.equal(r.data.paidAmount, 0); assert.equal(r.data.version, 1); assert.equal(r.data.gcalEventId, null);
  cleanupBookings.push(r.data.id);
  const u = await api(owner, 'POST', '/users', { name: 'Role', email: `role-${run}@jes.local`, password: 'Abcdefgh1', role: 'SUPERADMIN' });
  assert.equal(u.status, 400);
});
await R.test('SEC-B7', '−', 'Idempotency keys are per user: Staff reusing Owner\'s key cannot read Owner\'s booking', async () => {
  const key = `sec-idem-${run}`;
  const a = await api(owner, 'POST', '/bookings', { typeId: SO.id, hours: 1, date: day(), startTime: '16:00', clientName: 'Idem owner' }, { 'idempotency-key': key });
  const b = await api(staff, 'POST', '/bookings', { typeId: SO.id, hours: 1, date: day(), startTime: '18:00', clientName: 'Idem staff' }, { 'idempotency-key': key });
  assert.notEqual(a.data.id, b.data.id);
  cleanupBookings.push(a.data.id, b.data.id);
});
await R.test('SEC-B8', '−', 'Secrets are never returned: Google refresh token absent from /settings (Owner and Staff)', async () => {
  for (const t of [owner, staff]) assert.ok(!('gcalRefreshToken' in (await api(t, 'GET', '/settings')).data));
  const users = (await api(owner, 'GET', '/users')).data;
  assert.ok(!JSON.stringify(users).includes('$argon2'), 'password hash returned');
  assert.ok(users.every((u) => !('passwordHash' in u) && !('password' in u)), 'password field returned');
});

// =====================================================================
R.area('B2. User management & session attacks');
await R.test('SEC-U1', '−', 'Staff cannot escalate through the self-service profile (role/email/active in the body are ignored)', async () => {
  const r = await api(staff, 'PATCH', '/auth/me', { name: 'Staf', role: 'OWNER', email: 'pwn@x.io', active: false });
  assert.equal(r.data.user.role, 'STAFF'); assert.equal(r.data.user.email, STAFF.email);
  assert.equal((await api(r.data.accessToken, 'GET', '/users')).status, 403);
});
await R.test('SEC-U2', '−', 'Mass assignment on registration: id, passwordHash, deletedAt, lastLoginAt in the body are ignored', async () => {
  const email = `mass-${run}@jes.local`;
  const r = await api(owner, 'POST', '/users', { name: 'Mass', email, password: 'Mass-Assign-2026', role: 'STAFF', id: '00000000-0000-7000-8000-000000000001', passwordHash: 'x', deletedAt: '2020-01-01', lastLoginAt: '2020-01-01' });
  assert.equal(r.status, 201); assert.notEqual(r.data.id, '00000000-0000-7000-8000-000000000001'); assert.equal(r.data.lastLoginAt, null);
  assert.match(sql(`SELECT password_hash FROM users WHERE email = '${email}'`), /^\$argon2id\$/);
  await api(owner, 'DELETE', `/users/${r.data.id}`);
});
await R.test('SEC-U3', '−', 'Brute-forcing the current password on /auth/password is locked after 5 tries', async () => {
  const u = await tempUser();
  const t = await login(u);
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await api(t, 'POST', '/auth/password', { currentPassword: `guess-${i}`, newPassword: 'Brute-Force-2026' })).status);
  assert.deepEqual(codes.slice(0, 5), [400, 400, 400, 400, 400]); assert.equal(codes[5], 429);
  const right = await api(t, 'POST', '/auth/password', { currentPassword: u.password, newPassword: 'Brute-Force-2026' });
  assert.equal(right.status, 429, 'even the right password is refused while locked');
});
await R.test('SEC-U4', '−', 'Owner password resets must meet the policy too', async () => {
  const u = await tempUser();
  const r = await api(owner, 'PATCH', `/users/${u.id}`, { name: 'Sec test', email: u.email, role: 'STAFF', active: true, password: 'abc' });
  assert.equal(r.status, 400); assert.equal(r.data.fields.password, 'Minimal 10 karakter');
});
await R.test('SEC-U5', '−', 'A removed user loses access at once: access token, refresh cookie and login all fail', async () => {
  const u = await tempUser();
  const l = await api(null, 'POST', '/auth/login', u);
  const cookie = l.headers.get('set-cookie').split(';')[0];
  assert.equal((await api(owner, 'DELETE', `/users/${u.id}`)).status, 204);
  assert.equal((await api(l.data.accessToken, 'GET', '/bookings')).status, 401);
  assert.equal((await api(null, 'POST', '/auth/refresh', undefined, { cookie })).status, 401);
  assert.equal((await api(null, 'POST', '/auth/login', u)).status, 401);
});
await R.test('SEC-U6', '−', 'Audit trails are append-only for the application role (UPDATE/DELETE denied)', async () => {
  const appPw = ENV.APP_DB_PASSWORD;
  const asApp = (q) => { try { return execFileSync('docker', ['compose', 'exec', '-T', '-e', `PGPASSWORD=${appPw}`, 'db', 'psql', '-h', '127.0.0.1', '-U', 'jes_app', '-d', 'jes', '-tA', '-c', q], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return String(e.stderr); } };
  for (const t of ['admin_audit', 'booking_history', 'expense_audit']) {
    assert.match(asApp(`UPDATE ${t} SET id = id WHERE false`), /permission denied/, `${t} UPDATE`);
    assert.match(asApp(`DELETE FROM ${t} WHERE false`), /permission denied/, `${t} DELETE`);
  }
  assert.doesNotMatch(asApp('SELECT count(*) FROM admin_audit'), /permission denied/);
});
await R.test('SEC-U7', '−', 'Refresh flooding with one stolen cookie is throttled per session, without locking out other sessions', async () => {
  const c1 = (await api(null, 'POST', '/auth/login', OWNER)).headers.get('set-cookie').split(';')[0];
  const rs = await Promise.all(Array.from({ length: 40 }, () => api(null, 'POST', '/auth/refresh', undefined, { cookie: c1, __noRetry: true })));
  assert.ok(rs.some((r) => r.status === 429), 'no 429 in 40 parallel refreshes');
  const other = (await api(null, 'POST', '/auth/login', STAFF)).headers.get('set-cookie').split(';')[0];
  assert.equal((await api(null, 'POST', '/auth/refresh', undefined, { cookie: other, __noRetry: true })).status, 200, 'another session is unaffected');
  return `${rs.filter((r) => r.status === 429).length} of 40 throttled`;
});

R.area('C. Injection & output encoding');
const SQLI = ["' OR '1'='1", "'; DROP TABLE bookings;--", "1' UNION SELECT password_hash,1,1 FROM users--", "%' AND pg_sleep(3)--", "\\'; SELECT pg_sleep(3);--"];
await R.test('SEC-C1', '−', `SQL injection: ${SQLI.length} payloads × search/filter params — no error, no leak, no delay`, async () => {
  for (const p of SQLI) {
    const e = encodeURIComponent(p);
    for (const path of [`/bookings?q=${e}`, `/clients?q=${e}`, `/expenses?q=${e}`, `/bookings?status=${e}`, `/bookings?from=${e}`, `/bookings?typeId=${e}`, `/reports/recap?month=${e}`, `/schedule?from=${e}&to=2026-01-01`]) {
      const r = await api(owner, 'GET', path);
      assert.ok(r.status === 200 || r.status === 400, `${path} → ${r.status}`);
      assert.ok(r.ms < 2500, `${path} took ${r.ms} ms (time-based injection?)`);
      assert.ok(!JSON.stringify(r.data).includes('$argon2'), 'hash leaked');
    }
  }
  assert.ok(Number(sql('SELECT count(*) FROM bookings')) > 0, 'bookings table intact');
});
await R.test('SEC-C2', '−', 'SQL injection via path IDs is blocked by UUID validation (400)', async () => {
  for (const p of ["/bookings/1' OR '1'='1", '/bookings/..%2F..%2Fusers']) assert.equal((await api(owner, 'GET', p)).status, 400, p);
  // nginx normalises encoded ../ before proxying: the request falls through to the SPA, never to a file read
  const t = await api(owner, 'GET', '/expenses/..%2F..%2F..%2Fetc%2Fpasswd/receipt');
  assert.ok(!String(t.data).includes('root:x:0:0'), 'file contents returned');
});
let xss;
await R.test('SEC-C3', '−', 'Stored XSS payloads are stored as plain text (rendered escaped by React — checked in browser)', async () => {
  const payload = `<img src=x onerror="window.__xss=1">`;
  xss = (await api(staff, 'POST', '/bookings', { typeId: SO.id, hours: 1, date: day(), startTime: '10:00', clientName: payload.slice(0, 60), notes: '<script>window.__xss=2</script>' })).data;
  cleanupBookings.push(xss.id);
  assert.equal(xss.clientNameSnap, payload.slice(0, 60));
  return `booking ${xss.id}`;
});
await R.test('SEC-C4', '−', 'Template injection: client data containing {placeholders} is not expanded', async () => {
  const b = (await api(owner, 'POST', '/bookings', { typeId: SO.id, hours: 1, date: day(), startTime: '12:00', clientName: '{account_no} {bank_name}' })).data;
  cleanupBookings.push(b.id);
  const t = (await api(owner, 'GET', `/bookings/${b.id}/message?kind=NEW`)).data.text;
  assert.ok(t.includes('Halo kak {account_no} {bank_name}'));
});
await R.test('SEC-C5', '−', 'CSV/formula injection: a client named =HYPERLINK(...) is neutralised in the CSV export', async () => {
  const m = `19${70 + Math.floor(Math.random() * 29)}-0${1 + Math.floor(Math.random() * 9)}`;
  const b = (await api(owner, 'POST', '/bookings', { typeId: SO.id, hours: 1, date: `${m}-10`, startTime: '10:00', clientName: '=HYPERLINK("http://evil.example","x")' })).data;
  const csv = (await api(owner, 'GET', `/reports/recap.csv?month=${m}`)).data.toString('utf8');
  await api(owner, 'POST', `/bookings/${b.id}/cancel`, { reason: 'OTHER' });
  const cell = csv.split('\r\n')[1].split(',')[1];
  assert.ok(!/^"?[=+\-@]/.test(cell), `client cell exported as ${cell} — spreadsheet will evaluate it`);
});
await R.test('SEC-C6', '−', 'Header injection: CR/LF in the client name cannot inject headers into the PDF download', async () => {
  const b = (await api(owner, 'POST', '/bookings', { typeId: SO.id, hours: 1, date: day(), startTime: '14:00', clientName: 'a"\r\nX-Injected: 1' })).data;
  cleanupBookings.push(b.id);
  const r = await api(owner, 'GET', `/bookings/${b.id}/invoice.pdf`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-injected'), null);
  return r.headers.get('content-disposition');
});
await R.test('SEC-C7', '−', 'wa.me link parameters are URL-encoded (no parameter smuggling via message text)', async () => {
  const b = (await api(owner, 'POST', '/bookings', { typeId: SO.id, hours: 1, date: day(), startTime: '16:00', clientName: 'x&phone=6200000#', clientPhone: '081300009999' })).data;
  cleanupBookings.push(b.id);
  const u = new URL((await api(owner, 'GET', `/bookings/${b.id}/message?kind=NEW`)).data.waUrl);
  assert.equal(u.pathname, '/6281300009999'); assert.deepEqual([...u.searchParams.keys()], ['text']);
});

// =====================================================================
R.area('D. File upload');
const exp = (await api(owner, 'POST', '/expenses', { categoryId: (await api(owner, 'GET', '/expense-categories')).data.find((c) => c.name === 'Lainnya').id, amount: 1000, paidOn: '2001-01-01', note: `sec ${run}`, force: true })).data;
const upload = (buf, type, name, base) => { const fd = new FormData(); fd.append('file', new Blob([buf], { type }), name); return api(owner, 'POST', `${base ?? ''}/expenses/${exp.id}/receipt`.replace(/^\/expenses/, '/expenses'), fd); };
await R.test('SEC-D1', '−', 'HTML/SVG/script files are rejected even when declared as images', async () => {
  for (const [buf, type, name] of [['<html><script>alert(1)</script>', 'image/jpeg', 'x.jpg'], ['<svg onload=alert(1)>', 'image/svg+xml', 'x.svg'], ['#!/bin/sh\nrm -rf /', 'image/png', 'x.png']]) {
    assert.equal((await upload(buf, type, name)).status, 400, name);
  }
});
await R.test('SEC-D2', '−', 'Oversized upload (6 MB) is refused', async () => {
  assert.equal((await upload(Buffer.alloc(6 * 1024 * 1024), 'image/jpeg', 'big.jpg')).status, 413);
});
await R.test('SEC-D3', '−', 'JPEG/HTML polyglot is stored under a random key and served with nosniff (no HTML execution)', async () => {
  const poly = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('<html><script>window.__xss=3</script></html>')]);
  assert.equal((await upload(poly, 'image/jpeg', '../../../evil.html')).status, 200);
  const key = sql(`SELECT receipt_key FROM expenses WHERE id='${exp.id}'`);
  assert.match(key, /^receipts\/[0-9a-f-]{36}$/, 'filename ignored');
  const viaNginx = await api(owner, 'GET', `/expenses/${exp.id}/receipt`);
  assert.equal(viaNginx.headers.get('content-type'), 'image/jpeg'); assert.equal(viaNginx.headers.get('x-content-type-options'), 'nosniff', 'exactly one nosniff header');
  if (directReachable) {
    const direct = await fetch(`${DIRECT}/expenses/${exp.id}/receipt`, { headers: { authorization: `Bearer ${owner}` } });
    assert.equal(direct.headers.get('x-content-type-options'), 'nosniff', 'direct :3000 response lacks nosniff');
  }
  // the API sets its own headers too (defence in depth behind nginx)
  assert.match(viaNginx.headers.get('content-security-policy') ?? '', /default-src 'none'/);
});

// =====================================================================
R.area('E. Browser-side protections (CORS, CSRF, clickjacking, CSP)');
await R.test('SEC-E1', '−', 'CORS: a foreign origin gets no Access-Control-Allow-Origin', async () => {
  const r = await fetch(`${'http://localhost:8080'}/api/v1/bookings`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});
await R.test('SEC-E2', '−', 'CSRF: state-changing calls need a Bearer token (cookies alone are not enough)', async () => {
  const c = (await api(null, 'POST', '/auth/login', OWNER)).headers.get('set-cookie').split(';')[0];
  const r = await api(null, 'POST', '/bookings', { typeId: SO.id, hours: 1, date: day(), startTime: '10:00', clientName: 'csrf' }, { cookie: c });
  assert.equal(r.status, 401);
});
await R.test('SEC-E3', '−', 'Web responses carry CSP, X-Frame-Options DENY, nosniff, Referrer-Policy', async () => {
  const h = (await fetch('http://localhost:8080/')).headers;
  assert.match(h.get('content-security-policy'), /default-src 'self'/); assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('x-content-type-options'), 'nosniff'); assert.ok(h.get('referrer-policy'));
  return `script-src not set separately (falls back to 'self'); style-src allows 'unsafe-inline'`;
});
await R.test('SEC-E4', '−', 'Server version is not disclosed', async () => {
  const s = (await fetch('http://localhost:8080/')).headers.get('server');
  assert.ok(!/\d/.test(s ?? ''), `Server: ${s}`);
});
await R.test('SEC-E5', '−', 'API port :3000 is not reachable outside the reverse proxy (or has the same headers)', async () => {
  const r = await fetch(`${DIRECT}/health`).catch(() => null);
  assert.ok(!r || r.headers.get('x-content-type-options'), 'API answers directly on 0.0.0.0:3000 without security headers and with spoofable X-Forwarded-For (see SEC-A8)');
});
await R.test('SEC-E6', '−', 'OAuth callback rejects forged state and only redirects to the fixed app URL (no open redirect)', async () => {
  const r = await api(null, 'GET', '/integrations/google/callback?state=x&code=y&redirect=https://evil.example');
  assert.equal(r.status, 302); assert.match(r.headers.get('location'), /^http:\/\/localhost:8080\/admin\/integrations\?error=state$/);
});

// =====================================================================
R.area('F. Abuse, DoS & error handling');
await R.test('SEC-F1', '−', 'API rate limit (TD §3.4: 120 req/min per user) throttles a burst of 300 requests', async () => {
  const rs = await Promise.all(Array.from({ length: 300 }, () => api(staff, 'GET', '/booking-types', undefined, { __noRetry: true })));
  const limited = rs.filter((r) => r.status === 429).length;
  assert.ok(limited > 0, `300 requests in ~1 s → ${limited} throttled`);
  const r = rs.find((x) => x.status === 429);
  assert.equal(r.data.code, 'RATE_LIMITED'); assert.ok(Number(r.headers.get('retry-after')) > 0);
  return `${limited} of 300 throttled (limit ${r.headers.get('ratelimit-limit')}/min), Retry-After ${r.headers.get('retry-after')} s`;
});
await R.test('SEC-F2', '−', 'Oversized JSON body (300 KB) is refused with 413', async () => {
  const r = await api(owner, 'POST', '/bookings', JSON.stringify({ notes: 'x'.repeat(300_000) }));
  assert.equal(r.status, 413, `refused, but as HTTP ${r.status} "${r.data?.message}" — the body-size error falls through to the generic 500 handler`);
});
await R.test('SEC-F3', '−', 'Huge arrays are refused cheaply (add-on list capped at 30)', async () => {
  const r = await api(owner, 'POST', '/bookings', { typeId: SO.id, hours: 1, date: day(), startTime: '10:00', clientName: 'arr', addons: Array.from({ length: 1500 }, () => ({ addonId: SO.id, qty: 1 })) });
  assert.equal(r.status, 400); assert.ok(r.ms < 1000);
  return `1.500-item array (~90 KB) rejected in ${Math.round(r.ms)} ms`;
});
await R.test('SEC-F4', '−', 'Malformed JSON and unknown routes return clean errors (no stack trace, no framework banner)', async () => {
  const a = await api(owner, 'POST', '/bookings', '{"typeId":');
  const b = await api(owner, 'GET', '/does-not-exist');
  for (const r of [a, b]) assert.ok(!JSON.stringify(r.data).match(/at \w+ \(|node_modules|stack/i));
  assert.equal(a.status, 400); assert.equal(b.status, 404);
  assert.equal((await fetch('http://localhost:8080/api/v1/health')).headers.get('x-powered-by'), null);
});
await R.test('SEC-F5', '−', 'Expensive PDF endpoint is not open to unauthenticated use', async () => {
  assert.equal((await api(null, 'GET', `/bookings/${booking.id}/invoice.pdf`)).status, 401);
});
await R.test('SEC-F6', '−', 'Health/readiness endpoints reveal no internal details', async () => {
  const r = (await api(null, 'GET', '/ready')).data;
  assert.deepEqual(Object.keys(r).sort(), ['ok'], `public /ready exposes ${JSON.stringify(r)}`);
});
resetLoginThrottle();
await R.test('SEC-F7', '−', 'Login-attempt table cannot be grown without bound by unauthenticated requests', async () => {
  const before = Number(sql('SELECT count(*) FROM login_attempts'));
  await Promise.all(Array.from({ length: 30 }, (_, i) => api(null, 'POST', '/auth/login', { email: `flood${i}-${run}@x.io`, password: 'x' }, { __noRetry: true })));
  const after = Number(sql('SELECT count(*) FROM login_attempts'));
  assert.ok(after - before < 30, `+${after - before} rows from 30 anonymous requests; old rows are purged only on a successful login`);
});

// =====================================================================
R.area('G. Infrastructure, data & secrets');
await R.test('SEC-G1', '−', 'Database is not reachable from outside the Docker network', async () => {
  const binding = execFileSync('docker', ['compose', 'port', 'db', '5432'], { encoding: 'utf8' }).trim();
  assert.match(binding, /^127\.0\.0\.1:/, `PostgreSQL is published on ${binding} (reachable from the LAN)`);
  return `published on ${binding} only`;
});
await R.test('SEC-G2', '−', 'Database rejects default credentials', async () => {
  try {
    execFileSync('docker', ['run', '--rm', '--add-host=host.docker.internal:host-gateway', 'postgres:18-alpine', 'psql', 'postgresql://postgres:postgres@host.docker.internal:5433/jes', '-c', 'select 1'], { stdio: 'pipe' });
    assert.fail('logged in with postgres/postgres');
  } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; }
});
await R.test('SEC-G3', '−', 'Application DB role is least-privilege (not superuser)', async () => {
  const url = execFileSync('docker', ['compose', 'exec', '-T', 'api', 'printenv', 'DATABASE_URL'], { encoding: 'utf8' }).trim();
  const role = new URL(url).username;
  assert.equal(sql(`SELECT rolsuper OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname = '${role}'`), 'f', `app connects as ${role}, a privileged role`);
  assert.equal(sql(`SELECT has_table_privilege('${role}', 'bookings', 'TRUNCATE') OR has_table_privilege('${role}', 'booking_history', 'DELETE')`), 'f', 'app can truncate data or delete audit rows');
  assert.equal(sql(`SELECT has_schema_privilege('${role}', 'public', 'CREATE')`), 'f', 'app can create objects');
  return `API/worker connect as ${role}: DML only, audit tables append-only`;
});
await R.test('SEC-G4', '−', 'Passwords are Argon2id hashes; Google token encrypted at rest (AES-256-GCM)', async () => {
  assert.match(sql('SELECT password_hash FROM users LIMIT 1'), /^\$argon2id\$v=19\$m=65536,(t=3,p=4|p=4,t=3)\$/);
  return 'refresh tokens stored as SHA-256 hashes; Google token encryption verified by code review';
});
await R.test('SEC-G5', '−', 'Containers run as non-root', async () => {
  const users = Object.fromEntries(['api', 'worker', 'web'].map((s) => [s, execFileSync('docker', ['compose', 'exec', '-T', s, 'id', '-un'], { encoding: 'utf8' }).trim()]));
  assert.ok(Object.values(users).every((u) => u !== 'root'), JSON.stringify(users) + ' (nginx master runs as root; workers drop to nginx)');
});
await R.test('SEC-G6', '−', 'No secrets baked into images (.env excluded; secrets only via runtime env)', async () => {
  const out = execFileSync('docker', ['run', '--rm', '--entrypoint', 'sh', 'jes-api:local', '-c', 'find / -name ".env" -not -path "/proc/*" 2>/dev/null | head -1; grep -rl "JWT_SECRET=" /app --include=*.js 2>/dev/null | head -1'], { encoding: 'utf8' }).trim();
  assert.equal(out, '');
});
await R.test('SEC-G7', '−', 'Secrets are strong (JWT ≥ 256 bits, encryption key 32 bytes, DB password random)', async () => {
  assert.ok(ENV.JWT_SECRET.length >= 64); assert.equal(Buffer.from(ENV.ENCRYPTION_KEY, 'base64').length, 32); assert.ok(ENV.POSTGRES_PASSWORD.length >= 20);
});
await R.test('SEC-G8', '−', 'Production dependencies have no known high/critical advisories (npm audit)', async () => {
  const out = (() => { try { return execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return e.stdout; } })();
  const v = JSON.parse(out).metadata.vulnerabilities;
  assert.equal(v.high + v.critical, 0, `${v.high} high, ${v.critical} critical: multer (GHSA-q7qp-rjg7-q26m, via @nestjs/platform-express), zod (GHSA-mrhx-c7xc-m3w5)`);
});
await R.test('SEC-G9', '−', 'Audit trail: booking changes and expense edits/deletes are logged with user and time', async () => {
  assert.ok(Number(sql(`SELECT count(*) FROM booking_history WHERE changed_by IS NOT NULL`)) > 0);
  assert.ok(Number(sql(`SELECT count(*) FROM expense_audit`)) > 0);
  return 'no audit for settings/master/user changes, logins or month close by actor beyond closed_by';
});
await R.test('SEC-G10', '−', 'Logs do not contain credentials or tokens', async () => {
  const logs = execFileSync('docker', ['compose', 'logs', '--no-color', 'api'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.ok(!logs.includes(OWNER.password), 'password in logs'); assert.ok(!logs.includes(owner.slice(-30)), 'access token in logs');
  assert.ok(!/jes_rt=[A-Za-z0-9_-]{20}/.test(logs), 'refresh tokens logged: pino-http writes the response Set-Cookie header (redact covers request headers only)');
});

// cleanup
for (const id of cleanupBookings) await api(owner, 'POST', `/bookings/${id}/cancel`, { reason: 'OTHER', note: 'security test cleanup' });
await api(owner, 'DELETE', `/expenses/${exp.id}`);
console.log(`\nXSS check booking for the browser: /bookings/${xss?.id}`);
R.done();
