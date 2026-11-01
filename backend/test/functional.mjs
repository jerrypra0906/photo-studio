// Functional test suite — every PRD user story (US-01 … US-29) with its + and − scenarios, plus edge cases.
// Usage: node backend/test/functional.mjs   (BASE_URL defaults to http://localhost:8080; dev database only)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { OWNER, ROOT, STAFF, addDays, api, login, resetLoginThrottle, runner, sleep, sql, wibToday } from './lib.mjs';

const R = runner('functional');
resetLoginThrottle();
const owner = await login(OWNER);
const staff = await login(STAFF);
const today = wibToday();
const run = Date.now().toString(36);

// ---------- fixtures ----------
const settings0 = (await api(owner, 'GET', '/settings')).data;
const putSettings = (patch) => api(owner, 'PUT', '/settings', { ...settings0, ...patch });
await putSettings({ bankName: 'BCA', accountNo: '8888000111', accountHolder: 'JES Space Studio', bufferMin: 0, maxHours: 8 });

const types = (await api(owner, 'GET', '/booking-types')).data;
const PP = types.find((t) => t.name === 'Photo Package');
const SO = types.find((t) => t.name === 'Studio Only');
const addons = (await api(owner, 'GET', '/addons')).data;
const A = (n) => addons.find((a) => a.name === n).id;
const phs = (await api(owner, 'GET', '/photographers')).data;
const HAMJA = phs.find((p) => p.name === 'Hamja').id;
const NAEL = phs.find((p) => p.name === 'Nael').id;
const cats = (await api(owner, 'GET', '/expense-categories')).data;
const CAT = (n) => cats.find((c) => c.name === n).id;

async function freeDay() {
  for (;;) {
    const d = `${2031 + Math.floor(Math.random() * 60)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`;
    if (!(await api(owner, 'GET', `/schedule?from=${d}&to=${d}`)).data.bookings.length) return d;
  }
}
async function freeMonth() {
  for (;;) {
    const m = `${2000 + Math.floor(Math.random() * 25)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}`;
    const r = (await api(owner, 'GET', `/reports/recap?month=${m}`)).data;
    if (!r.closed && !r.revenue.bookingCount && !r.expenses.total && !r.drafts.count) return m;
  }
}
const base = (o = {}) => ({ typeId: SO.id, hours: 1, startTime: '10:00', clientName: `Klien ${run}`, addons: [], ...o });
const book = (tok, o) => api(tok, 'POST', '/bookings', base(o));
const D = await freeDay();      // future day for booking-flow tests
const D2 = addDays(D, 1);
const M = await freeMonth();    // past month for finance tests
let M2 = await freeMonth(); while (M2 === M) M2 = await freeMonth();
let M3 = await freeMonth(); while (M3 === M || M3 === M2) M3 = await freeMonth();
console.log(`run ${run} · booking day ${D} · finance month ${M} · loss month ${M2} · empty month ${M3}`);

