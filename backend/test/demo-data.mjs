// Loads ~11 months of realistic demo history through the real API so the owner dashboard has something to show.
// Everything it creates is tagged "[demo]".  Dev databases only.
//   node backend/test/demo-data.mjs           # add demo history (Dec 2025 → this month)
//   node backend/test/demo-data.mjs --remove  # delete every [demo] booking and expense
import { OWNER, api, login, resetLoginThrottle, sql, wibToday } from './lib.mjs';

const shiftMonth = (m, d) => { const t = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5) - 1 + d, 1)); return t.toISOString().slice(0, 7); };

const TAG = '[demo]';

if (process.argv.includes('--remove')) {
  const e = sql(`DELETE FROM expenses WHERE note LIKE '${TAG}%' OR booking_id IN (SELECT id FROM bookings WHERE notes LIKE '${TAG}%')`);
  const b = sql(`DELETE FROM bookings WHERE notes LIKE '${TAG}%'`);
  console.log(`removed: ${e}, ${b}`);
  process.exit(0);
}

// deterministic pseudo-random, so the demo looks the same on every machine
let seed = 20261107;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];

resetLoginThrottle();
const owner = await login(OWNER);
const types = (await api(owner, 'GET', '/booking-types')).data;
const PP = types.find((t) => t.name === 'Photo Package');
const SO = types.find((t) => t.name === 'Studio Only');
const addons = (await api(owner, 'GET', '/addons')).data.filter((a) => a.active);
const A = (n) => addons.find((a) => a.name === n)?.id;
const photographers = (await api(owner, 'GET', '/photographers')).data.filter((p) => p.active && ['Hamja', 'Nael', 'Bay Ami', 'DidiL'].includes(p.name));
const cats = (await api(owner, 'GET', '/expense-categories')).data;
const CAT = (n) => cats.find((c) => c.name === n).id;

const NAMES = ['Aurel', 'Lilin', 'Joyce', 'Claire', 'Dea', 'Ides', 'Nadia', 'Rara', 'Salsa', 'Tasya', 'Putri', 'Vina', 'Keluarga Wijaya', 'Keluarga Tan', 'Bima', 'Gita', 'Maya', 'Sekar', 'Intan', 'Laras'];
// bookings per month: holiday peaks, quiet Jan / Aug (loss months)
const DEMAND = { '12': 22, '01': 7, '02': 18, '03': 20, '04': 16, '05': 14, '06': 21, '07': 15, '08': 6, '09': 13, '10': 17, '11': 16 };

const today = wibToday();
const thisMonth = today.slice(0, 7);
const months = [];
for (let m = '2025-12'; m <= thisMonth; m = shiftMonth(m, 1)) months.push(m);

let created = 0, completed = 0, expenses = 0;
for (const month of months) {
  const n = DEMAND[month.slice(5)] ?? 12;
  const daysInMonth = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 0)).getUTCDate();
  for (let i = 0; i < n; i++) {
    const isPP = rnd() < 0.55;
    const hours = isPP ? pick([1, 1, 1, 2]) : pick([1, 2, 2, 3, 4]);
    const chosen = [];
    if (isPP) {
      if (rnd() < 0.35) chosen.push({ addonId: A(pick(['MUA', 'MUA + Hairdo'])), qty: 1 });
      if (rnd() < 0.3) chosen.push({ addonId: A('Dekorasi'), qty: 1 });
      if (rnd() < 0.15) chosen.push({ addonId: A('Sewa dress'), qty: 1 });
    }
    if (rnd() < 0.25) chosen.push({ addonId: A('Extra person'), qty: 1 + Math.floor(rnd() * 6) });
    const body = {
      typeId: (isPP ? PP : SO).id, hours, clientName: pick(NAMES), clientPhone: `0812${String(10000000 + Math.floor(rnd() * 89999999))}`,
      photographerId: isPP ? pick(photographers).id : null, addons: chosen.filter((a) => a.addonId),
      notes: `${TAG} riwayat contoh`, dpAmount: 0,
    };
    // try a few slots until one is free
    let b = null;
    for (let t = 0; t < 8 && !b; t++) {
      const day = String(1 + Math.floor(rnd() * daysInMonth)).padStart(2, '0');
      const start = 9 + Math.floor(rnd() * (12 - hours));
      const r = await api(owner, 'POST', '/bookings', { ...body, date: `${month}-${day}`, startTime: `${String(start).padStart(2, '0')}:00` });
      if (r.status === 201) b = r.data;
      else if (r.status !== 409 && r.status !== 400) throw new Error(`create ${r.status} ${JSON.stringify(r.data)}`);
    }
    if (!b) continue;
    created++;
    // DP for about half of bookings
    if (rnd() < 0.5) {
      const dp = Math.min(b.total, b.addons.some((a) => a.nameSnap.startsWith('MUA')) ? 500000 : 300000);
      const r = await api(owner, 'PATCH', `/bookings/${b.id}`, {
        typeId: b.typeId, hours: b.hours, date: `${month}-${new Date(new Date(b.startAt).getTime() + 7 * 3600e3).toISOString().slice(8, 10)}`,
        startTime: new Date(new Date(b.startAt).getTime() + 7 * 3600e3).toISOString().slice(11, 16), clientName: b.clientNameSnap,
        clientPhone: b.clientPhoneSnap, photographerId: b.photographerId, addons: b.addons.map((a) => ({ addonId: a.addonId, qty: a.qty })), dpAmount: dp, notes: b.notes,
      });
      if (r.status === 200) b = r.data;
    }
    // past sessions are completed: most paid in full, a few still owe the balance
    if (new Date(b.endAt).getTime() < Date.now()) {
      const paid = rnd() < 0.88 ? b.total : b.dpAmount;
      const c = await api(owner, 'POST', `/bookings/${b.id}/complete`, { paidAmount: paid });
      if (c.status === 200) {
        completed++;
        for (const e of c.data.expenses.filter((x) => x.status === 'DRAFT')) {
          await api(owner, 'POST', `/expenses/${e.id}/confirm`, { amount: e.amount ?? 250000 });
          sql(`UPDATE expenses SET note = '${TAG} ' || coalesce(note, '') WHERE id = '${e.id}'`);
        }
      }
    }
  }

  // monthly costs, paid on realistic days (never in the future)
  const fixed = [
    ['Sewa ruko', 3000000, '05', 'Pemilik ruko'], ['Gaji staf', 2000000, '25', 'Staf'], ['Internet', 350000, '03', 'Biznet'],
    ['Air & IPL', 150000 + Math.round(rnd() * 5) * 10000, '10', 'Pengelola'], ['Listrik', 450000 + Math.round(rnd() * 30) * 10000, '08', 'PLN'],
    ['Iklan Instagram', 150000 + Math.round(rnd() * 25) * 10000, '15', 'Meta'],
  ];
  if (rnd() < 0.5) fixed.push(['Dekorasi & properti', 200000 + Math.round(rnd() * 40) * 10000, '18', 'Toko properti']);
  if (rnd() < 0.3) fixed.push(['Peralatan & perawatan', 300000 + Math.round(rnd() * 70) * 10000, '20', 'Servis kamera']);
  for (const [cat, amount, day, payee] of fixed) {
    const paidOn = `${month}-${day}`;
    if (paidOn > today) continue;
    const r = await api(owner, 'POST', '/expenses', { categoryId: CAT(cat), amount, paidOn, payee, note: `${TAG} ${cat.toLowerCase()}`, force: true });
    if (r.status === 201) expenses++;
  }
  console.log(`${month}: done`);
}
console.log(`demo history: ${created} bookings (${completed} completed), ${expenses} expenses`);
