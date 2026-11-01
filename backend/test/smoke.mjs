// API smoke test against a running stack: node backend/test/smoke.mjs [baseUrl]
// Walks the PRD acceptance scenarios that matter most. Creates data; run on a dev database only.
import assert from 'node:assert/strict';

const BASE = (process.argv[2] ?? 'http://localhost:3000') + '/api/v1';
const OWNER = { email: process.env.OWNER_EMAIL ?? 'owner@jes.local', password: process.env.OWNER_PASSWORD ?? '' };
const STAFF = { email: process.env.STAFF_EMAIL ?? 'staff@jes.local', password: process.env.STAFF_PASSWORD ?? '' };

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`✔ ${name}`); }
  catch (e) { console.error(`✘ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

async function api(token, method, path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await r.json() : await r.arrayBuffer();
  return { status: r.status, data, type };
}

const wib = (offsetDays) => new Date(Date.now() + 7 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const login = async (u) => (await api(null, 'POST', '/auth/login', u)).data.accessToken;

const owner = await login(OWNER);
const staff = await login(STAFF);
assert.ok(owner && staff, 'login failed — is the stack up and are the seed passwords right?');

const types = (await api(owner, 'GET', '/booking-types')).data;
const addons = (await api(owner, 'GET', '/addons')).data;
const photographers = (await api(owner, 'GET', '/photographers')).data;
const pkg = types.find((t) => t.name === 'Photo Package');
const studio = types.find((t) => t.name === 'Studio Only');
const addon = (n) => addons.find((a) => a.name === n).id;
const hamja = photographers.find((p) => p.name === 'Hamja');
// a random far-future day so reruns don't collide
const day = wib(30 + Math.floor(Math.random() * 300));

await step('US-01.2 refresh cookie rotates; parallel refresh (two tabs) both succeed; logout ends it', async () => {
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const refresh = (c) => fetch(BASE + '/auth/refresh', { method: 'POST', headers: { cookie: c } });
  const [a, b] = await Promise.all([refresh(cookie), refresh(cookie)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.ok((await a.json()).accessToken);
  const next = a.headers.get('set-cookie').split(';')[0];
  await fetch(BASE + '/auth/logout', { method: 'POST', headers: { cookie: next } });
  assert.equal((await refresh(next)).status, 401);
});

await step('US-01.3 wrong password → generic message', async () => {
  const r = await api(null, 'POST', '/auth/login', { email: OWNER.email, password: 'nope' });
  assert.equal(r.status, 401);
  assert.equal(r.data.message, 'Email atau kata sandi salah');
});

const settings = (await api(owner, 'GET', '/settings')).data;
await api(owner, 'PUT', '/settings', { ...settings, bankName: 'BCA', accountNo: '1234567890', accountHolder: 'JES Space Studio' });

let booking;
await step('US-09.1 Photo Package 1h + MUA hairdo + Dekorasi, DP 500K → 1.449.000 / balance 949.000', async () => {
  const r = await api(owner, 'POST', '/bookings', {
    typeId: pkg.id, hours: 1, date: day, startTime: '14:00', clientName: 'Lilin', clientPhone: '0821 2350 0508',
    photographerId: hamja.id, addons: [{ addonId: addon('MUA + Hairdo'), qty: 1 }, { addonId: addon('Dekorasi'), qty: 1 }], dpAmount: 500000,
  }, { 'idempotency-key': `smoke-${day}` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  booking = r.data;
  assert.equal(booking.total, 1449000);
  assert.equal(booking.balance, 949000);
  assert.equal(booking.clientPhoneSnap, '6282123500508');
  assert.match(booking.bookingNo, /^JES-\d{6}-\d{3}$/);
});

await step('US-11.3 retry with same Idempotency-Key returns the same booking', async () => {
  const r = await api(owner, 'POST', '/bookings', {
    typeId: pkg.id, hours: 1, date: day, startTime: '14:00', clientName: 'Lilin', photographerId: hamja.id, addons: [],
  }, { 'idempotency-key': `smoke-${day}` });
  assert.equal(r.data.id, booking.id);
});

await step('US-05.3 overlapping slot → 409 naming the clash', async () => {
  const r = await api(owner, 'POST', '/bookings', { typeId: studio.id, hours: 1, date: day, startTime: '14:30', clientName: 'Dea', addons: [] });
  assert.equal(r.status, 409);
  assert.match(r.data.message, new RegExp(booking.bookingNo));
});

await step('NFR-05 two devices saving the same slot at once → exactly one wins', async () => {
  const body = { typeId: studio.id, hours: 2, date: day, startTime: '17:00', clientName: 'Race', addons: [] };
  const rs = await Promise.all([1, 2, 3].map(() => api(owner, 'POST', '/bookings', body)));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409]);
});

await step('US-05.4 ending after closing needs a reason', async () => {
  const r = await api(owner, 'POST', '/bookings', { typeId: studio.id, hours: 2, date: day, startTime: '20:00', clientName: 'Late', addons: [] });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'AFTER_HOURS');
  const ok = await api(owner, 'POST', '/bookings', { typeId: studio.id, hours: 2, date: day, startTime: '20:00', clientName: 'Late', addons: [], afterHoursReason: 'Klien minta malam' });
  assert.equal(ok.status, 201);
});

await step('US-07.3 Photo Package without photographer is rejected', async () => {
  const r = await api(owner, 'POST', '/bookings', { typeId: pkg.id, hours: 1, date: day, startTime: '10:00', clientName: 'Nopho', addons: [] });
  assert.equal(r.status, 400);
  assert.equal(r.data.fields.photographerId, 'Pilih fotografer');
});

await step('US-08.4 Dekorasi is not available on Studio Only', async () => {
  const r = await api(owner, 'POST', '/bookings', { typeId: studio.id, hours: 1, date: day, startTime: '10:00', clientName: 'Deco', addons: [{ addonId: addon('Dekorasi'), qty: 1 }] });
  assert.equal(r.status, 400);
});

await step('US-10.3/10.4 adjustment needs reason; DP cannot exceed total', async () => {
  const a = await api(owner, 'POST', '/bookings', { typeId: studio.id, hours: 2, date: day, startTime: '10:00', clientName: 'Adj', addons: [], adjustment: -40000 });
  assert.equal(a.data.fields?.adjustmentReason, 'Alasan wajib diisi');
  const d = await api(owner, 'POST', '/bookings', { typeId: studio.id, hours: 2, date: day, startTime: '10:00', clientName: 'Adj', addons: [], dpAmount: 400000 });
  assert.equal(d.data.fields?.dpAmount, 'DP tidak boleh melebihi total');
});

await step('US-13.2 edit adds an add-on → new total, invoice revision R1, history logged', async () => {
  const r = await api(owner, 'PATCH', `/bookings/${booking.id}`, {
    typeId: pkg.id, hours: 1, date: day, startTime: '14:00', clientName: 'Lilin', clientPhone: '082123500508', photographerId: hamja.id,
    addons: [{ addonId: addon('MUA + Hairdo'), qty: 1 }, { addonId: addon('Dekorasi'), qty: 1 }, { addonId: addon('Extra person'), qty: 5 }], dpAmount: 500000,
  }, { 'if-match': String(booking.version) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.total, 1449000 + 125000);
  assert.equal(r.data.invoiceRev, 1);
  assert.ok(r.data.history.some((h) => h.field === 'total'));
  booking = r.data;
});

await step('If-Match with a stale version → 409 STALE', async () => {
  const r = await api(owner, 'PATCH', `/bookings/${booking.id}`, {
    typeId: pkg.id, hours: 1, date: day, startTime: '14:00', clientName: 'Lilin', photographerId: hamja.id, addons: [], dpAmount: 0,
  }, { 'if-match': '1' });
  assert.equal(r.data.code, 'STALE');
});

await step('US-09.3 / US-18.2 master price change keeps the booking snapshot', async () => {
  await api(owner, 'PATCH', `/booking-types/${pkg.id}`, { ...pkg, hourlyRate: 650000 });
  const r = await api(owner, 'GET', `/bookings/${booking.id}`);
  assert.equal(r.data.rateSnap, 599000);
  await api(owner, 'PATCH', `/booking-types/${pkg.id}`, { ...pkg, hourlyRate: 599000 });
});

await step('US-16 invoice PDF is generated with revision number', async () => {
  const r = await api(owner, 'GET', `/bookings/${booking.id}/invoice.pdf`);
  assert.equal(r.status, 200);
  assert.match(r.type, /pdf/);
  assert.ok(r.data.byteLength > 1000 && r.data.byteLength < 300 * 1024, `size ${r.data.byteLength}`);
});

await step('US-17 WhatsApp message is filled and wa.me link built', async () => {
  const r = await api(owner, 'GET', `/bookings/${booking.id}/message?kind=NEW`);
  assert.match(r.data.text, /Halo kak Lilin/);
  assert.match(r.data.text, /Rp1\.574\.000/);
  assert.match(r.data.waUrl, /^https:\/\/wa\.me\/6282123500508\?text=/);
});

await step('US-02 Staff: no finance/admin; adjustment ignored; no past dates', async () => {
  assert.equal((await api(staff, 'GET', '/expenses')).status, 403);
  assert.equal((await api(staff, 'POST', '/booking-types', { name: 'X', hourlyRate: 1, requiresPhotographer: false })).status, 403);
  const r = await api(staff, 'POST', '/bookings', { typeId: studio.id, hours: 1, date: day, startTime: '09:00', clientName: 'StaffBook', addons: [], adjustment: -100000, adjustmentReason: 'x' });
  assert.equal(r.status, 201);
  assert.equal(r.data.total, 170000);
  const p = await api(staff, 'POST', '/bookings', { typeId: studio.id, hours: 1, date: wib(-3), startTime: '09:00', clientName: 'Past', addons: [] });
  assert.equal(p.status, 400);
});

// Finance in an isolated past month
const monthDay = `2025-0${1 + Math.floor(Math.random() * 9)}-15`;
const month = monthDay.slice(0, 7);
let past;
await step('BR-07 Owner back-enters a past booking (flagged back-dated)', async () => {
  const r = await api(owner, 'POST', '/bookings', { typeId: pkg.id, hours: 2, date: monthDay, startTime: '12:00', clientName: 'Claire', photographerId: hamja.id, addons: [{ addonId: addon('Extra person'), qty: 7 }], dpAmount: 300000 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.total, 1373000);
  assert.equal(r.data.backDated, true);
  past = r.data;
});

await step('US-24.1 completing creates a draft photographer fee', async () => {
  const r = await api(owner, 'POST', `/bookings/${past.id}/complete`, { paidAmount: 1000000 });
  assert.equal(r.data.status, 'COMPLETED');
  const fee = r.data.expenses.find((e) => e.source === 'BOOKING_FEE');
  assert.equal(fee.status, 'DRAFT');
  assert.equal(fee.amount, 250000);
});

let catId;
await step('US-22 record expense; duplicate warns; future date rejected', async () => {
  const cats = (await api(owner, 'GET', '/expense-categories')).data;
  catId = cats.find((c) => c.name === 'Listrik').id;
  const e = await api(owner, 'POST', '/expenses', { categoryId: catId, amount: 500000, paidOn: `${month}-03`, payee: 'PLN' });
  assert.equal(e.status, 201);
  const dup = await api(owner, 'POST', '/expenses', { categoryId: catId, amount: 500000, paidOn: `${month}-03` });
  assert.equal(dup.data.code, 'DUPLICATE_SUSPECT');
  const fut = await api(owner, 'POST', '/expenses', { categoryId: catId, amount: 1000, paidOn: wib(2) });
  assert.equal(fut.data.fields.paidOn, 'Tanggal tidak boleh di masa depan');
});

await step('US-26 recap: revenue, expenses, drafts warning, receivables', async () => {
  const r = (await api(owner, 'GET', `/reports/recap?month=${month}`)).data;
  assert.equal(r.revenue.total, 1373000);
  assert.equal(r.expenses.total, 500000);
  assert.equal(r.netProfit, 873000);
  assert.equal(r.drafts.count, 1);
  assert.equal(r.receivables.total, 373000);
  const c = (await api(owner, 'GET', `/reports/recap?month=${month}&basis=COLLECTED`)).data;
  assert.equal(c.revenue.total, 1000000);
});

await step('US-27 close month: blocked by drafts, then locks edits; reopen needs reason', async () => {
  assert.equal((await api(owner, 'POST', `/reports/months/${month}/close`)).data.code, 'DRAFTS_LEFT');
  const fee = (await api(owner, 'GET', `/expenses?month=${month}&status=DRAFT`)).data[0];
  await api(owner, 'POST', `/expenses/${fee.id}/confirm`, { amount: 250000 });
  assert.equal((await api(owner, 'POST', `/reports/months/${month}/close`)).status, 200);
  const edit = await api(owner, 'POST', '/expenses', { categoryId: catId, amount: 1000, paidOn: `${month}-04`, force: true });
  assert.equal(edit.data.code, 'MONTH_CLOSED');
  const pay = await api(owner, 'POST', `/bookings/${past.id}/payment`, { paidAmount: 1373000 });
  assert.equal(pay.data.code, 'MONTH_CLOSED');
  assert.equal((await api(owner, 'POST', `/reports/months/${month}/reopen`, { reason: '' })).status, 400);
  assert.equal((await api(owner, 'POST', `/reports/months/${month}/reopen`, { reason: 'Koreksi listrik' })).status, 200);
});

await step('FR-17 CSV export has income-2026 columns and a Total row', async () => {
  const r = await api(owner, 'GET', `/reports/recap.csv?month=${month}`);
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(r.data);
  assert.match(text, /^﻿Date,Client,Description,Amount/);
  assert.match(text, /Total,623000/);
});

await step('US-14 cancel frees the slot and removes draft fees', async () => {
  const r = await api(owner, 'POST', `/bookings/${booking.id}/cancel`, { reason: 'CUSTOMER_CANCELLED' });
  assert.equal(r.data.status, 'CANCELLED');
  const again = await api(owner, 'POST', '/bookings', { typeId: studio.id, hours: 1, date: day, startTime: '14:00', clientName: 'Next', addons: [] });
  assert.equal(again.status, 201);
  assert.equal((await api(owner, 'PATCH', `/bookings/${booking.id}`, { typeId: studio.id, hours: 1, date: day, startTime: '14:00', clientName: 'xx', addons: [] })).data.code, 'CANCELLED');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
