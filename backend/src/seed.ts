import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { DEFAULT_TEMPLATES } from '@jes/shared';
import { config } from './config';
import { pool } from './db';

/**
 * First-run seed with the current price list (PRD §6.3, §9.1). Runs only on an empty database.
 * Values marked TODO(Q#) are defaults pending the PRD open questions.
 */
export async function seed() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const has = await c.query('SELECT 1 FROM settings WHERE id = 1');
    if (has.rowCount) {
      await c.query('ROLLBACK');
      return;
    }

    const day = { open: '09:00', close: '21:00', closed: false }; // TODO(Q2) per-weekday hours
    await c.query(
      `INSERT INTO settings (id, studio_name, address, maps_url, bank_name, open_hours, slot_step_min, max_hours, buffer_min, dp_rule_text, terms_text)
       VALUES (1, 'JES Space Studio', '', '', 'BCA', $1, 30, 8, 0, $2, $3)`,
      [JSON.stringify(Array(7).fill(day)),
       'Bisa DP 300K (500K bila dengan MUA), pelunasan sebelum photoshoot dimulai.', // TODO(Q5)
       'Pembatalan kurang dari 24 jam sebelum sesi: DP tidak dapat dikembalikan. Reschedule maksimal 1x.']);

    for (const [kind, body] of Object.entries(DEFAULT_TEMPLATES)) {
      await c.query('INSERT INTO message_templates (kind, body) VALUES ($1, $2)', [kind, body]);
    }

    const type = async (name: string, rate: number, photographer: boolean, keyword: string, color: string, sort: number) =>
      (await c.query(
        `INSERT INTO booking_types (name, hourly_rate, requires_photographer, calendar_keyword, color_id, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [name, rate, photographer, keyword, color, sort])).rows[0].id as string;
    const studio = await type('Studio Only', 170_000, false, 'sewa', '7', 1);
    const pkg = await type('Photo Package', 599_000, true, 'group', '6', 2);

    for (const name of ['Hamja', 'Nael', 'Bay Ami', 'DidiL']) {
      await c.query(`INSERT INTO photographers (name, default_fee, fee_unit) VALUES ($1, 250000, 'SESSION')`, [name]); // TODO(Q9)
    }

    const addon = async (name: string, price: number, unit: string, types: string[], sort: number) => {
      const id = (await c.query(`INSERT INTO addons (name, price, unit, sort_order) VALUES ($1,$2,$3,$4) RETURNING id`, [name, price, unit, sort])).rows[0].id;
      for (const t of types) await c.query('INSERT INTO addon_types (addon_id, type_id) VALUES ($1,$2)', [id, t]);
    };
    await addon('MUA', 500_000, 'BOOKING', [pkg, studio], 1);
    await addon('MUA + Hairdo', 600_000, 'BOOKING', [pkg, studio], 2);
    await addon('Dekorasi', 250_000, 'BOOKING', [pkg], 3); // TODO(Q1) flat vs per hour
    await addon('Sewa dress', 150_000, 'BOOKING', [pkg], 4);
    await addon('Extra person', 25_000, 'PERSON', [pkg, studio], 5);

    const cats: [string | null, string, 'FIXED' | 'VARIABLE', boolean, number | null][] = [
      ['PHOTOGRAPHER_FEE', 'Fee fotografer', 'VARIABLE', false, null],
      ['MUA_FEE', 'Fee MUA', 'VARIABLE', false, null],
      [null, 'Listrik', 'FIXED', false, null],
      [null, 'Internet', 'FIXED', true, 350_000],
      [null, 'Air & IPL', 'FIXED', false, null],
      [null, 'Dekorasi & properti', 'VARIABLE', false, null],
      [null, 'Iklan Instagram', 'VARIABLE', false, null],
      [null, 'Sewa ruko', 'FIXED', false, null],
      [null, 'Gaji staf', 'FIXED', false, null],
      [null, 'Peralatan & perawatan', 'VARIABLE', false, null],
      [null, 'Cetak foto', 'VARIABLE', false, null],
      [null, 'Lainnya', 'VARIABLE', false, null],
    ];
    let i = 0;
    for (const [code, name, kind, recurring, amount] of cats) {
      await c.query(
        `INSERT INTO expense_categories (code, name, kind, recurring, default_amount, sort_order) VALUES ($1,$2,$3,$4,$5,$6)`,
        [code, name, kind, recurring, amount, ++i]);
    }

    const user = async (name: string, email: string, password: string, role: string) => {
      const pw = password || randomBytes(9).toString('base64url');
      await c.query(`INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4)`,
        [name, email, await argon2.hash(pw, { type: argon2.argon2id }), role]);
      if (!password) console.log(`seeded ${role} ${email} with generated password: ${pw}`);
    };
    await user(process.env.SEED_OWNER_NAME || 'Owner', config.seed.ownerEmail, config.seed.ownerPassword, 'OWNER');
    // production: leave SEED_STAFF_EMAIL empty to create only the Owner; staff are registered in Admin → Pengguna
    if (process.env.SEED_STAFF_EMAIL !== '') await user('Staf', config.seed.staffEmail, config.seed.staffPassword, 'STAFF');

    await c.query('COMMIT');
    console.log('seeded initial data');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
