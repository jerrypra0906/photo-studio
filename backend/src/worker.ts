import 'reflect-metadata';
import { Client } from 'pg';
import { wibMonth } from '@jes/shared';
import { config } from './config';
import { Db, pool } from './db';
import { GoogleService } from './modules/google.service';

/**
 * Background worker (TD: same codebase, separate process).
 * - Calendar outbox: woken by NOTIFY gcal_outbox, plus a 15 s sweep for retries.
 * - Recurring expense drafts (FR-25): idempotent hourly check for the current month.
 */
const db = new Db();
const google = new GoogleService(db);
let draining = false;
let again = false;

async function drain() {
  if (draining) { again = true; return; }
  draining = true;
  try {
    do { again = false; await google.drain(); } while (again);
  } catch (e) {
    console.error('drain error', e);
  } finally {
    draining = false;
  }
}

async function recurringDrafts() {
  const month = wibMonth(new Date());
  const r = await pool.query(
    `INSERT INTO expenses (category_id, amount, paid_on, payee, note, status, source, recurring_month)
     SELECT c.id, c.default_amount, ($1 || '-01')::date, NULL, c.name || ' — ' || $1, 'DRAFT', 'RECURRING', $1
       FROM expense_categories c WHERE c.active AND c.recurring
     ON CONFLICT (category_id, recurring_month) WHERE source = 'RECURRING' DO NOTHING`, [month]);
  if (r.rowCount) console.log(`created ${r.rowCount} recurring drafts for ${month}`);
}

/** SEC-F7: login attempts only matter for 25 minutes; keep a day for investigation, then purge. */
async function housekeeping() {
  await pool.query(`DELETE FROM login_attempts WHERE at < now() - interval '1 day'`);
  await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'`);
}

async function listen() {
  const c = new Client({ connectionString: config.databaseUrl });
  c.on('error', (e) => {
    console.error('listen connection lost', e.message);
    setTimeout(listen, 5000);
  });
  await c.connect();
  await c.query('LISTEN gcal_outbox');
  c.on('notification', () => void drain());
  console.log('worker listening on gcal_outbox');
}

async function main() {
  // the API runs migrations; wait until the outbox table exists
  for (let i = 0; ; i++) {
    const r = await pool.query(`SELECT to_regclass('public.sync_outbox') IS NOT NULL AS ok`).catch(() => ({ rows: [{ ok: false }] }));
    if (r.rows[0].ok) break;
    if (i > 60) throw new Error('schema not ready');
    await new Promise((res) => setTimeout(res, 2000));
  }
  await listen();
  setInterval(() => void drain(), 15_000);
  setInterval(() => void recurringDrafts().catch((e) => console.error(e)), 3600_000);
  setInterval(() => void housekeeping().catch((e) => console.error(e)), 3600_000);
  await housekeeping().catch((e) => console.error(e));
  await recurringDrafts().catch((e) => console.error(e));
  await drain();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
