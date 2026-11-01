import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  BookingInput, PricingAddon, fromWib, normalizePhone, priceBooking, toMinutes, wibDate, wibParts, wibTime,
} from '@jes/shared';
import { AppError, AuthUser, badRequest, conflict, forbidden, notFound } from '../common/http';
import { Db, Queryable } from '../db';

const BOOKING_COLS = `b.*, b.balance`;

/** Fields whose change makes a new invoice revision (review C4). */
const INVOICE_FIELDS = ['typeNameSnap', 'rateSnap', 'hours', 'startAt', 'clientNameSnap', 'clientPhoneSnap', 'photographerNameSnap', 'adjustment', 'adjustmentReason', 'dpAmount', 'total', 'addons'] as const;

export async function enqueueSync(db: Db, c: Queryable, bookingId: string, op: 'UPSERT' | 'DELETE') {
  const s = await db.one(`SELECT gcal_status, gcal_calendar_id FROM settings WHERE id = 1`, [], c);
  if (s.gcalStatus === 'NOT_CONNECTED' || !s.gcalCalendarId) return 'NONE';
  // a newer job supersedes any queued one for the same booking
  await c.query(`UPDATE sync_outbox SET done_at = now(), last_error = 'superseded' WHERE booking_id = $1 AND done_at IS NULL AND failed_at IS NULL`, [bookingId]);
  await c.query(`INSERT INTO sync_outbox (booking_id, op) VALUES ($1, $2)`, [bookingId, op]);
  await c.query(`UPDATE bookings SET gcal_sync_status = 'PENDING', gcal_last_error = NULL WHERE id = $1`, [bookingId]);
  return 'PENDING';
}

interface Prepared {
  startAt: Date; endAt: Date; blockEndAt: Date;
  type: any; photographer: any | null;
  addons: (PricingAddon & { addonId: string; vendorFee: number | null; vendorName: string | null })[];
  phone: string | null; pricing: ReturnType<typeof priceBooking>;
  backDated: boolean; afterHours: string | null;
}

@Injectable()
export class BookingsService {
  constructor(private db: Db) {}

  // ---------- reads ----------

  async list(q: { q?: string; status?: string; from?: string; to?: string; typeId?: string; includeCancelled?: boolean; toClose?: boolean; limit?: number }) {
    const where: string[] = [];
    const p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    if (q.q) {
      const s = `%${q.q.trim()}%`;
      const digits = q.q.replace(/\D/g, '');
      p.push(s);
      const i = p.length;
      let cond = `(b.client_name_snap ILIKE $${i} OR b.booking_no ILIKE $${i}`;
      if (digits.length >= 3) { p.push(`%${digits.replace(/^0/, '')}%`); cond += ` OR b.client_phone_snap LIKE $${p.length}`; }
      where.push(cond + ')');
    }
    if (q.status) add(`b.status = ?`, q.status);
    else if (!q.includeCancelled) where.push(`b.status <> 'CANCELLED'`);
    if (q.from) add(`b.start_at >= ?`, fromWib(q.from));
    if (q.to) add(`b.start_at < ?`, new Date(fromWib(q.to).getTime() + 86400_000));
    if (q.typeId) add(`b.type_id = ?`, q.typeId);
    if (q.toClose) where.push(`b.status = 'CONFIRMED' AND b.end_at <= now()`);
    const order = q.from || q.toClose ? 'b.start_at ASC' : 'b.start_at DESC';
    return this.db.many(
      `SELECT ${BOOKING_COLS} FROM bookings b ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${Math.min(q.limit ?? 200, 500)}`, p);
  }