const cleanup = [];
try {
  // =====================================================================
  R.area('Access — US-01 login, US-02 staff');
  let tempUser;
  await R.test('US-01.1', '+', 'Owner logs in → access token, role, 30-day httpOnly SameSite=Strict refresh cookie', async () => {
    const r = await api(null, 'POST', '/auth/login', OWNER);
    assert.equal(r.status, 200);
    assert.equal(r.data.user.role, 'OWNER');
    const c = r.headers.get('set-cookie');
    assert.match(c, /jes_rt=/); assert.match(c, /HttpOnly/i); assert.match(c, /SameSite=Strict/i); assert.match(c, /Max-Age=2592000/);
  });
  await R.test('US-01.2', '+', 'Reopening the app: refresh cookie returns a new access token without password', async () => {
    const r = await api(null, 'POST', '/auth/login', OWNER);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const f = await api(null, 'POST', '/auth/refresh', undefined, { cookie });
    assert.equal(f.status, 200); assert.ok(f.data.accessToken);
    assert.equal((await api(f.data.accessToken, 'GET', '/auth/me')).data.email, OWNER.email);
  });
  await R.test('US-01.3', '−', 'Wrong password and unknown email give the same generic message', async () => {
    const a = await api(null, 'POST', '/auth/login', { email: OWNER.email, password: 'wrong-pass' });
    const b = await api(null, 'POST', '/auth/login', { email: `nobody-${run}@jes.local`, password: 'wrong-pass' });
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.data.message, 'Email atau kata sandi salah'); assert.equal(a.data.message, b.data.message);
  });
  await R.test('US-01.4', '−', '5 failures in 10 min lock the login for 15 min, even with the right password', async () => {
    tempUser = { email: `lock-${run}@jes.local`, password: 'Temp-Pass-123' };
    await api(owner, 'POST', '/users', { name: 'Lock test', ...tempUser, role: 'STAFF' });
    for (let i = 0; i < 5; i++) await api(null, 'POST', '/auth/login', { email: tempUser.email, password: 'bad' });
    const r = await api(null, 'POST', '/auth/login', tempUser);
    assert.equal(r.status, 429); assert.equal(r.data.code, 'LOCKED'); assert.match(r.data.message, /Coba lagi setelah \d{2}[.:]\d{2} WIB/);
    return r.data.message;
  });
  await R.test('AUTH-x1', '−', 'No token / garbage token on a protected endpoint → 401', async () => {
    assert.equal((await api(null, 'GET', '/bookings')).status, 401);
    assert.equal((await api('abc.def.ghi', 'GET', '/bookings')).status, 401);
  });
  await R.test('AUTH-x2', '−', 'Logout revokes the refresh session', async () => {
    const r = await api(null, 'POST', '/auth/login', OWNER);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    assert.equal((await api(null, 'POST', '/auth/logout', undefined, { cookie })).status, 204);
    assert.equal((await api(null, 'POST', '/auth/refresh', undefined, { cookie })).status, 401);
  });
  await R.test('AUTH-x3', '−', 'Deactivated user cannot log in', async () => {
    const u = (await api(owner, 'GET', '/users')).data.find((x) => x.email === tempUser.email);
    await api(owner, 'PATCH', `/users/${u.id}`, { name: 'Lock test', email: tempUser.email, role: 'STAFF', active: false });
    sql(`DELETE FROM login_attempts WHERE key LIKE '%${tempUser.email}'`);
    assert.equal((await api(null, 'POST', '/auth/login', tempUser)).status, 401);
  });
  await R.test('AUTH-x4', '−', 'Owner cannot deactivate or demote their own account', async () => {
    const me = (await api(owner, 'GET', '/auth/me')).data;
    const r = await api(owner, 'PATCH', `/users/${me.id}`, { name: me.name, email: me.email, role: 'STAFF', active: true });
    assert.equal(r.status, 400);
  });
  await R.test('US-02.1', '+', 'Staff signs in with role STAFF and can list bookings and schedule', async () => {
    assert.equal((await api(staff, 'GET', '/auth/me')).data.role, 'STAFF');
    assert.equal((await api(staff, 'GET', '/bookings')).status, 200);
    assert.equal((await api(staff, 'GET', `/schedule?from=${today}&to=${today}`)).status, 200);
  });
  await R.test('US-02.2', '−', 'Staff gets 403 and no data on every Admin / Finance endpoint (15 endpoints)', async () => {
    const calls = [
      ['GET', '/expenses'], ['GET', '/expense-categories'], ['GET', '/users'], ['GET', `/reports/recap?month=${M}`], ['GET', `/reports/recap.csv?month=${M}`],
      ['GET', '/integrations/google'], ['POST', '/booking-types', {}], ['PATCH', `/booking-types/${SO.id}`, {}], ['POST', '/photographers', {}],
      ['POST', '/addons', {}], ['PUT', '/settings', {}], ['PUT', '/templates/NEW', { body: 'x' }], ['POST', '/users', {}],
      ['POST', `/reports/months/${M}/close`], ['POST', '/expenses', {}],
    ];
    for (const [m, p, b] of calls) {
      const r = await api(staff, m, p, b);
      assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
      assert.equal(r.data.code, 'FORBIDDEN');
    }
  });
  await R.test('US-02.3', '−', 'Staff-entered price adjustment is ignored by the server', async () => {
    const r = await book(staff, { date: D, startTime: '09:00', adjustment: -100000, adjustmentReason: 'staff promo' });
    assert.equal(r.status, 201); assert.equal(r.data.adjustment, 0); assert.equal(r.data.total, 170000);
    cleanup.push(r.data.id);
  });

  // =====================================================================
  R.area('Create booking — US-03 … US-11');
  await R.test('US-03.1', '+', 'Photo Package rate 599.000/h and requires a photographer', async () => {
    assert.equal(PP.hourlyRate, 599000); assert.equal(PP.requiresPhotographer, true); assert.equal(SO.requiresPhotographer, false);
  });
  await R.test('US-03.3', '−', 'An inactive booking type cannot be booked', async () => {
    const t = (await api(owner, 'POST', '/booking-types', { name: `Maternity ${run}`, hourlyRate: 700000, requiresPhotographer: false, active: false })).data;
    const r = await book(owner, { typeId: t.id, date: D, startTime: '11:00' });
    assert.equal(r.status, 400); assert.equal(r.data.fields.typeId, 'Jenis booking tidak aktif');
    await api(owner, 'DELETE', `/booking-types/${t.id}`);
  });
  await R.test('US-04.1', '+', '3 hours from 14:00 ends at 17:00 and prices 3 × rate', async () => {
    const r = await book(owner, { date: D, startTime: '14:00', hours: 3 });
    assert.equal(r.status, 201);
    assert.equal(new Date(r.data.endAt).getTime() - new Date(r.data.startAt).getTime(), 3 * 3600e3);
    assert.equal(r.data.total, 510000);
    cleanup.push(r.data.id);
  });
  let perHour;
  await R.test('US-04.2', '+', 'A per-hour add-on doubles when duration goes from 1 h to 2 h', async () => {
    perHour = (await api(owner, 'POST', '/addons', { name: `Dekor jam ${run}`, price: 125000, unit: 'HOUR', typeIds: [PP.id, SO.id] })).data;
    const a = await book(owner, { date: D2, startTime: '09:00', hours: 1, addons: [{ addonId: perHour.id, qty: 1 }] });
    const b = await book(owner, { date: D2, startTime: '12:00', hours: 2, addons: [{ addonId: perHour.id, qty: 1 }] });
    assert.equal(a.data.addons[0].lineTotal, 125000); assert.equal(b.data.addons[0].lineTotal, 250000);
    cleanup.push(a.data.id, b.data.id);
  });
  await R.test('US-04.3', '−', 'Duration 0 h is rejected', async () => {
    const r = await book(owner, { date: D, startTime: '19:00', hours: 0 });
    assert.equal(r.status, 400);
  });
  await R.test('US-04.4', '−', 'Duration above the 8 h maximum is rejected ("Maks 8 jam")', async () => {
    const r = await book(owner, { date: D, startTime: '09:00', hours: 9 });
    assert.equal(r.status, 400); assert.equal(r.data.fields.hours, 'Maks 8 jam');
  });
  await R.test('US-05.1', '+', 'A free slot is saved and appears in the schedule for that day', async () => {
    const day = addDays(D, 2);
    const r = await book(owner, { date: day, startTime: '14:00', hours: 2 });
    assert.equal(r.status, 201);
    const s = (await api(owner, 'GET', `/schedule?from=${day}&to=${day}`)).data;
    assert.ok(s.bookings.some((b) => b.id === r.data.id));
    cleanup.push(r.data.id);
  });
  let clashTarget;
  await R.test('US-05.3', '−', 'Overlapping slot → 409 "Bentrok dengan <no> (<client>, hh:mm–hh:mm)"', async () => {
    const day = addDays(D, 3);
    clashTarget = (await book(owner, { date: day, startTime: '14:00', hours: 2, clientName: 'Lilin' })).data;
    const r = await book(owner, { date: day, startTime: '15:00' });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'SLOT_TAKEN');
    assert.equal(r.data.message, `Bentrok dengan ${clashTarget.bookingNo} (Lilin, 14:00–16:00)`);
  });
  await R.test('BR-01', '−', 'Back-to-back booking is allowed with buffer 0 but blocked by a 30-min buffer', async () => {
    const day = addDays(D, 4);
    const first = (await book(owner, { date: day, startTime: '10:00' })).data;
    const ok = await book(owner, { date: day, startTime: '11:00' });
    assert.equal(ok.status, 201);
    await putSettings({ bankName: 'BCA', accountNo: '8888000111', accountHolder: 'JES Space Studio', bufferMin: 30 });
    const blocked = await book(owner, { date: day, startTime: '13:00', hours: 1 });
    const after = await book(owner, { date: day, startTime: '14:00' });
    await putSettings({ bankName: 'BCA', accountNo: '8888000111', accountHolder: 'JES Space Studio', bufferMin: 0 });
    assert.equal(blocked.status, 201); // 13:00 starts after 11:00 booking's 12:00 end + 30 = 12:30
    assert.equal(after.status, 409, 'buffer should block 14:00 right after 13:00–14:00');
    cleanup.push(first.id, ok.data.id, blocked.data.id);
  });
  await R.test('US-05.4', '−', 'Ending after closing needs a reason; with a reason it saves and is flagged', async () => {
    const r = await book(owner, { date: D, startTime: '20:00', hours: 2 });
    assert.equal(r.status, 400); assert.equal(r.data.code, 'AFTER_HOURS'); assert.match(r.data.message, /Selesai setelah jam tutup \(21:00\)/);
    const ok = await book(owner, { date: D, startTime: '20:00', hours: 2, afterHoursReason: 'Klien minta malam' });
    assert.equal(ok.status, 201); assert.equal(ok.data.afterHoursReason, 'Klien minta malam');
    cleanup.push(ok.data.id);
  });
  await R.test('EDGE-05a', '−', 'Booking on a closed weekday needs a reason', async () => {
    const dow = new Date(D + 'T12:00:00Z').getUTCDay();
    const hours = settings0.openHours.map((h, i) => (i === dow ? { ...h, closed: true } : h));
    await putSettings({ bankName: 'BCA', accountNo: '8888000111', accountHolder: 'JES Space Studio', openHours: hours });
    const r = await book(owner, { date: D, startTime: '16:00' });
    await putSettings({ bankName: 'BCA', accountNo: '8888000111', accountHolder: 'JES Space Studio', openHours: settings0.openHours });
    assert.equal(r.status, 400); assert.match(r.data.message, /Studio tutup/);
  });
  await R.test('EDGE-05b', '−', 'Start time off the 30-minute grid is rejected', async () => {
    const r = await book(owner, { date: D, startTime: '10:15' });
    assert.equal(r.status, 400); assert.match(r.data.fields.startTime, /30 menit/);
  });
  await R.test('US-05.5', '−', 'Staff cannot pick a past date', async () => {
    const r = await book(staff, { date: addDays(today, -3), startTime: '10:00' });
    assert.equal(r.status, 400); assert.equal(r.data.fields.date, 'Tanggal lampau tidak bisa dipilih');
  });
  await R.test('BR-07', '+', 'Owner can back-enter a past booking; it is flagged back-dated', async () => {
    const r = await book(owner, { date: `${M}-02`, startTime: '10:00' });
    assert.equal(r.status, 201); assert.equal(r.data.backDated, true);
    await api(owner, 'POST', `/bookings/${r.data.id}/cancel`, { reason: 'OTHER' });
  });
  await R.test('US-06.1', '+', 'Phone "0821 2350 0508" / "+62 821-2350-0508" / "82123500508" all normalise to 6282123500508', async () => {
    for (const [i, raw] of ['0821 2350 0508', '+62 821-2350-0508', '82123500508'].entries()) {
      const r = await book(owner, { date: addDays(D, 5), startTime: `${String(9 + i * 2).padStart(2, '0')}:00`, clientPhone: raw, clientName: 'Aurel' });
      assert.equal(r.data.clientPhoneSnap, '6282123500508', raw);
      cleanup.push(r.data.id);
    }
  });
  await R.test('US-06.2', '+', 'Typing "Aur" or part of the phone suggests the previous client', async () => {
    const byName = (await api(owner, 'GET', '/clients?q=Aur')).data;
    const byPhone = (await api(owner, 'GET', '/clients?q=2350')).data;
    assert.ok(byName.some((c) => c.name === 'Aurel' && c.phoneE164 === '6282123500508'));
    assert.ok(byPhone.some((c) => c.phoneE164 === '6282123500508'));
  });
  await R.test('US-06.3', '−', 'Empty client name → "Nama klien minimal 2 karakter", nothing saved', async () => {
    const r = await book(owner, { date: D, startTime: '12:00', clientName: '' });
    assert.equal(r.status, 400); assert.match(r.data.fields.clientName, /minimal 2/);
  });
  await R.test('US-06.4', '−', 'Phone "12ab" → "Masukkan nomor telepon yang valid"', async () => {
    const r = await book(owner, { date: D, startTime: '12:00', clientPhone: '12ab' });
    assert.equal(r.status, 400); assert.equal(r.data.fields.clientPhone, 'Masukkan nomor telepon yang valid');
  });
  await R.test('US-07.1', '+', 'Photographer Hamja is saved on a Photo Package (name snapshotted)', async () => {
    const r = await book(owner, { typeId: PP.id, date: addDays(D, 6), startTime: '15:00', photographerId: HAMJA });
    assert.equal(r.status, 201); assert.equal(r.data.photographerNameSnap, 'Hamja');
    cleanup.push(r.data.id);
  });
  await R.test('US-07.2', '−', 'A photographer already booked 15:00–16:00 cannot be booked again then', async () => {
    const r = await book(owner, { typeId: PP.id, date: addDays(D, 6), startTime: '15:00', photographerId: HAMJA });
    assert.equal(r.status, 409);
  });
  await R.test('US-07.3', '−', 'Photo Package without photographer → "Pilih fotografer"', async () => {
    const r = await book(owner, { typeId: PP.id, date: D, startTime: '12:00' });
    assert.equal(r.status, 400); assert.equal(r.data.fields.photographerId, 'Pilih fotografer');
  });
  await R.test('EDGE-07a', '−', 'An inactive photographer cannot be assigned', async () => {
    const p = (await api(owner, 'POST', '/photographers', { name: `Ex ${run}`, active: false })).data;
    const r = await book(owner, { typeId: PP.id, date: D, startTime: '12:00', photographerId: p.id });
    assert.equal(r.status, 400); assert.equal(r.data.fields.photographerId, 'Fotografer tidak aktif');
    await api(owner, 'DELETE', `/photographers/${p.id}`);
  });
  await R.test('US-08.1', '+', 'MUA + Hairdo adds a flat 600.000 line', async () => {
    const r = await book(owner, { typeId: PP.id, photographerId: NAEL, date: addDays(D, 7), startTime: '09:00', addons: [{ addonId: A('MUA + Hairdo'), qty: 1 }] });
    assert.equal(r.data.addons[0].lineTotal, 600000); assert.equal(r.data.total, 1199000);
    cleanup.push(r.data.id);
  });
  await R.test('US-08.2', '+', 'Extra person × 5 = 125.000', async () => {
    const r = await book(owner, { date: addDays(D, 7), startTime: '12:00', addons: [{ addonId: A('Extra person'), qty: 5 }] });
    assert.equal(r.data.addons[0].lineTotal, 125000); assert.equal(r.data.addons[0].qty, 5);
    cleanup.push(r.data.id);
  });
  await R.test('US-08.4', '−', 'Dekorasi (Photo Package only) is rejected on Studio Only', async () => {
    const r = await book(owner, { date: D, startTime: '12:00', addons: [{ addonId: A('Dekorasi'), qty: 1 }] });
    assert.equal(r.status, 400); assert.match(r.data.message, /tidak tersedia untuk Studio Only/);
  });
  await R.test('US-08.5', '−', 'Quantity 0 or negative is rejected', async () => {
    for (const qty of [0, -3]) assert.equal((await book(owner, { date: D, startTime: '12:00', addons: [{ addonId: A('Extra person'), qty }] })).status, 400);
  });
  await R.test('EDGE-08a', '−', 'Same add-on twice and an inactive add-on are rejected', async () => {
    assert.equal((await book(owner, { date: D, startTime: '12:00', addons: [{ addonId: A('MUA'), qty: 1 }, { addonId: A('MUA'), qty: 1 }] })).status, 400);
    const off = (await api(owner, 'POST', '/addons', { name: `Off ${run}`, price: 1000, unit: 'BOOKING', typeIds: [SO.id], active: false })).data;
    assert.equal((await book(owner, { date: D, startTime: '12:00', addons: [{ addonId: off.id, qty: 1 }] })).status, 400);
    await api(owner, 'DELETE', `/addons/${off.id}`);
  });
  let lilin;
  await R.test('US-09.1', '+', 'PP 1 h + MUA hairdo + Dekorasi = Rp1.449.000 with every line', async () => {
    const r = await book(owner, { typeId: PP.id, photographerId: HAMJA, date: addDays(D, 8), startTime: '14:00', clientName: 'Lilin', clientPhone: '081234567890',
      addons: [{ addonId: A('MUA + Hairdo'), qty: 1 }, { addonId: A('Dekorasi'), qty: 1 }], dpAmount: 500000 });
    assert.equal(r.data.total, 1449000); assert.equal(r.data.addons.length, 2);
    lilin = r.data;
  });
  await R.test('EDGE-09a', '−', 'A client-supplied total/status/bookingNo is ignored (server re-prices)', async () => {
    const r = await api(owner, 'POST', '/bookings', { ...base({ date: addDays(D, 8), startTime: '09:00' }), total: 1, status: 'COMPLETED', bookingNo: 'HACK', paidAmount: 999 });
    assert.equal(r.status, 201); assert.equal(r.data.total, 170000); assert.equal(r.data.status, 'CONFIRMED'); assert.notEqual(r.data.bookingNo, 'HACK'); assert.equal(r.data.paidAmount, 0);
    cleanup.push(r.data.id);
  });
  await R.test('US-09.3', '−', 'Changing the master rate later does not change an existing booking', async () => {
    await api(owner, 'PATCH', `/booking-types/${PP.id}`, { ...PP, hourlyRate: 650000 });
    const b = (await api(owner, 'GET', `/bookings/${lilin.id}`)).data;
    const fresh = await book(owner, { typeId: PP.id, photographerId: NAEL, date: addDays(D, 9), startTime: '09:00' });
    await api(owner, 'PATCH', `/booking-types/${PP.id}`, { ...PP, hourlyRate: 599000 });
    assert.equal(b.rateSnap, 599000); assert.equal(b.total, 1449000); assert.equal(fresh.data.rateSnap, 650000);
    cleanup.push(fresh.data.id);
  });
  await R.test('US-10.1', '+', 'Studio 6 h with −420.000 "Long-booking promo" = Rp600.000', async () => {
    const r = await book(owner, { date: addDays(D, 10), startTime: '10:00', hours: 6, adjustment: -420000, adjustmentReason: 'Long-booking promo' });
    assert.equal(r.data.total, 600000); assert.equal(r.data.adjustmentReason, 'Long-booking promo');
    cleanup.push(r.data.id);
  });
  await R.test('US-10.2', '+', 'DP 500.000 on 1.449.000 → balance 949.000', async () => {
    assert.equal(lilin.dpAmount, 500000); assert.equal(lilin.balance, 949000);
  });
  await R.test('US-10.3', '−', 'Adjustment without reason → "Alasan wajib diisi"', async () => {
    const r = await book(owner, { date: D, startTime: '12:00', adjustment: -10000 });
    assert.equal(r.data.fields.adjustmentReason, 'Alasan wajib diisi');
  });
  await R.test('US-10.4', '−', 'DP 400.000 on a 340.000 total → "DP tidak boleh melebihi total"', async () => {
    const r = await book(owner, { date: D, startTime: '12:00', hours: 2, dpAmount: 400000 });
    assert.equal(r.data.fields.dpAmount, 'DP tidak boleh melebihi total');
  });
  await R.test('US-10.5', '−', 'Adjustment −500.000 on 340.000 → "Total tidak boleh di bawah Rp0"', async () => {
    const r = await book(owner, { date: D, startTime: '12:00', hours: 2, adjustment: -500000, adjustmentReason: 'x' });
    assert.equal(r.data.fields.adjustment, 'Total tidak boleh di bawah Rp0');
  });
  await R.test('US-11.1', '+', 'Booking numbers are JES-YYMMDD-NNN from the session date and increase per day', async () => {
    const day = addDays(D, 11);
    const a = (await book(owner, { date: day, startTime: '09:00' })).data;
    const b = (await book(owner, { date: day, startTime: '11:00' })).data;
    const ymd = day.slice(2).replace(/-/g, '');
    assert.match(a.bookingNo, new RegExp(`^JES-${ymd}-\\d{3}$`));
    assert.equal(Number(b.bookingNo.slice(-3)), Number(a.bookingNo.slice(-3)) + 1); assert.equal(a.status, 'CONFIRMED');
    return `${a.bookingNo}, ${b.bookingNo}`;
    cleanup.push(a.id, b.id);
  });
  await R.test('US-11.2', '−', '5 devices save the same slot at once → exactly one succeeds, others get "slot taken"', async () => {
    const body = base({ date: addDays(D, 12), startTime: '15:00', hours: 2 });
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => api(owner, 'POST', '/bookings', body)));
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
    cleanup.push(rs.find((r) => r.status === 201).data.id);
  });
  await R.test('US-11.3', '−', 'Retry after a dropped response (same Idempotency-Key) returns the same booking, no duplicate', async () => {
    const key = `idem-${run}`;
    const a = await api(owner, 'POST', '/bookings', base({ date: addDays(D, 13), startTime: '09:00' }), { 'idempotency-key': key });
    const b = await api(owner, 'POST', '/bookings', base({ date: addDays(D, 13), startTime: '09:00' }), { 'idempotency-key': key });
    assert.equal(a.data.id, b.data.id);
    assert.equal((await api(owner, 'GET', `/schedule?from=${addDays(D, 13)}&to=${addDays(D, 13)}`)).data.bookings.length, 1);
    cleanup.push(a.data.id);
  });

  // =====================================================================
  R.area('Manage bookings — US-12 … US-15');
  await R.test('US-12.1', '+', 'Day list is in time order with client, type, hours, photographer and status', async () => {
    const day = addDays(D, 14);
    for (const t of ['15:00', '09:00', '12:00']) cleanup.push((await book(owner, { date: day, startTime: t })).data.id);
    const list = (await api(owner, 'GET', `/bookings?from=${day}&to=${day}`)).data;
    assert.deepEqual(list.map((b) => new Date(b.startAt).toISOString().slice(11, 16)), ['02:00', '05:00', '08:00']);
    for (const k of ['clientNameSnap', 'typeNameSnap', 'hours', 'status']) assert.ok(k in list[0]);
  });
  await R.test('US-12.2', '+', 'Search is partial and case-insensitive on name, phone and booking number', async () => {
    assert.ok((await api(owner, 'GET', '/bookings?q=LILIN')).data.some((b) => b.id === lilin.id));
    assert.ok((await api(owner, 'GET', '/bookings?q=0812-3456')).data.some((b) => b.id === lilin.id));
    assert.ok((await api(owner, 'GET', `/bookings?q=${lilin.bookingNo.slice(4)}`)).data.some((b) => b.id === lilin.id));
  });
  await R.test('US-12.3', '−', 'A week with no bookings returns an empty list (no error)', async () => {
    const r = await api(owner, 'GET', '/schedule?from=2099-12-01&to=2099-12-07');
    assert.equal(r.status, 200); assert.deepEqual(r.data.bookings, []);
  });
  await R.test('US-12.4', '−', 'Cancelled bookings are hidden by default and shown on request', async () => {
    const day = addDays(D, 15);
    const b = (await book(owner, { date: day, startTime: '10:00' })).data;
    await api(owner, 'POST', `/bookings/${b.id}/cancel`, { reason: 'OTHER' });
    assert.ok(!(await api(owner, 'GET', `/bookings?from=${day}&to=${day}`)).data.some((x) => x.id === b.id));
    assert.ok((await api(owner, 'GET', `/bookings?from=${day}&to=${day}&includeCancelled=true`)).data.some((x) => x.id === b.id));
    assert.ok((await api(owner, 'GET', `/bookings?from=${day}&to=${day}&status=CANCELLED`)).data.some((x) => x.id === b.id));
  });
  const bodyOf = (b, o = {}) => ({
    typeId: b.typeId, hours: b.hours, date: new Date(new Date(b.startAt).getTime() + 7 * 3600e3).toISOString().slice(0, 10),
    startTime: new Date(new Date(b.startAt).getTime() + 7 * 3600e3).toISOString().slice(11, 16), clientName: b.clientNameSnap, clientPhone: b.clientPhoneSnap,
    photographerId: b.photographerId, addons: b.addons.map((a) => ({ addonId: a.addonId, qty: a.qty })), adjustment: b.adjustment, adjustmentReason: b.adjustmentReason,
    dpAmount: b.dpAmount, notes: b.notes, ...o,
  });
  let joyce;
  await R.test('US-13.1', '+', 'Reschedule to a free slot → same number, invoice R1, Reschedule template shows old and new time', async () => {
    joyce = (await book(owner, { date: addDays(D, 16), startTime: '12:00', clientName: 'Joyce', clientPhone: '081300000001' })).data;
    const r = await api(owner, 'PATCH', `/bookings/${joyce.id}`, bodyOf(joyce, { date: addDays(D, 17) }), { 'if-match': String(joyce.version) });
    assert.equal(r.status, 200); assert.equal(r.data.bookingNo, joyce.bookingNo); assert.equal(r.data.invoiceRev, 1);
    assert.ok(r.data.history.some((h) => h.action === 'RESCHEDULE'));
    const msg = (await api(owner, 'GET', `/bookings/${joyce.id}/message?kind=RESCHEDULE`)).data.text;
    assert.match(msg, /Sebelumnya: .+12:00 WIB/); assert.match(msg, /Jadwal baru: .+12:00 – 13:00 WIB/);
    joyce = r.data;
  });
  await R.test('US-13.2', '+', 'Adding Dekorasi to Ides (749.000, DP 300.000) → 999.000, balance 699.000, revision logged', async () => {
    const ides = (await book(owner, { typeId: PP.id, photographerId: NAEL, date: addDays(D, 18), startTime: '10:00', clientName: 'Ides', addons: [{ addonId: A('Sewa dress'), qty: 1 }], dpAmount: 300000 })).data;
    assert.equal(ides.total, 749000);
    const r = await api(owner, 'PATCH', `/bookings/${ides.id}`, bodyOf(ides, { addons: [{ addonId: A('Sewa dress'), qty: 1 }, { addonId: A('Dekorasi'), qty: 1 }] }), { 'if-match': String(ides.version) });
    assert.equal(r.data.total, 999000); assert.equal(r.data.balance, 699000); assert.equal(r.data.invoiceRev, 1);
    assert.ok(r.data.history.some((h) => h.field === 'total' && h.oldValue === '749000' && h.newValue === '999000'));
    cleanup.push(ides.id);
  });
  await R.test('EDGE-13a', '+', 'Editing only internal notes does not bump the invoice revision', async () => {
    const r = await api(owner, 'PATCH', `/bookings/${joyce.id}`, bodyOf(joyce, { notes: 'bawa properti sendiri' }), { 'if-match': String(joyce.version) });
    assert.equal(r.data.invoiceRev, joyce.invoiceRev); assert.equal(r.data.notes, 'bawa properti sendiri');
    joyce = r.data;
  });
  await R.test('EDGE-13b', '+', 'Edit keeps snapshot prices by default; applyCurrentPrices re-prices from the master', async () => {
    const b = (await book(owner, { date: addDays(D, 19), startTime: '10:00' })).data;
    await api(owner, 'PATCH', `/booking-types/${SO.id}`, { ...SO, hourlyRate: 200000 });
    const keep = (await api(owner, 'PATCH', `/bookings/${b.id}`, bodyOf(b, { notes: 'a' }))).data;
    const cur = (await api(owner, 'PATCH', `/bookings/${b.id}`, bodyOf(b, { notes: 'b', applyCurrentPrices: true }))).data;
    await api(owner, 'PATCH', `/booking-types/${SO.id}`, { ...SO, hourlyRate: 170000 });
    assert.equal(keep.total, 170000); assert.equal(cur.total, 200000);
    cleanup.push(b.id);
  });
  await R.test('US-13.3', '−', 'Rescheduling into a taken slot → 409 and the booking is unchanged', async () => {
    const r = await api(owner, 'PATCH', `/bookings/${joyce.id}`, bodyOf(joyce, { date: addDays(D, 3), startTime: '14:00' }));
    assert.equal(r.status, 409);
    const after = (await api(owner, 'GET', `/bookings/${joyce.id}`)).data;
    assert.equal(after.startAt, joyce.startAt); assert.equal(after.version, joyce.version);
  });
  await R.test('EDGE-13c', '−', 'Saving with a stale version (If-Match) → 409 STALE', async () => {
    const r = await api(owner, 'PATCH', `/bookings/${joyce.id}`, bodyOf(joyce), { 'if-match': String(joyce.version - 1) });
    assert.equal(r.data.code, 'STALE');
  });
  await R.test('US-14.4', '−', 'Cancelling without a reason → 400', async () => {
    assert.equal((await api(owner, 'POST', `/bookings/${joyce.id}/cancel`, {})).status, 400);
    assert.equal((await api(owner, 'POST', `/bookings/${joyce.id}/cancel`, { reason: 'BORED' })).status, 400);
  });
  await R.test('US-14.1', '+', 'Cancel with "Customer cancelled" → Cancelled, slot free, record kept', async () => {
    const r = await api(owner, 'POST', `/bookings/${joyce.id}/cancel`, { reason: 'CUSTOMER_CANCELLED', note: 'pindah kota' });
    assert.equal(r.data.status, 'CANCELLED'); assert.equal(r.data.cancelReason, 'CUSTOMER_CANCELLED');
    const again = await book(owner, { date: addDays(D, 17), startTime: '12:00' });
    assert.equal(again.status, 201);
    cleanup.push(again.data.id);
  });
  await R.test('US-14.2', '+', 'A cancelled booking keeps its recorded DP (refund reminder data)', async () => {
    const b = (await book(owner, { date: addDays(D, 20), startTime: '10:00', dpAmount: 100000 })).data;
    const r = (await api(owner, 'POST', `/bookings/${b.id}/cancel`, { reason: 'NO_SHOW' })).data;
    assert.equal(r.paidAmount, 100000);
  });
  await R.test('US-13.4', '−', 'A cancelled booking cannot be edited, cancelled again or completed', async () => {
    assert.equal((await api(owner, 'PATCH', `/bookings/${joyce.id}`, bodyOf(joyce))).data.code, 'CANCELLED');
    assert.equal((await api(owner, 'POST', `/bookings/${joyce.id}/cancel`, { reason: 'OTHER' })).data.code, 'NOT_CONFIRMED');
    assert.equal((await api(owner, 'POST', `/bookings/${joyce.id}/complete`, { paidAmount: 0 })).data.code, 'NOT_CONFIRMED');
  });
  let doneBooking;
  await R.test('US-15.2', '+', 'An ended Confirmed session appears under "To close"', async () => {
    doneBooking = (await book(owner, { date: `${M}-05`, startTime: '10:00', clientName: 'Claire' })).data;
    assert.ok((await api(owner, 'GET', '/bookings?toClose=true')).data.some((b) => b.id === doneBooking.id));
  });
  await R.test('EDGE-15b', '−', 'Staff cannot complete a booking or record a payment (Owner-only money actions)', async () => {
    assert.equal((await api(staff, 'POST', `/bookings/${doneBooking.id}/complete`, { paidAmount: 0 })).status, 403);
    assert.equal((await api(staff, 'POST', `/bookings/${doneBooking.id}/payment`, { paidAmount: 0 })).status, 403);
  });
  await R.test('US-15.3', '−', 'Paid 500.000 on a 170.000 total → "Pembayaran tidak boleh melebihi total"', async () => {
    const r = await api(owner, 'POST', `/bookings/${doneBooking.id}/complete`, { paidAmount: 500000 });
    assert.equal(r.status, 400); assert.equal(r.data.fields.paidAmount, 'Pembayaran tidak boleh melebihi total');
  });
  await R.test('US-15.1', '+', 'Mark "Paid in full" + Complete → Completed, paid = total, balance 0, leaves "To close"', async () => {
    const r = (await api(owner, 'POST', `/bookings/${doneBooking.id}/complete`, { paidAmount: 170000 })).data;
    assert.equal(r.status, 'COMPLETED'); assert.equal(r.balance, 0);
    assert.ok(!(await api(owner, 'GET', '/bookings?toClose=true')).data.some((b) => b.id === doneBooking.id));
  });
  await R.test('EDGE-15a', '−', 'Staff cannot edit a Completed booking (Owner only)', async () => {
    const r = await api(staff, 'PATCH', `/bookings/${doneBooking.id}`, bodyOf((await api(owner, 'GET', `/bookings/${doneBooking.id}`)).data));
    assert.equal(r.status, 403);
  });

  // =====================================================================
  R.area('Invoice & WhatsApp — US-16, US-17');
  await R.test('US-16.1', '+', 'Invoice PDF: application/pdf, A5 page, under 300 KB, logo embedded', async () => {
    const r = await api(owner, 'GET', `/bookings/${lilin.id}/invoice.pdf`);
    assert.equal(r.status, 200); assert.match(r.type, /application\/pdf/);
    const txt = r.data.toString('latin1');
    assert.match(txt, /MediaBox \[0 0 419\.\d+ 595\.\d+\]/, 'A5 media box'); assert.match(txt, /\/Subtype \/Image/);
    assert.ok(r.data.length < 300 * 1024);
    assert.match(r.headers.get('content-disposition'), /Invoice_Lilin_/);
    return `${Math.round(r.data.length / 1024)} KB`;
  });
  await R.test('US-16.3', '+', 'After an edit the invoice number gets -R1', async () => {
    const r = await api(owner, 'PATCH', `/bookings/${lilin.id}`, bodyOf(lilin, { hours: 2 }));
    assert.equal(r.data.invoiceRev, 1);
    const pdf = await api(owner, 'GET', `/bookings/${lilin.id}/invoice.pdf`);
    assert.match(pdf.data.toString('latin1'), new RegExp(`INV-${lilin.bookingNo}-R1`));
    lilin = r.data;
  });
  await R.test('US-16.4', '−', 'Missing bank details → 409 "Tambahkan data rekening bank di Pengaturan", no PDF', async () => {
    await putSettings({ bankName: '', accountNo: '', accountHolder: '' });
    const r = await api(owner, 'GET', `/bookings/${lilin.id}/invoice.pdf`);
    await putSettings({ bankName: 'BCA', accountNo: '8888000111', accountHolder: 'JES Space Studio' });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'NO_BANK');
  });
  await R.test('US-16.5', '−', 'Cancelled booking has no invoice', async () => {
    const r = await api(owner, 'GET', `/bookings/${joyce.id}/invoice.pdf`);
    assert.equal(r.status, 409); assert.equal(r.data.code, 'CANCELLED');
  });
  await R.test('US-17.1', '+', 'New-booking message has name, schedule, items, total and bank details', async () => {
    const t = (await api(owner, 'GET', `/bookings/${lilin.id}/message?kind=NEW`)).data.text;
    for (const s of ['Halo kak Lilin', '14:00 – 16:00 WIB (2 jam)', 'MUA + Hairdo', '*Total: Rp2.048.000*', 'BCA 8888000111 a/n JES Space Studio']) assert.ok(t.includes(s), s);
  });
  await R.test('US-17.2', '+', 'Open WhatsApp link is wa.me/<62number>?text=<encoded message>', async () => {
    const m = (await api(owner, 'GET', `/bookings/${lilin.id}/message?kind=NEW`)).data;
    assert.equal(m.waUrl, `https://wa.me/6281234567890?text=${encodeURIComponent(m.text)}`);
  });
  await R.test('US-17.4', '−', 'No client number → no wa.me link (copy still available)', async () => {
    const b = (await book(owner, { date: addDays(D, 21), startTime: '10:00' })).data;
    const m = (await api(owner, 'GET', `/bookings/${b.id}/message?kind=NEW`)).data;
    assert.equal(m.waUrl, null); assert.ok(m.text.length > 50);
    cleanup.push(b.id);
  });
  await R.test('EDGE-17a', '+', 'Studio Only message drops the empty photographer line but keeps the type', async () => {
    const b = (await book(owner, { date: addDays(D, 21), startTime: '12:00' })).data;
    const t = (await api(owner, 'GET', `/bookings/${b.id}/message?kind=NEW`)).data.text;
    assert.ok(t.includes('📸 Studio Only')); assert.ok(!t.includes('Fotografer:'));
    cleanup.push(b.id);
  });
  await R.test('EDGE-17b', '+', 'Balance (pelunasan) and Cancel templates fill their specific fields', async () => {
    const bal = (await api(owner, 'GET', `/bookings/${lilin.id}/message?kind=BALANCE`)).data.text;
    assert.ok(bal.includes('*Sisa pelunasan: Rp1.548.000*'));
    const can = (await api(owner, 'GET', `/bookings/${joyce.id}/message?kind=CANCEL`)).data.text;
    assert.ok(can.includes('Alasan: Dibatalkan oleh klien — pindah kota'));
  });
  await R.test('EDGE-17c', '−', 'Unknown template kind → 400', async () => {
    assert.equal((await api(owner, 'GET', `/bookings/${lilin.id}/message?kind=PROMO`)).status, 400);
  });
  await R.test('L2-2.2.4', '+', '"Invoice sent" is recorded and can be undone', async () => {
    const a = (await api(owner, 'POST', `/bookings/${lilin.id}/invoice-sent`)).data;
    assert.ok(a.invoiceSentAt);
    const b = (await api(owner, 'DELETE', `/bookings/${lilin.id}/invoice-sent`)).data;
    assert.equal(b.invoiceSentAt, null);
  });

  // =====================================================================
  R.area('Admin — US-18 … US-21');
  let group;
  await R.test('US-18.1', '+', 'Add "Group Package" 699.000/h with photographer → bookable', async () => {
    group = (await api(owner, 'POST', '/booking-types', { name: `Group Package ${run}`, hourlyRate: 699000, requiresPhotographer: true, calendarKeyword: 'group' })).data;
    const r = await book(owner, { typeId: group.id, photographerId: HAMJA, date: addDays(D, 22), startTime: '10:00' });
    assert.equal(r.status, 201); assert.equal(r.data.total, 699000);
    cleanup.push(r.data.id);
  });
  await R.test('US-18.2', '+', 'Rate change applies to new bookings only (covered with US-09.3 and EDGE-13b)', async () => 'see US-09.3');
  await R.test('US-18.3', '−', 'Duplicate name differing only in case → 409 "Nama sudah ada"', async () => {
    const r = await api(owner, 'POST', '/booking-types', { name: 'studio only', hourlyRate: 1, requiresPhotographer: false });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'DUPLICATE');
  });
  await R.test('US-18.4', '−', 'A type used by bookings cannot be deleted (deactivate instead); an unused one can', async () => {
    assert.equal((await api(owner, 'DELETE', `/booking-types/${group.id}`)).data.code, 'IN_USE');
    const t = (await api(owner, 'POST', '/booking-types', { name: `Tmp ${run}`, hourlyRate: 1, requiresPhotographer: false })).data;
    assert.equal((await api(owner, 'DELETE', `/booking-types/${t.id}`)).status, 204);
    await api(owner, 'PATCH', `/booking-types/${group.id}`, { ...group, active: false });
  });
  await R.test('US-18.5', '−', 'Rate "-10" or "abc" → validation error', async () => {
    assert.equal((await api(owner, 'POST', '/booking-types', { name: 'X1', hourlyRate: -10, requiresPhotographer: false })).status, 400);
    assert.equal((await api(owner, 'POST', '/booking-types', { name: 'X2', hourlyRate: 'abc', requiresPhotographer: false })).status, 400);
  });
  let didi;
  await R.test('US-19.1', '+', 'Add photographer → selectable on Photo Package', async () => {
    didi = (await api(owner, 'POST', '/photographers', { name: `DidiL ${run}`, defaultFee: 300000, feeUnit: 'SESSION' })).data;
    const r = await book(owner, { typeId: PP.id, photographerId: didi.id, date: addDays(D, 23), startTime: '10:00' });
    assert.equal(r.status, 201); assert.equal(r.data.photographerNameSnap, didi.name);
    cleanup.push(r.data.id);
  });
  await R.test('US-19.3', '−', 'Deactivating a photographer with future bookings → 409 listing them; confirm=true proceeds', async () => {
    const r = await api(owner, 'PATCH', `/photographers/${didi.id}`, { ...didi, active: false });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'FUTURE_BOOKINGS'); assert.equal(r.data.bookings.length, 1);
    assert.equal((await api(owner, 'PATCH', `/photographers/${didi.id}?confirm=true`, { ...didi, active: false })).data.active, false);
  });
  await R.test('US-19.2', '+', 'After deactivation, existing bookings still show the photographer name', async () => {
    const b = (await api(owner, 'GET', `/bookings?q=${encodeURIComponent('Klien ' + run)}&from=${addDays(D, 23)}&to=${addDays(D, 23)}`)).data[0];
    assert.equal(b.photographerNameSnap, didi.name);
  });
  await R.test('US-19.4', '−', 'Empty photographer name → 400', async () => {
    assert.equal((await api(owner, 'POST', '/photographers', { name: '' })).status, 400);
  });
  let dress;
  await R.test('US-20.1', '+', 'Add "Dress rental" 150.000 per booking for Photo Package', async () => {
    dress = (await api(owner, 'POST', '/addons', { name: `Dress ${run}`, price: 150000, unit: 'BOOKING', typeIds: [PP.id] })).data;
    assert.deepEqual(dress.typeIds, [PP.id]);
    assert.equal((await book(owner, { date: D, startTime: '12:00', addons: [{ addonId: dress.id, qty: 1 }] })).status, 400, 'not for Studio Only');
  });
  await R.test('US-20.2', '+', 'Change unit to per hour 125.000 → new bookings price it × hours', async () => {
    await api(owner, 'PATCH', `/addons/${dress.id}`, { ...dress, price: 125000, unit: 'HOUR' });
    const r = await book(owner, { typeId: PP.id, photographerId: NAEL, date: addDays(D, 24), startTime: '10:00', hours: 2, addons: [{ addonId: dress.id, qty: 1 }] });
    assert.equal(r.data.addons[0].lineTotal, 250000);
    cleanup.push(r.data.id);
  });
  await R.test('US-20.3', '−', 'No applicable booking type ticked → "Pilih minimal satu jenis booking"', async () => {
    const r = await api(owner, 'POST', '/addons', { name: `NoType ${run}`, price: 1, unit: 'BOOKING', typeIds: [] });
    assert.equal(r.data.fields.typeIds, 'Pilih minimal satu jenis booking');
  });
  await R.test('US-20.4', '−', 'An add-on used on bookings cannot be deleted', async () => {
    assert.equal((await api(owner, 'DELETE', `/addons/${dress.id}`)).data.code, 'IN_USE');
  });
  await R.test('US-21.1', '+', 'Bank account in Settings appears in messages', async () => {
    const t = (await api(owner, 'GET', `/bookings/${lilin.id}/message?kind=BALANCE`)).data.text;
    assert.ok(t.includes('BCA 8888000111 a/n JES Space Studio'));
  });
  await R.test('US-21.2', '+', 'Saving a template with {client_name} and {total} changes the generated message', async () => {
    const orig = (await api(owner, 'GET', '/templates')).data.templates.find((t) => t.kind === 'BALANCE').body;
    await api(owner, 'PUT', '/templates/BALANCE', { body: 'Hai {client_name}, total {total}' });
    const t = (await api(owner, 'GET', `/bookings/${lilin.id}/message?kind=BALANCE`)).data.text;
    await api(owner, 'PUT', '/templates/BALANCE', { body: orig });
    assert.equal(t, 'Hai Lilin, total Rp2.048.000');
  });
  await R.test('US-21.3', '−', 'Template with {clientname} → "Placeholder tidak dikenal" listing the valid ones', async () => {
    const r = await api(owner, 'PUT', '/templates/NEW', { body: 'Halo {clientname}' });
    assert.equal(r.status, 400); assert.match(r.data.fields.body, /\{clientname\}.*Yang valid: \{client_name\}/);
  });
  await R.test('US-21.4', '−', 'Sunday close 10:00 before open 12:00 → "Jam tutup harus setelah jam buka"', async () => {
    const hours = settings0.openHours.map((h, i) => (i === 0 ? { open: '12:00', close: '10:00', closed: false } : h));
    const r = await putSettings({ bankName: 'BCA', accountNo: '8888000111', accountHolder: 'JES Space Studio', openHours: hours });
    assert.equal(r.status, 400); assert.equal(r.data.fields['openHours.0.close'], 'Jam tutup harus setelah jam buka');
  });

  // =====================================================================
  R.area('Expenses & fees — US-22 … US-25');
  // finance month M: B1 PP 2h + 7 persons (DP 300K, completed paid 1.000.000), B2 Studio 2h −40K, B3 cancelled
  const B1 = (await book(owner, { typeId: PP.id, photographerId: HAMJA, date: `${M}-10`, startTime: '10:00', hours: 2, clientName: 'Claire', addons: [{ addonId: A('Extra person'), qty: 7 }], dpAmount: 300000 })).data;
  const B2 = (await book(owner, { date: `${M}-12`, startTime: '10:00', hours: 2, clientName: 'Dea', adjustment: -40000, adjustmentReason: 'Langganan' })).data;
  const B3 = (await book(owner, { date: `${M}-14`, startTime: '10:00', clientName: 'Batal' })).data;
  await api(owner, 'POST', `/bookings/${B3.id}/cancel`, { reason: 'CUSTOMER_CANCELLED' });
  let listrik, deco, fee;
  await R.test('US-24.1', '+', 'Completing Hamja\'s Photo Package drafts "Fee fotografer — Hamja — <no>" for Rp250.000', async () => {
    const r = (await api(owner, 'POST', `/bookings/${B1.id}/complete`, { paidAmount: 1000000 })).data;
    fee = r.expenses.find((e) => e.source === 'BOOKING_FEE');
    assert.equal(fee.status, 'DRAFT'); assert.equal(fee.amount, 250000); assert.equal(fee.note, `Fee fotografer — Hamja — ${B1.bookingNo}`);
  });
  await R.test('US-22.1', '+', 'Electricity Rp500.000, payee PLN, with a bill photo → saved under its month', async () => {
    listrik = (await api(owner, 'POST', '/expenses', { categoryId: CAT('Listrik'), amount: 500000, paidOn: `${M}-03`, payee: 'PLN' })).data;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
    const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'tagihan.png');
    const up = await api(owner, 'POST', `/expenses/${listrik.id}/receipt`, fd);
    assert.equal(up.status, 200); assert.equal(up.data.receiptMime, 'image/png');
    const back = await api(owner, 'GET', `/expenses/${listrik.id}/receipt`);
    assert.equal(back.status, 200); assert.equal(back.data.length, png.length);
    assert.ok((await api(owner, 'GET', `/expenses?month=${M}`)).data.some((e) => e.id === listrik.id));
  });
  await R.test('US-22.2', '+', 'Decoration Rp120.000 linked to Claire\'s booking shows on the booking with its margin', async () => {
    deco = (await api(owner, 'POST', '/expenses', { categoryId: CAT('Dekorasi & properti'), amount: 120000, paidOn: `${M}-09`, payee: 'Toko balon', bookingId: B1.id })).data;
    const b = (await api(owner, 'GET', `/bookings/${B1.id}`)).data;
    assert.ok(b.expenses.some((e) => e.id === deco.id)); assert.equal(b.margin.costs, 120000); assert.equal(b.margin.margin, 1373000 - 120000);
  });
  await R.test('US-22.3', '−', 'Amount empty or 0 → "Masukkan jumlah di atas Rp0"', async () => {
    const r = await api(owner, 'POST', '/expenses', { categoryId: CAT('Listrik'), amount: 0, paidOn: `${M}-03` });
    assert.equal(r.data.fields.amount, 'Masukkan jumlah di atas Rp0');
    assert.equal((await api(owner, 'POST', '/expenses', { categoryId: CAT('Listrik'), paidOn: `${M}-03` })).status, 400);
  });
  await R.test('US-22.4', '−', 'Date paid tomorrow → "Tanggal tidak boleh di masa depan"', async () => {
    const r = await api(owner, 'POST', '/expenses', { categoryId: CAT('Listrik'), amount: 1000, paidOn: addDays(today, 1) });
    assert.equal(r.data.fields.paidOn, 'Tanggal tidak boleh di masa depan');
  });
  await R.test('US-22.5', '−', 'Same category, amount and date → "Sepertinya duplikat"; force saves a second one', async () => {
    const r = await api(owner, 'POST', '/expenses', { categoryId: CAT('Listrik'), amount: 500000, paidOn: `${M}-03` });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'DUPLICATE_SUSPECT');
    const forced = await api(owner, 'POST', '/expenses', { categoryId: CAT('Listrik'), amount: 500000, paidOn: `${M}-03`, force: true });
    assert.equal(forced.status, 201);
    await api(owner, 'DELETE', `/expenses/${forced.data.id}`);
  });
  await R.test('US-22.6', '−', 'Staff cannot reach expenses (list, create, receipt)', async () => {
    assert.equal((await api(staff, 'GET', '/expenses')).status, 403);
    assert.equal((await api(staff, 'GET', `/expenses/${listrik.id}/receipt`)).status, 403);
  });
  await R.test('EDGE-22a', '−', 'Receipt larger than 5 MB → 413; a text file renamed .png → 400', async () => {
    const big = new FormData(); big.append('file', new Blob([Buffer.alloc(6 * 1024 * 1024, 0xff)], { type: 'image/jpeg' }), 'big.jpg');
    assert.equal((await api(owner, 'POST', `/expenses/${listrik.id}/receipt`, big)).status, 413);
    const fake = new FormData(); fake.append('file', new Blob(['hello'], { type: 'image/png' }), 'fake.png');
    const r = await api(owner, 'POST', `/expenses/${listrik.id}/receipt`, fake);
    assert.equal(r.status, 400); assert.equal(r.data.message, 'Hanya JPG, PNG atau PDF');
  });
  await R.test('US-24.5', '−', 'Photographer without default fee → draft with empty amount that must be filled to confirm', async () => {
    const nofee = (await api(owner, 'POST', '/photographers', { name: `NoFee ${run}` })).data;
    const b = (await book(owner, { typeId: PP.id, photographerId: nofee.id, date: addDays(D, 25), startTime: '10:00' })).data;
    const e = (await api(owner, 'POST', `/bookings/${b.id}/complete`, { paidAmount: 0 })).data.expenses[0];
    assert.equal(e.amount, null); assert.equal(e.status, 'DRAFT');
    assert.equal((await api(owner, 'POST', `/expenses/${e.id}/confirm`, {})).status, 400);
    await api(owner, 'DELETE', `/expenses/${e.id}`);
  });
  await R.test('US-24.3', '+', 'Owner shot it herself → confirming Rp0 records "no fee" and clears the to-do', async () => {
    const hourly = (await api(owner, 'POST', '/photographers', { name: `Hourly ${run}`, defaultFee: 100000, feeUnit: 'HOUR' })).data;
    const b = (await book(owner, { typeId: PP.id, photographerId: hourly.id, date: addDays(D, 26), startTime: '10:00', hours: 3 })).data;
    const e = (await api(owner, 'POST', `/bookings/${b.id}/complete`, { paidAmount: 0 })).data.expenses[0];
    assert.equal(e.amount, 300000, 'per-hour fee × 3 h');
    const c = (await api(owner, 'POST', `/expenses/${e.id}/confirm`, { amount: 0 })).data;
    assert.equal(c.status, 'CONFIRMED'); assert.equal(c.amount, 0);
    assert.ok(!(await api(owner, 'GET', '/expenses?status=DRAFT')).data.some((x) => x.id === e.id));
  });
  await R.test('US-24.4', '−', 'A booking cancelled before completion creates no fee draft', async () => {
    const b = (await book(owner, { typeId: PP.id, photographerId: HAMJA, date: addDays(D, 27), startTime: '10:00' })).data;
    const c = (await api(owner, 'POST', `/bookings/${b.id}/cancel`, { reason: 'STUDIO_CANCELLED' })).data;
    assert.equal(c.expenses.length, 0);
  });
  await R.test('US-24.6', '+', 'MUA add-on with a vendor fee drafts an MUA fee on completion', async () => {
    const mua = (await api(owner, 'POST', '/addons', { name: `MUA vendor ${run}`, price: 500000, unit: 'BOOKING', typeIds: [SO.id], vendorFee: 300000, vendorName: 'Rina MUA' })).data;
    const b = (await book(owner, { date: addDays(D, 28), startTime: '10:00', addons: [{ addonId: mua.id, qty: 1 }] })).data;
    const ex = (await api(owner, 'POST', `/bookings/${b.id}/complete`, { paidAmount: 670000 })).data.expenses;
    const m = ex.find((e) => e.payee === 'Rina MUA');
    assert.equal(m.amount, 300000); assert.equal(m.status, 'DRAFT');
    await api(owner, 'DELETE', `/expenses/${m.id}`);
  });
  await R.test('US-25.1', '+', 'Add "Laundry (dress)" as Variable → available for expenses', async () => {
    const c = (await api(owner, 'POST', '/expense-categories', { name: `Laundry ${run}`, kind: 'VARIABLE' })).data;
    const e = await api(owner, 'POST', '/expenses', { categoryId: c.id, amount: 45000, paidOn: today });
    assert.equal(e.status, 201);
    await api(owner, 'DELETE', `/expenses/${e.data.id}`);
  });
  await R.test('US-25.2', '+', 'A recurring Fixed category gets a draft for the current month from the worker', async () => {
    const c = (await api(owner, 'POST', '/expense-categories', { name: `Wifi ${run}`, kind: 'FIXED', recurring: true, defaultAmount: 350000 })).data;
    execFileSync('docker', ['compose', 'restart', 'worker'], { cwd: ROOT, stdio: 'ignore' });
    let d;
    for (let i = 0; i < 20 && !d; i++) { await sleep(1000); d = (await api(owner, 'GET', '/expenses?status=DRAFT')).data.find((e) => e.categoryId === c.id); }
    assert.ok(d, 'no recurring draft'); assert.equal(d.amount, 350000); assert.equal(d.paidOn, `${today.slice(0, 7)}-01`);
    await api(owner, 'DELETE', `/expenses/${d.id}`);
    await api(owner, 'PATCH', `/expense-categories/${c.id}`, { name: c.name, kind: 'FIXED', recurring: false, active: false });
  });
  await R.test('US-25.3', '−', '"internet" when "Internet" exists → 409', async () => {
    assert.equal((await api(owner, 'POST', '/expense-categories', { name: 'internet', kind: 'FIXED' })).status, 409);
  });
  await R.test('US-25.4', '−', 'A category with expenses, or a system category, cannot be deleted', async () => {
    assert.equal((await api(owner, 'DELETE', `/expense-categories/${CAT('Listrik')}`)).data.code, 'IN_USE');
    assert.equal((await api(owner, 'DELETE', `/expense-categories/${CAT('Fee fotografer')}`)).data.code, 'IN_USE');
  });

  // =====================================================================
  R.area('Monthly recap, export, close — US-23, US-26, US-27');
  await R.test('US-26.1', '+', 'Recap: revenue by type + add-ons + adjustments = total; expenses; net; margin; previous month', async () => {
    const r = (await api(owner, 'GET', `/reports/recap?month=${M}`)).data;
    const pp = r.revenue.byType.find((t) => t.name === 'Photo Package'), so = r.revenue.byType.find((t) => t.name === 'Studio Only');
    assert.equal(pp.amount, 1198000); assert.equal(so.amount, 340000 + 170000); assert.equal(so.count, 2); assert.equal(r.revenue.addons, 175000); assert.equal(r.revenue.adjustments, -40000);
    assert.equal(r.revenue.total, 1673000 + 170000, 'B1 + B2 + Claire 170K');
    assert.equal(r.expenses.total, 620000); assert.equal(r.netProfit, 1843000 - 620000);
    assert.equal(r.marginPct, Math.round((1223000 / 1843000) * 1000) / 10);
    assert.ok(r.previous.month < M);
    assert.equal(r.revenue.bookingCount, 3, 'cancelled B3 excluded');
    return `revenue ${r.revenue.total}, expenses ${r.expenses.total}, net ${r.netProfit}, margin ${r.marginPct}%`;
  });
  await R.test('US-26.2', '+', 'Drill-down: category filter returns that category\'s expenses', async () => {
    const r = (await api(owner, 'GET', `/expenses?month=${M}&categoryId=${CAT('Listrik')}&status=CONFIRMED`)).data;
    assert.deepEqual(r.map((e) => e.id), [listrik.id]);
  });
  await R.test('US-26.3', '+', 'Receivables list the bookings with a balance', async () => {
    const r = (await api(owner, 'GET', `/reports/recap?month=${M}`)).data;
    assert.equal(r.receivables.total, 373000 + 300000);
    assert.deepEqual(r.receivables.items.map((i) => i.bookingNo).sort(), [B1.bookingNo, B2.bookingNo].sort());
  });
  await R.test('US-26.4', '+', 'Collected basis = amounts actually paid', async () => {
    const r = (await api(owner, 'GET', `/reports/recap?month=${M}&basis=COLLECTED`)).data;
    assert.equal(r.basis, 'COLLECTED'); assert.equal(r.revenue.total, 1000000 + 0 + 170000);
  });
  await R.test('US-26.5', '−', 'Drafts are excluded and reported: "1 draft (Rp250.000)"', async () => {
    const r = (await api(owner, 'GET', `/reports/recap?month=${M}`)).data;
    assert.equal(r.drafts.count, 1); assert.equal(r.drafts.amount, 250000);
  });
  await R.test('US-24.2', '+', 'Confirming the draft fee adds it to Photographer fees', async () => {
    await api(owner, 'POST', `/expenses/${fee.id}/confirm`, { amount: 250000 });
    const r = (await api(owner, 'GET', `/reports/recap?month=${M}`)).data;
    assert.equal(r.expenses.byCategory.find((c) => c.name === 'Fee fotografer').amount, 250000); assert.equal(r.drafts.count, 0);
  });
  await R.test('US-23.1', '+', 'Editing 500.000 → 450.000 updates totals immediately and writes an audit row', async () => {
    await api(owner, 'PATCH', `/expenses/${listrik.id}`, { categoryId: CAT('Listrik'), amount: 450000, paidOn: `${M}-03`, payee: 'PLN' });
    const r = (await api(owner, 'GET', `/reports/recap?month=${M}`)).data;
    assert.equal(r.expenses.total, 450000 + 120000 + 250000);
    assert.equal(sql(`SELECT count(*) FROM expense_audit WHERE expense_id = '${listrik.id}' AND action = 'EDIT'`), '1');
  });
  await R.test('US-23.2', '+', 'Deleting removes it from totals but keeps it in the audit log (soft delete)', async () => {
    assert.equal((await api(owner, 'DELETE', `/expenses/${deco.id}`)).status, 204);
    const r = (await api(owner, 'GET', `/reports/recap?month=${M}`)).data;
    assert.equal(r.expenses.total, 450000 + 250000);
    assert.equal(sql(`SELECT deleted_at IS NOT NULL FROM expenses WHERE id = '${deco.id}'`), 't');
    assert.equal(sql(`SELECT count(*) FROM expense_audit WHERE expense_id = '${deco.id}' AND action = 'DELETE'`), '1');
  });
  await R.test('US-26.6', '−', 'Expenses above revenue show as a negative net (loss)', async () => {
    await api(owner, 'POST', '/expenses', { categoryId: CAT('Sewa ruko'), amount: 450000, paidOn: `${M2}-01` });
    const r = (await api(owner, 'GET', `/reports/recap?month=${M2}`)).data;
    assert.equal(r.netProfit, -450000); assert.equal(r.marginPct, null);
  });
  await R.test('US-26.7', '−', 'A month with nothing returns zeros, no error', async () => {
    const r = await api(owner, 'GET', `/reports/recap?month=${M3}`);
    assert.equal(r.status, 200); assert.equal(r.data.revenue.total, 0); assert.equal(r.data.expenses.total, 0); assert.equal(r.data.netProfit, 0);
  });
  await R.test('EDGE-26a', '−', 'Malformed month → 400', async () => {
    assert.equal((await api(owner, 'GET', '/reports/recap?month=2026-13x')).status, 400);
  });
  await R.test('US-27.1', '+', 'CSV: Date, Client, Description, Amount; bookings, negative expense rows, Total row', async () => {
    const r = await api(owner, 'GET', `/reports/recap.csv?month=${M}`);
    const lines = r.data.toString('utf8').replace(/^﻿/, '').split('\r\n');
    assert.equal(lines[0], 'Date,Client,Description,Amount');
    assert.ok(lines.some((l) => l.startsWith(`${M}-10,Claire,Photo Package 2 jam + Extra person x7,1373000`)));
    assert.ok(lines.some((l) => l === `${M}-03,PLN,Listrik,-450000`));
    assert.equal(lines.at(-1), `,,Total,${1843000 - 700000}`);
  });
  await R.test('US-27.2', '+', 'One-page recap PDF', async () => {
    const r = await api(owner, 'GET', `/reports/recap.pdf?month=${M}`);
    assert.equal(r.status, 200); assert.match(r.type, /pdf/); assert.equal((r.data.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length, 1);
  });
  await R.test('US-27.4', '−', 'Close month with drafts left → "Konfirmasi atau hapus 1 draft dulu"', async () => {
    const d = (await api(owner, 'POST', '/expenses', { categoryId: CAT('Listrik'), amount: 1, paidOn: `${M}-20` })).data;
    sql(`UPDATE expenses SET status = 'DRAFT' WHERE id = '${d.id}'`);
    const r = await api(owner, 'POST', `/reports/months/${M}/close`);
    assert.equal(r.data.code, 'DRAFTS_LEFT');
    await api(owner, 'DELETE', `/expenses/${d.id}`);
  });
  await R.test('EDGE-27a', '−', 'The current month cannot be closed', async () => {
    assert.equal((await api(owner, 'POST', `/reports/months/${today.slice(0, 7)}/close`)).status, 400);
  });
  await R.test('US-27.3', '+', 'Closed month: bookings and expenses become read-only (edit, add, pay, reschedule in/out)', async () => {
    assert.equal((await api(owner, 'POST', `/reports/months/${M}/close`)).status, 200);
    assert.equal((await api(owner, 'PATCH', `/expenses/${listrik.id}`, { categoryId: CAT('Listrik'), amount: 1, paidOn: `${M}-03` })).data.code, 'MONTH_CLOSED');
    assert.equal((await api(owner, 'POST', '/expenses', { categoryId: CAT('Listrik'), amount: 1, paidOn: `${M}-04`, force: true })).data.code, 'MONTH_CLOSED');
    assert.equal((await api(owner, 'POST', `/bookings/${B1.id}/payment`, { paidAmount: 1373000 })).data.code, 'MONTH_CLOSED');
    const b2 = (await api(owner, 'GET', `/bookings/${B2.id}`)).data;
    assert.equal((await api(owner, 'PATCH', `/bookings/${B2.id}`, bodyOf(b2, { date: addDays(D, 40) }))).data.code, 'MONTH_CLOSED', 'move out');
    assert.equal((await book(owner, { date: `${M}-25`, startTime: '10:00' })).data.code, 'MONTH_CLOSED', 'add into');
  });
  await R.test('US-27.5', '−', 'Reopen without a reason → "Alasan wajib diisi"; with a reason it reopens', async () => {
    const r = await api(owner, 'POST', `/reports/months/${M}/reopen`, { reason: '' });
    assert.equal(r.status, 400); assert.equal(r.data.message, 'Alasan wajib diisi');
    assert.equal((await api(owner, 'POST', `/reports/months/${M}/reopen`, { reason: 'Koreksi tagihan listrik' })).data.closed, false);
    assert.equal((await api(owner, 'POST', `/bookings/${B1.id}/payment`, { paidAmount: 1373000 })).status, 200);
  });

  // =====================================================================
  R.area('Google Calendar — US-28, US-29');
  await R.test('US-29.10', '−', 'Calendar not connected: booking saves with no sync status', async () => {
    const b = (await book(owner, { date: addDays(D, 30), startTime: '10:00' })).data;
    assert.equal(b.gcalSyncStatus, 'NONE');
    cleanup.push(b.id);
  });
  await R.test('US-28.4', '−', 'Status "Not connected"; connect is refused until the OAuth client is configured', async () => {
    const s = (await api(owner, 'GET', '/integrations/google')).data;
    assert.equal(s.gcalStatus, 'NOT_CONNECTED');
    if (s.configured) R.skip('OAuth client configured — consent flow needs a human');
    assert.equal((await api(owner, 'GET', '/integrations/google/auth-url')).data.code, 'GOOGLE_NOT_CONFIGURED');
  });
  await R.test('US-28.6', '−', 'Staff cannot open the Integrations endpoints', async () => {
    for (const p of ['/integrations/google', '/integrations/google/calendars']) assert.equal((await api(staff, 'GET', p)).status, 403);
    assert.equal((await api(staff, 'POST', '/integrations/google/resync')).status, 403);
  });
  await R.test('OAUTH-x1', '−', 'OAuth callback with a forged state redirects with error=state and stores nothing', async () => {
    const r = await api(null, 'GET', '/integrations/google/callback?code=abc&state=forged');
    assert.equal(r.status, 302); assert.match(r.headers.get('location'), /\/admin\/integrations\?error=state$/);
  });
  // simulate a connected-but-unreachable Google: the worker cannot complete any call
  sql(`UPDATE settings SET gcal_status='CONNECTED', gcal_calendar_id='test-calendar', gcal_refresh_token='invalid' WHERE id=1`);
  let gb;
  try {
    await R.test('US-29.6', '−', 'Google unreachable: booking still saves instantly with status Pending and an outbox job', async () => {
      const r = await book(owner, { date: addDays(D, 31), startTime: '10:00' });
      assert.equal(r.status, 201); assert.equal(r.data.gcalSyncStatus, 'PENDING'); assert.ok(r.ms < 2000, `${Math.round(r.ms)} ms`);
      gb = r.data;
      assert.equal(sql(`SELECT op FROM sync_outbox WHERE booking_id='${gb.id}' AND done_at IS NULL`), 'UPSERT');
      return `saved in ${Math.round(r.ms)} ms`;
    });
    await R.test('US-29.7', '−', 'Retries back off 30 s → 2 m → 10 m → 1 h, then Failed with error; Retry re-queues', async () => {
      let attempts = '0';
      for (let i = 0; i < 20 && attempts === '0'; i++) { await sleep(500); attempts = sql(`SELECT attempts FROM sync_outbox WHERE booking_id='${gb.id}' AND done_at IS NULL`); }
      assert.equal(attempts, '1', 'worker made the first attempt');
      const wait = Number(sql(`SELECT round(extract(epoch from next_run_at - now())) FROM sync_outbox WHERE booking_id='${gb.id}' AND done_at IS NULL`));
      assert.ok(wait > 20 && wait <= 30, `first backoff ${wait}s`);
      sql(`UPDATE sync_outbox SET attempts = 4, next_run_at = now() WHERE booking_id='${gb.id}' AND done_at IS NULL`);
      let st;
      for (let i = 0; i < 40 && st !== 'FAILED'; i++) { await sleep(1000); st = (await api(owner, 'GET', `/bookings/${gb.id}`)).data.gcalSyncStatus; }
      assert.equal(st, 'FAILED');
      const b = (await api(owner, 'GET', `/bookings/${gb.id}`)).data;
      assert.ok(b.gcalLastError);
      const retry = (await api(owner, 'POST', `/bookings/${gb.id}/sync`)).data;
      assert.equal(retry.gcalSyncStatus, 'PENDING');
      return `last error: ${b.gcalLastError.slice(0, 60)}`;
    });
    await R.test('US-29.4', '+', 'Cancelling a synced booking queues a calendar DELETE', async () => {
      sql(`UPDATE bookings SET gcal_event_id='evt-test' WHERE id='${gb.id}'`);
      await api(owner, 'POST', `/bookings/${gb.id}/cancel`, { reason: 'OTHER' });
      assert.equal(sql(`SELECT op FROM sync_outbox WHERE booking_id='${gb.id}' AND done_at IS NULL AND failed_at IS NULL ORDER BY id DESC LIMIT 1`), 'DELETE');
    });
    await R.test('US-29.2', '+', 'An edit supersedes the queued job (one job per booking, no duplicate events)', async () => {
      const b = (await book(owner, { date: addDays(D, 32), startTime: '10:00' })).data;
      await api(owner, 'PATCH', `/bookings/${b.id}`, bodyOf(b, { startTime: '12:00' }));
      assert.equal(sql(`SELECT count(*) FROM sync_outbox WHERE booking_id='${b.id}' AND done_at IS NULL AND failed_at IS NULL`), '1');
      cleanup.push(b.id);
    });
  } finally {
    sql(`UPDATE settings SET gcal_status='NOT_CONNECTED', gcal_calendar_id=NULL, gcal_refresh_token=NULL WHERE id=1`);
    sql(`UPDATE sync_outbox SET done_at = now(), last_error = 'test cleanup' WHERE done_at IS NULL AND failed_at IS NULL`);
    sql(`UPDATE bookings SET gcal_sync_status='NONE' WHERE gcal_sync_status IN ('PENDING','FAILED')`);
  }
  for (const id of ['US-28.1', 'US-28.2', 'US-28.3', 'US-28.5', 'US-29.1', 'US-29.3', 'US-29.5', 'US-29.8', 'US-29.9']) {
    await R.test(id, id === 'US-28.5' || id >= 'US-29.8' ? '−' : '+', 'Needs a real Google account and OAuth client (event create/patch/delete, consent, revocation)', async () => R.skip('requires GOOGLE_CLIENT_ID/SECRET and a test calendar'));
  }
} finally {
  // free the future-day slots so reruns and manual testing stay clean
  for (const id of cleanup) await api(owner, 'POST', `/bookings/${id}/cancel`, { reason: 'OTHER', note: 'test cleanup' });
  await api(owner, 'PUT', '/settings', settings0);
}
R.done();