  async get(id: string, user: AuthUser) {
    const b = await this.db.one(`SELECT ${BOOKING_COLS} FROM bookings b WHERE b.id = $1`, [id]);
    if (!b) throw notFound('Booking');
    b.addons = await this.db.many(`SELECT * FROM booking_addons WHERE booking_id = $1 ORDER BY name_snap`, [id]);
    b.history = await this.db.many(
      `SELECT h.*, u.name AS changed_by_name FROM booking_history h LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.booking_id = $1 ORDER BY h.changed_at DESC, h.id DESC LIMIT 100`, [id]);
    if (user.role === 'OWNER') {
      b.expenses = await this.db.many(
        `SELECT e.*, c.name AS category_name FROM expenses e JOIN expense_categories c ON c.id = e.category_id
          WHERE e.booking_id = $1 AND e.deleted_at IS NULL ORDER BY e.created_at`, [id]);
      const costs = b.expenses.filter((e: any) => e.status === 'CONFIRMED').reduce((s: number, e: any) => s + (e.amount ?? 0), 0);
      b.margin = { costs, margin: b.total - costs };
    }
    return b;
  }

  /** Non-cancelled bookings between two WIB dates (inclusive), plus opening hours — for the schedule and the slot picker. */
  async schedule(from: string, to: string, excludeId?: string) {
    const s = await this.db.one(`SELECT open_hours, slot_step_min, buffer_min, max_hours FROM settings WHERE id = 1`);
    const bookings = await this.db.many(
      `SELECT b.id, b.booking_no, b.status, b.type_id, b.type_name_snap, b.client_name_snap, b.photographer_id, b.photographer_name_snap,
              b.start_at, b.end_at, b.block_end_at, b.hours, b.total, b.balance, b.gcal_sync_status
         FROM bookings b
        WHERE b.status <> 'CANCELLED' AND b.start_at < $2 AND b.block_end_at > $1 AND ($3::uuid IS NULL OR b.id <> $3)
        ORDER BY b.start_at`,
      [fromWib(from), new Date(fromWib(to).getTime() + 86400_000), excludeId ?? null]);
    return { openHours: s.openHours, slotStepMin: s.slotStepMin, bufferMin: s.bufferMin, maxHours: s.maxHours, bookings };
  }

  async clients(q: string) {
    if (!q || q.trim().length < 2) return [];
    const digits = q.replace(/\D/g, '').replace(/^0/, '');
    return this.db.many(
      `SELECT id, name, phone_e164, last_booking_at FROM clients
        WHERE name ILIKE $1 ${digits.length >= 3 ? 'OR phone_e164 LIKE $2' : ''}
        ORDER BY last_booking_at DESC NULLS LAST LIMIT 8`,
      digits.length >= 3 ? [`%${q.trim()}%`, `%${digits}%`] : [`%${q.trim()}%`]);
  }

  // ---------- validation & pricing shared by create and edit ----------

  private async prepare(c: PoolClient, input: BookingInput, user: AuthUser, existing?: any): Promise<Prepared> {
    const settings = await this.db.one(`SELECT * FROM settings WHERE id = 1`, [], c);
    const type = await this.db.one(`SELECT * FROM booking_types WHERE id = $1`, [input.typeId], c);
    if (!type || (!type.active && type.id !== existing?.typeId)) throw badRequest('Jenis booking tidak aktif', { typeId: 'Jenis booking tidak aktif' });

    const maxHours = Math.min(type.maxHours, settings.maxHours);
    if (input.hours < type.minHours || input.hours > maxHours) {
      throw badRequest(`Durasi ${type.minHours}–${maxHours} jam`, { hours: `Maks ${maxHours} jam` });
    }

    const startAt = fromWib(input.date, input.startTime);
    const endAt = new Date(startAt.getTime() + input.hours * 3600_000);
    const blockEndAt = new Date(endAt.getTime() + settings.bufferMin * 60_000);
    if (toMinutes(input.startTime) % settings.slotStepMin !== 0 && !existing) {
      throw badRequest(`Jam mulai harus kelipatan ${settings.slotStepMin} menit`, { startTime: `Kelipatan ${settings.slotStepMin} menit` });
    }

    // BR-07 / US-05.5: Staff cannot pick past dates; Owner back-entry is flagged.
    const today = wibDate(new Date());
    const backDated = input.date < today;
    const startChanged = !existing || new Date(existing.startAt).getTime() !== startAt.getTime();
    if (backDated && startChanged && user.role !== 'OWNER') throw badRequest('Tanggal lampau tidak bisa dipilih', { date: 'Tanggal lampau tidak bisa dipilih' });

    // US-05.4: outside operating hours needs a reason
    const day = settings.openHours[wibParts(startAt).dow];
    const startMin = toMinutes(input.startTime);
    const endMin = startMin + input.hours * 60;
    const outside = day.closed || startMin < toMinutes(day.open) || endMin > toMinutes(day.close);
    const afterHours = outside ? (input.afterHoursReason?.trim() || null) : null;
    if (outside && !afterHours) {
      const msg = day.closed ? 'Studio tutup di hari ini' : endMin > toMinutes(day.close) ? `Selesai setelah jam tutup (${day.close})` : `Mulai sebelum jam buka (${day.open})`;
      throw new AppError(400, 'AFTER_HOURS', `${msg} — isi alasan untuk melanjutkan`, { fields: { afterHoursReason: msg } });
    }

    // Photographer (BR-02)
    let photographer = null;
    if (type.requiresPhotographer && !input.photographerId) throw badRequest('Pilih fotografer', { photographerId: 'Pilih fotografer' });
    if (input.photographerId) {
      photographer = await this.db.one(`SELECT * FROM photographers WHERE id = $1`, [input.photographerId], c);
      if (!photographer || (!photographer.active && photographer.id !== existing?.photographerId)) {
        throw badRequest('Fotografer tidak aktif', { photographerId: 'Fotografer tidak aktif' });
      }
    }

    // Add-ons: active and applicable to the type; edit keeps snapshot prices unless asked to apply current ones (L2-1.3.4)
    const ids = input.addons.map((a) => a.addonId);
    if (new Set(ids).size !== ids.length) throw badRequest('Add-on ganda');
    const masters = ids.length
      ? await this.db.many(
          `SELECT a.*, EXISTS (SELECT 1 FROM addon_types t WHERE t.addon_id = a.id AND t.type_id = $2) AS applicable
             FROM addons a WHERE a.id = ANY($1::uuid[])`, [ids, type.id], c)
      : [];
    const snaps: Record<string, any> = {};
    for (const s of existing?.addons ?? []) snaps[s.addonId] = s;
    const keepSnap = !!existing && !input.applyCurrentPrices;
    const addons = input.addons.map((a) => {
      const m = masters.find((x) => x.id === a.addonId);
      const snap = keepSnap ? snaps[a.addonId] : undefined;
      if (!m) throw badRequest('Add-on tidak ditemukan');
      if (!snap && (!m.active || !m.applicable)) throw badRequest(`${m.name} tidak tersedia untuk ${type.name}`, { addons: `${m.name} tidak tersedia` });
      return {
        addonId: m.id,
        name: snap?.nameSnap ?? m.name,
        unit: snap?.unitSnap ?? m.unit,
        price: snap?.priceSnap ?? m.price,
        qty: a.qty,
        vendorFee: snap ? snap.vendorFeeSnap : m.vendorFee,
        vendorName: snap ? snap.vendorNameSnap : m.vendorName,
      };
    });

    // US-02.3: Staff cannot set a price adjustment; on edit they keep whatever the Owner set.
    let adjustment = input.adjustment ?? 0;
    let adjustmentReason = input.adjustmentReason?.trim() || null;
    if (user.role !== 'OWNER') {
      adjustment = existing?.adjustment ?? 0;
      adjustmentReason = existing?.adjustmentReason ?? null;
    }
    if (adjustment !== 0 && !adjustmentReason) throw badRequest('Alasan wajib diisi', { adjustmentReason: 'Alasan wajib diisi' });
    input.adjustment = adjustment;
    input.adjustmentReason = adjustment === 0 ? null : adjustmentReason;

    const rate = keepSnap && existing.typeId === type.id ? existing.rateSnap : type.hourlyRate;
    const paid = existing?.status === 'COMPLETED' ? existing.paidAmount : input.dpAmount;
    const pricing = priceBooking({ typeName: type.name, rate, hours: input.hours, addons, adjustment, dp: input.dpAmount, paid });
    if (pricing.errors.length) {
      const fields = Object.fromEntries(pricing.errors.map((e) => [e.field, e.message]));
      throw badRequest(pricing.errors[0].message, fields);
    }

    let phone: string | null = null;
    if (input.clientPhone?.trim()) {
      phone = normalizePhone(input.clientPhone);
      if (!phone) throw badRequest('Masukkan nomor telepon yang valid', { clientPhone: 'Masukkan nomor telepon yang valid' });
    }

    return { startAt, endAt, blockEndAt, type, photographer, addons, phone, pricing, backDated, afterHours };
  }

  /** Friendly pre-check so the 409 can name the clashing booking (US-05.3); the exclusion constraint is the real guard. */
  private async assertFree(c: Queryable, startAt: Date, blockEndAt: Date, excludeId?: string) {
    const clash = await this.db.one(
      `SELECT id, booking_no, client_name_snap, start_at, end_at FROM bookings
        WHERE status <> 'CANCELLED' AND tstzrange(start_at, block_end_at, '[)') && tstzrange($1, $2, '[)') AND ($3::uuid IS NULL OR id <> $3)
        LIMIT 1`, [startAt, blockEndAt, excludeId ?? null], c);
    if (clash) {
      throw conflict('SLOT_TAKEN', `Bentrok dengan ${clash.bookingNo} (${clash.clientNameSnap}, ${wibTime(clash.startAt)}–${wibTime(clash.endAt)})`, { clash });
    }
  }

  private async upsertClient(c: Queryable, name: string, phone: string | null, startAt: Date) {
    if (phone) {
      const r = await this.db.one(
        `INSERT INTO clients (name, phone_e164, last_booking_at) VALUES ($1, $2, $3)
         ON CONFLICT (phone_e164) DO UPDATE SET name = EXCLUDED.name, last_booking_at = GREATEST(clients.last_booking_at, EXCLUDED.last_booking_at)
         RETURNING id`, [name, phone, startAt], c);
      return r.id as string;
    }
    const found = await this.db.one(`SELECT id FROM clients WHERE lower(name) = lower($1) AND phone_e164 IS NULL LIMIT 1`, [name], c);
    if (found) {
      await c.query(`UPDATE clients SET last_booking_at = GREATEST(last_booking_at, $2) WHERE id = $1`, [found.id, startAt]);
      return found.id as string;
    }
    return (await this.db.one(`INSERT INTO clients (name, last_booking_at) VALUES ($1, $2) RETURNING id`, [name, startAt], c)).id as string;
  }

  private async writeAddons(c: Queryable, bookingId: string, p: Prepared) {
    await c.query(`DELETE FROM booking_addons WHERE booking_id = $1`, [bookingId]);
    const lines = p.pricing.lines.filter((l) => l.kind === 'ADDON');
    for (const a of p.addons) {
      const line = lines.find((l) => l.addonId === a.addonId)!;
      await c.query(
        `INSERT INTO booking_addons (booking_id, addon_id, name_snap, unit_snap, price_snap, qty, line_total, vendor_fee_snap, vendor_name_snap)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [bookingId, a.addonId, a.name, a.unit, a.price, a.qty, line.amount, a.vendorFee ?? null, a.vendorName ?? null]);
    }
  }

  private history(c: Queryable, bookingId: string, user: AuthUser, action: string, field: string | null = null, oldV: unknown = null, newV: unknown = null, rev: number | null = null) {
    const s = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v));
    return c.query(
      `INSERT INTO booking_history (booking_id, changed_by, action, field, old_value, new_value, invoice_rev) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [bookingId, user.id, action, field, s(oldV), s(newV), rev]);
  }

  // ---------- writes ----------

  async create(input: BookingInput, user: AuthUser, idemKey?: string) {
    if (idemKey) {
      const prev = await this.db.one(`SELECT booking_id FROM idempotency_keys WHERE key = $1 AND user_id = $2`, [idemKey, user.id]);
      if (prev) return { ...(await this.get(prev.bookingId, user)), replayed: true };
    }
    const id = await this.db.tx(async (c) => {
      const p = await this.prepare(c, input, user);
      await this.assertFree(c, p.startAt, p.blockEndAt);
      const clientId = await this.upsertClient(c, input.clientName, p.phone, p.startAt);

      // BR-03 / review C3: JES-YYMMDD-NNN from the session date at creation; never changes afterwards.
      const day = wibDate(p.startAt);
      const n = (await this.db.one(
        `INSERT INTO booking_counters (day, last) VALUES ($1, 1) ON CONFLICT (day) DO UPDATE SET last = booking_counters.last + 1 RETURNING last`, [day], c)).last;
      const bookingNo = `JES-${day.slice(2).replace(/-/g, '')}-${String(n).padStart(3, '0')}`;

      const b = await this.db.one(
        `INSERT INTO bookings (booking_no, type_id, type_name_snap, type_keyword_snap, rate_snap, hours, start_at, end_at, block_end_at,
                               client_id, client_name_snap, client_phone_snap, photographer_id, photographer_name_snap,
                               adjustment, adjustment_reason, dp_amount, paid_amount, total, notes, after_hours_reason, back_dated, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18,$19,$20,$21,$22) RETURNING id`,
        [bookingNo, p.type.id, p.type.name, p.type.calendarKeyword, p.pricing.lines[0].unitPrice, input.hours, p.startAt, p.endAt, p.blockEndAt,
         clientId, input.clientName, p.phone, p.photographer?.id ?? null, p.photographer?.name ?? null,
         input.adjustment, input.adjustmentReason, input.dpAmount, p.pricing.total, input.notes?.trim() || null, p.afterHours, p.backDated, user.id], c);
      await this.writeAddons(c, b.id, p);
      await this.history(c, b.id, user, 'CREATE', null, null, bookingNo, 0);
      await enqueueSync(this.db, c, b.id, 'UPSERT');
      if (idemKey) await c.query(`INSERT INTO idempotency_keys (key, user_id, booking_id) VALUES ($1,$2,$3)`, [idemKey, user.id, b.id]);
      return b.id as string;
    });
    return this.get(id, user);
  }

  async update(id: string, input: BookingInput, user: AuthUser, ifMatch?: number) {
    let rescheduledFrom: Date | null = null;
    await this.db.tx(async (c) => {
      const ex = await this.db.one(`SELECT ${BOOKING_COLS} FROM bookings b WHERE b.id = $1 FOR UPDATE`, [id], c);
      if (!ex) throw notFound('Booking');
      if (ex.status === 'CANCELLED') throw conflict('CANCELLED', 'Booking yang dibatalkan tidak bisa diubah');
      if (ex.status === 'COMPLETED' && user.role !== 'OWNER') throw forbidden();
      if (ifMatch !== undefined && ifMatch !== ex.version) throw conflict('STALE', 'Booking sudah diubah di perangkat lain — muat ulang');
      ex.addons = await this.db.many(`SELECT * FROM booking_addons WHERE booking_id = $1`, [id], c);

      const p = await this.prepare(c, input, user, ex);
      await this.assertFree(c, p.startAt, p.blockEndAt, id);
      const clientId = await this.upsertClient(c, input.clientName, p.phone, p.startAt);

      const after: Record<string, unknown> = {
        typeNameSnap: p.type.name, rateSnap: p.pricing.lines[0].unitPrice, hours: input.hours, startAt: p.startAt.toISOString(),
        clientNameSnap: input.clientName, clientPhoneSnap: p.phone, photographerNameSnap: p.photographer?.name ?? null,
        adjustment: input.adjustment, adjustmentReason: input.adjustmentReason, dpAmount: input.dpAmount, total: p.pricing.total,
        addons: p.addons.map((a) => `${a.name}×${a.qty}@${a.price}`).sort().join(', '),
      };
      const before: Record<string, unknown> = {
        typeNameSnap: ex.typeNameSnap, rateSnap: ex.rateSnap, hours: ex.hours, startAt: new Date(ex.startAt).toISOString(),
        clientNameSnap: ex.clientNameSnap, clientPhoneSnap: ex.clientPhoneSnap, photographerNameSnap: ex.photographerNameSnap,
        adjustment: ex.adjustment, adjustmentReason: ex.adjustmentReason, dpAmount: ex.dpAmount, total: ex.total,
        addons: ex.addons.map((a: any) => `${a.nameSnap}×${a.qty}@${a.priceSnap}`).sort().join(', '),
      };
      const changed = INVOICE_FIELDS.filter((f) => String(before[f] ?? '') !== String(after[f] ?? ''));
      const rev = changed.length ? ex.invoiceRev + 1 : ex.invoiceRev;
      if (before.startAt !== after.startAt) rescheduledFrom = new Date(ex.startAt);

      const paid = ex.status === 'COMPLETED' ? ex.paidAmount : input.dpAmount;
      if (paid > p.pricing.total) throw badRequest('Pembayaran melebihi total baru', { dpAmount: 'Pembayaran melebihi total baru' });

      await c.query(
        `UPDATE bookings SET type_id=$2, type_name_snap=$3, type_keyword_snap=$4, rate_snap=$5, hours=$6, start_at=$7, end_at=$8, block_end_at=$9,
                client_id=$10, client_name_snap=$11, client_phone_snap=$12, photographer_id=$13, photographer_name_snap=$14,
                adjustment=$15, adjustment_reason=$16, dp_amount=$17, paid_amount=$18, total=$19, notes=$20, after_hours_reason=$21,
                back_dated = back_dated OR $22, invoice_rev=$23, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [id, p.type.id, p.type.name, p.type.calendarKeyword, p.pricing.lines[0].unitPrice, input.hours, p.startAt, p.endAt, p.blockEndAt,
         clientId, input.clientName, p.phone, p.photographer?.id ?? null, p.photographer?.name ?? null,
         input.adjustment, input.adjustmentReason, input.dpAmount, paid, p.pricing.total, input.notes?.trim() || null, p.afterHours,
         p.backDated && !!rescheduledFrom, rev]);
      await this.writeAddons(c, id, p);
      for (const f of changed) await this.history(c, id, user, rescheduledFrom && f === 'startAt' ? 'RESCHEDULE' : 'EDIT', f, before[f], after[f], rev);
      if ((ex.notes ?? '') !== (input.notes?.trim() ?? '')) await this.history(c, id, user, 'EDIT', 'notes', ex.notes, input.notes);
      await enqueueSync(this.db, c, id, 'UPSERT');
    });
    const b = await this.get(id, user);
    return { ...b, rescheduledFrom };
  }

  async cancel(id: string, reason: string, note: string | null | undefined, user: AuthUser) {
    await this.db.tx(async (c) => {
      const ex = await this.db.one(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [id], c);
      if (!ex) throw notFound('Booking');
      if (ex.status !== 'CONFIRMED') throw conflict('NOT_CONFIRMED', 'Hanya booking berstatus Confirmed yang bisa dibatalkan');
      await c.query(
        `UPDATE bookings SET status='CANCELLED', cancel_reason=$2, cancel_note=$3, cancelled_at=now(), version=version+1, updated_at=now() WHERE id=$1`,
        [id, reason, note?.trim() || null]);
      // US-24.4: a cancelled booking's draft fee is removed
      await c.query(`UPDATE expenses SET deleted_at = now() WHERE booking_id = $1 AND status = 'DRAFT' AND deleted_at IS NULL`, [id]);
      await this.history(c, id, user, 'CANCEL', 'status', 'CONFIRMED', 'CANCELLED');
      if (ex.gcalEventId || ex.gcalSyncStatus === 'PENDING') await enqueueSync(this.db, c, id, 'DELETE');
    });
    return this.get(id, user);
  }

  /** L2-1.5 + L2-4.2: complete, record payment, draft photographer and MUA fees. */
  async complete(id: string, paidAmount: number, user: AuthUser) {
    await this.db.tx(async (c) => {
      const ex = await this.db.one(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [id], c);
      if (!ex) throw notFound('Booking');
      if (ex.status !== 'CONFIRMED') throw conflict('NOT_CONFIRMED', 'Booking ini tidak bisa diselesaikan');
      if (paidAmount > ex.total) throw badRequest('Pembayaran tidak boleh melebihi total', { paidAmount: 'Pembayaran tidak boleh melebihi total' });
      await c.query(`UPDATE bookings SET status='COMPLETED', paid_amount=$2, completed_at=now(), version=version+1, updated_at=now() WHERE id=$1`, [id, paidAmount]);
      await this.history(c, id, user, 'COMPLETE', 'paidAmount', ex.paidAmount, paidAmount);

      const sessionDay = wibDate(ex.startAt);
      if (ex.photographerId) {
        const ph = await this.db.one(`SELECT * FROM photographers WHERE id = $1`, [ex.photographerId], c);
        const cat = await this.db.one(`SELECT id FROM expense_categories WHERE code = 'PHOTOGRAPHER_FEE'`, [], c);
        const amount = ph.defaultFee == null ? null : ph.feeUnit === 'HOUR' ? ph.defaultFee * ex.hours : ph.defaultFee;
        await c.query(
          `INSERT INTO expenses (category_id, amount, paid_on, payee, note, booking_id, photographer_id, status, source, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT','BOOKING_FEE',$8)`,
          [cat.id, amount, sessionDay, ph.name, `Fee fotografer — ${ph.name} — ${ex.bookingNo}`, id, ph.id, user.id]);
      }
      const muas = await this.db.many(`SELECT * FROM booking_addons WHERE booking_id = $1 AND vendor_fee_snap IS NOT NULL`, [id], c);
      if (muas.length) {
        const cat = await this.db.one(`SELECT id FROM expense_categories WHERE code = 'MUA_FEE'`, [], c);
        for (const a of muas) {
          await c.query(
            `INSERT INTO expenses (category_id, amount, paid_on, payee, note, booking_id, status, source, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,'DRAFT','BOOKING_FEE',$7)`,
            [cat.id, a.vendorFeeSnap * a.qty, sessionDay, a.vendorNameSnap, `Fee ${a.nameSnap} — ${ex.bookingNo}`, id, user.id]);
        }
      }
      await enqueueSync(this.db, c, id, 'UPSERT');
    });
    return this.get(id, user);
  }

  /** Record a later payment (receivables, US-26.3). */
  async payment(id: string, paidAmount: number, user: AuthUser) {
    await this.db.tx(async (c) => {
      const ex = await this.db.one(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [id], c);
      if (!ex) throw notFound('Booking');
      if (ex.status === 'CANCELLED') throw conflict('CANCELLED', 'Booking dibatalkan');
      if (paidAmount > ex.total) throw badRequest('Pembayaran tidak boleh melebihi total', { paidAmount: 'Pembayaran tidak boleh melebihi total' });
      const dp = ex.status === 'CONFIRMED' ? Math.min(paidAmount, ex.total) : ex.dpAmount;
      await c.query(`UPDATE bookings SET paid_amount=$2, dp_amount=$3, version=version+1, updated_at=now() WHERE id=$1`, [id, paidAmount, dp]);
      await this.history(c, id, user, 'PAYMENT', 'paidAmount', ex.paidAmount, paidAmount);
      await enqueueSync(this.db, c, id, 'UPSERT');
    });
    return this.get(id, user);
  }

  async markInvoiceSent(id: string, sent: boolean, user: AuthUser) {
    await this.db.tx(async (c) => {
      const r = await c.query(`UPDATE bookings SET invoice_sent_at = ${sent ? 'now()' : 'NULL'}, invoice_issued = invoice_issued OR $2 WHERE id = $1`, [id, sent]);
      if (!r.rowCount) throw notFound('Booking');
      await this.history(c, id, user, sent ? 'INVOICE_SENT' : 'INVOICE_SENT_UNDO');
    });
    return this.get(id, user);
  }

  async retrySync(id: string, user: AuthUser) {
    await this.db.tx(async (c) => {
      const b = await this.db.one(`SELECT status FROM bookings WHERE id = $1`, [id], c);
      if (!b) throw notFound('Booking');
      if ((await enqueueSync(this.db, c, id, b.status === 'CANCELLED' ? 'DELETE' : 'UPSERT')) === 'NONE') {
        throw conflict('NOT_CONNECTED', 'Google Calendar belum terhubung');
      }
    });
    return this.get(id, user);
  }
}
