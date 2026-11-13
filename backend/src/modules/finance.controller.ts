import {
  Body, Controller, Delete, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RevenueBasis, confirmExpenseInput, durationLabel, expenseInput, fromWib, reopenInput, shiftMonth, wibDate, wibMonth } from '@jes/shared';
import { AppError, AuthUser, Body$, CurrentUser, OwnerOnly, badRequest, conflict, notFound } from '../common/http';
import { config } from '../config';
import { Db, Queryable } from '../db';
import { DocumentsService } from './documents.service';

const Id = new ParseUUIDPipe();
const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;
const checkMonth = (m?: string) => {
  if (!m || !monthRe.test(m)) throw badRequest('Bulan tidak valid (YYYY-MM)');
  return m;
};

const MIME: [string, Buffer][] = [
  ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
  ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ['application/pdf', Buffer.from('%PDF')],
];

@Injectable()
export class RecapService {
  constructor(private db: Db) {}

  /** PRD §6.5: revenue by session date (BR-10), confirmed expenses by date paid, drafts excluded (BR-12). */
  async recap(month: string, basisOverride?: RevenueBasis, q: Queryable = this.db.pool) {
    const s = await this.db.one(`SELECT revenue_basis FROM settings WHERE id = 1`, [], q);
    const basis: RevenueBasis = basisOverride ?? s.revenueBasis;

    const bookings = await this.db.many(
      `SELECT b.id, b.booking_no, b.status, b.type_name_snap, b.client_name_snap, b.client_phone_snap, b.start_at, b.end_at, b.hours,
              round(b.rate_snap * b.duration_min / 60.0)::bigint AS base, b.adjustment, b.total, b.paid_amount, b.balance,
              coalesce((SELECT sum(line_total) FROM booking_addons a WHERE a.booking_id = b.id), 0)::bigint AS addons
         FROM bookings b
        WHERE b.status IN ('CONFIRMED','COMPLETED') AND wib_month(b.start_at) = $1
        ORDER BY b.start_at`, [month], q);

    const byTypeMap = new Map<string, { name: string; count: number; amount: number }>();
    // package performance: everything a booking of that type brought in (base + add-ons ± adjustment)
    const pkgMap = new Map<string, { name: string; count: number; revenue: number; base: number; addons: number; hours: number }>();
    let addons = 0, adjustments = 0, billed = 0, collected = 0, upcoming = 0;
    const now = Date.now();
    for (const b of bookings) {
      const t = byTypeMap.get(b.typeNameSnap) ?? { name: b.typeNameSnap, count: 0, amount: 0 };
      t.count++; t.amount += b.base;
      byTypeMap.set(b.typeNameSnap, t);
      const p = pkgMap.get(b.typeNameSnap) ?? { name: b.typeNameSnap, count: 0, revenue: 0, base: 0, addons: 0, hours: 0 };
      p.count++; p.revenue += basis === 'BILLED' ? b.total : b.paidAmount; p.base += b.base; p.addons += b.addons; p.hours += b.hours;
      pkgMap.set(b.typeNameSnap, p);
      addons += b.addons; adjustments += b.adjustment; billed += b.total; collected += b.paidAmount;
      if (new Date(b.startAt).getTime() > now) upcoming += b.total;
    }
    const revenueTotal = basis === 'BILLED' ? billed : collected;

    const byCategory = await this.db.many(
      `SELECT c.id, c.name, c.kind, sum(e.amount)::bigint AS amount, count(*)::int AS count
         FROM expenses e JOIN expense_categories c ON c.id = e.category_id
        WHERE e.deleted_at IS NULL AND e.status = 'CONFIRMED' AND to_char(e.paid_on, 'YYYY-MM') = $1
        GROUP BY c.id ORDER BY amount DESC`, [month], q);
    const expensesTotal = byCategory.reduce((a, c) => a + c.amount, 0);

    const topAddons = await this.db.many(
      `SELECT a.name_snap AS name, count(DISTINCT a.booking_id)::int AS bookings, sum(a.line_total)::bigint AS revenue
         FROM booking_addons a JOIN bookings b ON b.id = a.booking_id
        WHERE b.status IN ('CONFIRMED','COMPLETED') AND wib_month(b.start_at) = $1
        GROUP BY a.name_snap ORDER BY revenue DESC LIMIT 5`, [month], q);

    const drafts = await this.db.one(
      `SELECT count(*)::int AS count, coalesce(sum(amount), 0)::bigint AS amount FROM expenses
        WHERE deleted_at IS NULL AND status = 'DRAFT' AND to_char(paid_on, 'YYYY-MM') = $1`, [month], q);

    const receivables = bookings.filter((b) => b.balance > 0).map((b) => ({
      id: b.id, bookingNo: b.bookingNo, clientName: b.clientNameSnap, startAt: b.startAt, total: b.total, paid: b.paidAmount, balance: b.balance, status: b.status,
    }));
    const netProfit = revenueTotal - expensesTotal;
    const close = await this.db.one(`SELECT * FROM month_closes WHERE month = $1`, [month], q);

    return {
      month, basis,
      revenue: {
        byType: [...byTypeMap.values()], addons, adjustments, billed, collected,
        uncollected: basis === 'COLLECTED' ? billed - collected : 0,
        total: revenueTotal, upcoming, bookingCount: bookings.length,
      },
      expenses: { byCategory, total: expensesTotal },
      packages: [...pkgMap.values()]
        .map((p) => ({ ...p, avg: p.count ? Math.round(p.revenue / p.count) : 0, share: revenueTotal > 0 ? Math.round((p.revenue / revenueTotal) * 1000) / 10 : 0 }))
        .sort((x, y) => y.revenue - x.revenue),
      topAddons,
      netProfit,
      marginPct: revenueTotal > 0 ? Math.round((netProfit / revenueTotal) * 1000) / 10 : null,
      drafts,
      receivables: { items: receivables, total: receivables.reduce((a, r) => a + r.balance, 0) },
      closed: !!close?.closed,
      closeInfo: close,
      bookings,
    };
  }

  /**
   * Monthly totals for an inclusive range of WIB months, with the same rules as recap():
   * revenue by session month (BR-10, Cancelled excluded), confirmed expenses by month paid (BR-12).
   */
  private async monthly(from: string, to: string, basis: RevenueBasis, q: Queryable) {
    const range = [fromWib(`${from}-01`), fromWib(`${shiftMonth(to, 1)}-01`)];
    const rev = await this.db.many(
      `SELECT wib_month(b.start_at) AS month, count(*)::int AS bookings,
              sum(b.total)::bigint AS billed, sum(b.paid_amount)::bigint AS collected,
              sum(round(b.rate_snap * b.duration_min / 60.0))::bigint AS base, sum(b.adjustment)::bigint AS adjustments,
              coalesce(sum(a.addons), 0)::bigint AS addons, sum(b.total - b.paid_amount)::bigint AS receivable,
              count(*) FILTER (WHERE b.start_at > now())::int AS upcoming
         FROM bookings b
         LEFT JOIN (SELECT booking_id, sum(line_total) AS addons FROM booking_addons GROUP BY booking_id) a ON a.booking_id = b.id
        WHERE b.status IN ('CONFIRMED','COMPLETED') AND b.start_at >= $1 AND b.start_at < $2
        GROUP BY 1`, range, q);
    const types = await this.db.many(
      `SELECT wib_month(start_at) AS month, type_name_snap AS name, sum(round(rate_snap * duration_min / 60.0))::bigint AS amount
         FROM bookings WHERE status IN ('CONFIRMED','COMPLETED') AND start_at >= $1 AND start_at < $2
        GROUP BY 1, 2`, range, q);
    const exp = await this.db.many(
      `SELECT to_char(paid_on, 'YYYY-MM') AS month,
              coalesce(sum(amount) FILTER (WHERE status = 'CONFIRMED'), 0)::bigint AS expenses,
              count(*) FILTER (WHERE status = 'DRAFT')::int AS drafts
         FROM expenses WHERE deleted_at IS NULL AND paid_on >= $1::date AND paid_on < $2::date
        GROUP BY 1`, [`${from}-01`, `${shiftMonth(to, 1)}-01`], q);
    const cats = await this.db.many(
      `SELECT c.name, sum(e.amount)::bigint AS amount
         FROM expenses e JOIN expense_categories c ON c.id = e.category_id
        WHERE e.deleted_at IS NULL AND e.status = 'CONFIRMED' AND e.paid_on >= $1::date AND e.paid_on < $2::date
        GROUP BY c.name ORDER BY amount DESC`, [`${from}-01`, `${shiftMonth(to, 1)}-01`], q);
    const closed = new Set((await this.db.many(`SELECT month FROM month_closes WHERE closed AND month BETWEEN $1 AND $2`, [from, to], q)).map((r) => r.month));

    const current = wibMonth(new Date());
    const out = [];
    for (let m = from; m <= to; m = shiftMonth(m, 1)) {
      const r = rev.find((x) => x.month === m);
      const e = exp.find((x) => x.month === m);
      const revenue = r ? (basis === 'BILLED' ? r.billed : r.collected) : 0;
      const expenses = e?.expenses ?? 0;
      out.push({
        month: m,
        bookings: r?.bookings ?? 0,
        upcoming: r?.upcoming ?? 0,
        billed: r?.billed ?? 0,
        collected: r?.collected ?? 0,
        revenue,
        expenses,
        net: revenue - expenses,
        marginPct: revenue > 0 ? Math.round(((revenue - expenses) / revenue) * 1000) / 10 : null,
        receivable: r?.receivable ?? 0,
        addons: r?.addons ?? 0,
        adjustments: r?.adjustments ?? 0,
        byType: types.filter((t) => t.month === m).map((t) => ({ name: t.name, amount: t.amount })),
        drafts: e?.drafts ?? 0,
        closed: closed.has(m),
        // the running month still gains costs and contains future sessions
        partial: m >= current,
      });
    }
    return { months: out, expenseCategories: cats };
  }

  /** Owner dashboard: the last `count` months ending at `end`, window totals and year-to-date (FR-28). */
  async trend(end: string, count: number, basisOverride?: RevenueBasis, q: Queryable = this.db.pool) {
    const basis: RevenueBasis = basisOverride ?? (await this.db.one(`SELECT revenue_basis FROM settings WHERE id = 1`, [], q)).revenueBasis;
    const start = shiftMonth(end, -(count - 1));
    const { months, expenseCategories } = await this.monthly(start, end, basis, q);
    const sum = (rows: typeof months, k: 'revenue' | 'expenses' | 'net' | 'bookings' | 'addons' | 'adjustments') => rows.reduce((a, r) => a + r[k], 0);
    const summarise = (rows: typeof months) => {
      const revenue = sum(rows, 'revenue');
      const net = sum(rows, 'net');
      return { revenue, expenses: sum(rows, 'expenses'), net, bookings: sum(rows, 'bookings'), marginPct: revenue > 0 ? Math.round((net / revenue) * 1000) / 10 : null };
    };
    // best / worst / average use finished months only; the running month would distort them
    const active = months.filter((m) => !m.partial && (m.bookings || m.expenses));
    const byNet = [...active].sort((a, b) => b.net - a.net);

    const typeTotals = new Map<string, number>();
    for (const m of months) for (const t of m.byType) typeTotals.set(t.name, (typeTotals.get(t.name) ?? 0) + t.amount);

    const yearStart = `${end.slice(0, 4)}-01`;
    const ytdRows = yearStart >= start ? months.filter((m) => m.month >= yearStart) : (await this.monthly(yearStart, end, basis, q)).months;
    const prevYear = (await this.monthly(shiftMonth(yearStart, -12), shiftMonth(end, -12), basis, q)).months;

    return {
      basis, start, end, months,
      window: {
        ...summarise(months),
        avgNet: active.length ? Math.round(sum(active, 'net') / active.length) : 0,
        activeMonths: active.length,
        best: byNet[0] ? { month: byNet[0].month, net: byNet[0].net } : null,
        worst: byNet.length > 1 ? { month: byNet.at(-1)!.month, net: byNet.at(-1)!.net } : null,
        lossMonths: active.filter((m) => m.net < 0).length,
        revenueMix: [
          ...[...typeTotals].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
          { name: 'Add-on', amount: sum(months, 'addons') },
          ...(sum(months, 'adjustments') ? [{ name: 'Penyesuaian harga', amount: sum(months, 'adjustments') }] : []),
        ],
        expenseCategories,
      },
      ytd: { year: end.slice(0, 4), ...summarise(ytdRows), previousYear: summarise(prevYear) },
    };
  }
}

@OwnerOnly()
@Controller()
export class FinanceController {
  constructor(private db: Db, private recaps: RecapService, private docs: DocumentsService) {}

  // ---------- expenses (L2-4.1, BR-11 Owner only) ----------

  @Get('expenses')
  list(@Query('month') month?: string, @Query('categoryId') categoryId?: string, @Query('q') q?: string, @Query('status') status?: string) {
    const where = ['e.deleted_at IS NULL'];
    const p: unknown[] = [];
    if (month) { p.push(checkMonth(month)); where.push(`to_char(e.paid_on, 'YYYY-MM') = $${p.length}`); }
    if (categoryId) { if (!z.string().uuid().safeParse(categoryId).success) throw badRequest('Kategori tidak valid'); p.push(categoryId); where.push(`e.category_id = $${p.length}`); }
    if (status === 'DRAFT' || status === 'CONFIRMED') { p.push(status); where.push(`e.status = $${p.length}`); }
    if (q) { p.push(`%${q}%`); where.push(`(e.payee ILIKE $${p.length} OR e.note ILIKE $${p.length})`); }
    return this.db.many(
      `SELECT e.*, c.name AS category_name, b.booking_no, b.client_name_snap AS booking_client
         FROM expenses e JOIN expense_categories c ON c.id = e.category_id LEFT JOIN bookings b ON b.id = e.booking_id
        WHERE ${where.join(' AND ')} ORDER BY e.status = 'DRAFT' DESC, e.paid_on DESC, e.created_at DESC LIMIT 500`, p);
  }

  @Get('expenses/:id')
  async get(@Param('id', Id) id: string) {
    const e = await this.db.one(
      `SELECT e.*, c.name AS category_name, b.booking_no FROM expenses e JOIN expense_categories c ON c.id = e.category_id
         LEFT JOIN bookings b ON b.id = e.booking_id WHERE e.id = $1 AND e.deleted_at IS NULL`, [id]);
    return e ?? Promise.reject(notFound('Pengeluaran'));
  }

  @Post('expenses')
  async create(@Body(Body$(expenseInput)) b: z.infer<typeof expenseInput>, @CurrentUser() u: AuthUser) {
    await this.validate(b);
    if (!b.force) {
      const dup = await this.db.one(
        `SELECT id FROM expenses WHERE deleted_at IS NULL AND category_id = $1 AND amount = $2 AND paid_on = $3 LIMIT 1`, [b.categoryId, b.amount, b.paidOn]);
      if (dup) throw conflict('DUPLICATE_SUSPECT', 'Sepertinya duplikat — tetap simpan?', { duplicateId: dup.id });
    }
    return this.db.tx(async (c) => {
      const e = await this.db.one(
        `INSERT INTO expenses (category_id, amount, paid_on, payee, note, booking_id, status, source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'CONFIRMED','MANUAL',$7) RETURNING *`,
        [b.categoryId, b.amount, b.paidOn, b.payee || null, b.note || null, b.bookingId ?? null, u.id], c);
      await c.query(`INSERT INTO expense_audit (expense_id, changed_by, action, after) VALUES ($1,$2,'CREATE',$3)`, [e.id, u.id, e]);
      return e;
    });
  }

  @Patch('expenses/:id')
  async update(@Param('id', Id) id: string, @Body(Body$(expenseInput)) b: z.infer<typeof expenseInput>, @CurrentUser() u: AuthUser) {
    await this.validate(b);
    return this.db.tx(async (c) => {
      const before = await this.db.one(`SELECT * FROM expenses WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id], c);
      if (!before) throw notFound('Pengeluaran');
      const e = await this.db.one(
        `UPDATE expenses SET category_id=$2, amount=$3, paid_on=$4, payee=$5, note=$6, booking_id=$7, status='CONFIRMED', updated_at=now()
          WHERE id=$1 RETURNING *`,
        [id, b.categoryId, b.amount, b.paidOn, b.payee || null, b.note || null, b.bookingId ?? null], c);
      await c.query(`INSERT INTO expense_audit (expense_id, changed_by, action, before, after) VALUES ($1,$2,'EDIT',$3,$4)`, [id, u.id, before, e]);
      return e;
    });
  }

  /** PRD 4.2.2: confirm a draft; Rp0 means "no fee". */
  @Post('expenses/:id/confirm') @HttpCode(200)
  confirm(@Param('id', Id) id: string, @Body(Body$(confirmExpenseInput)) b: { amount: number }, @CurrentUser() u: AuthUser) {
    return this.db.tx(async (c) => {
      const before = await this.db.one(`SELECT * FROM expenses WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id], c);
      if (!before) throw notFound('Pengeluaran');
      const e = await this.db.one(`UPDATE expenses SET amount=$2, status='CONFIRMED', updated_at=now() WHERE id=$1 RETURNING *`, [id, b.amount], c);
      await c.query(`INSERT INTO expense_audit (expense_id, changed_by, action, before, after) VALUES ($1,$2,'CONFIRM',$3,$4)`, [id, u.id, before, e]);
      return e;
    });
  }

  /** BR-14: soft delete, kept in the audit log. */
  @Delete('expenses/:id') @HttpCode(204)
  async remove(@Param('id', Id) id: string, @CurrentUser() u: AuthUser) {
    await this.db.tx(async (c) => {
      const before = await this.db.one(`SELECT * FROM expenses WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id], c);
      if (!before) throw notFound('Pengeluaran');
      await c.query(`UPDATE expenses SET deleted_at = now() WHERE id = $1`, [id]);
      await c.query(`INSERT INTO expense_audit (expense_id, changed_by, action, before) VALUES ($1,$2,'DELETE',$3)`, [id, u.id, before]);
    });
  }

  /** Receipt ≤ 5 MB, JPG/PNG/PDF sniffed from magic bytes, stored under a random key (TD §3.4). */
  @Post('expenses/:id/receipt') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async receipt(@Param('id', Id) id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw badRequest('File wajib diunggah');
    const mime = MIME.find(([, sig]) => file.buffer.subarray(0, sig.length).equals(sig))?.[0];
    if (!mime) throw badRequest('Hanya JPG, PNG atau PDF');
    const key = `receipts/${randomUUID()}`;
    mkdirSync(join(config.filesDir, 'receipts'), { recursive: true });
    writeFileSync(join(config.filesDir, key), file.buffer);
    const e = await this.db.one(`UPDATE expenses SET receipt_key=$2, receipt_mime=$3, updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *`, [id, key, mime]);
    return e ?? Promise.reject(notFound('Pengeluaran'));
  }

  @Get('expenses/:id/receipt')
  async getReceipt(@Param('id', Id) id: string, @Res() res: Response) {
    const e = await this.db.one(`SELECT receipt_key, receipt_mime FROM expenses WHERE id = $1`, [id]);
    const path = e?.receiptKey ? join(config.filesDir, e.receiptKey) : null;
    if (!path || !existsSync(path)) throw notFound('Bukti');
    res.set({ 'Content-Type': e.receiptMime, 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline' });
    res.send(readFileSync(path));
  }

  private async validate(b: z.infer<typeof expenseInput>) {
    if (b.paidOn > wibDate(new Date())) throw badRequest('Tanggal tidak boleh di masa depan', { paidOn: 'Tanggal tidak boleh di masa depan' });
    const cat = await this.db.one(`SELECT active FROM expense_categories WHERE id = $1`, [b.categoryId]);
    if (!cat) throw badRequest('Kategori tidak ditemukan', { categoryId: 'Pilih kategori' });
    if (b.bookingId && !(await this.db.one(`SELECT 1 FROM bookings WHERE id = $1`, [b.bookingId]))) throw badRequest('Booking tidak ditemukan', { bookingId: 'Booking tidak ditemukan' });
  }

  // ---------- dashboard trend (FR-28) ----------

  @Get('reports/trend')
  trend(@Query('end') end?: string, @Query('months') months?: string, @Query('basis') basis?: string) {
    const e = end ? checkMonth(end) : wibMonth(new Date());
    const n = months === undefined ? 12 : Number(months);
    if (!Number.isInteger(n) || n < 1 || n > 36) throw badRequest('Jumlah bulan 1–36');
    return this.recaps.trend(e, n, basis === 'BILLED' || basis === 'COLLECTED' ? basis : undefined);
  }

  // ---------- recap (L2-4.3) ----------

  @Get('reports/recap')
  async recap(@Query('month') month: string, @Query('basis') basis?: string) {
    checkMonth(month);
    const b = basis === 'BILLED' || basis === 'COLLECTED' ? basis : undefined;
    const cur = await this.recaps.recap(month, b);
    const prev = await this.recaps.recap(shiftMonth(month, -1), cur.basis);
    const { bookings, ...rest } = cur;
    return {
      ...rest,
      previous: { month: prev.month, revenue: prev.revenue.total, expenses: prev.expenses.total, netProfit: prev.netProfit, bookings: prev.revenue.bookingCount, marginPct: prev.marginPct },
      // same package last month, for "▲/▼ vs last month" on the ranking
      packages: cur.packages.map((p) => {
        const before = prev.packages.find((x) => x.name === p.name);
        return { ...p, prevRevenue: before?.revenue ?? 0, prevCount: before?.count ?? 0 };
      }),
      expenseChange: cur.expenses.byCategory.map((c) => ({ id: c.id, prevAmount: prev.expenses.byCategory.find((x) => x.id === c.id)?.amount ?? 0 })),
      revenueBookings: bookings.map((x) => ({ id: x.id, bookingNo: x.bookingNo, clientName: x.clientNameSnap, type: x.typeNameSnap, startAt: x.startAt, total: x.total, paid: x.paidAmount, status: x.status })),
    };
  }

  /** FR-17: income-2026 order — Date, Client, Description, Amount; expenses as negative rows; Total row. */
  @Get('reports/recap.csv')
  async csv(@Query('month') month: string, @Res() res: Response) {
    checkMonth(month);
    const r = await this.recaps.recap(month);
    const bookings = await this.db.many(
      `SELECT b.start_at, b.client_name_snap, b.type_name_snap, b.duration_min, b.total, b.paid_amount,
              (SELECT string_agg(a.name_snap || CASE WHEN a.qty > 1 THEN ' x' || a.qty ELSE '' END, ', ') FROM booking_addons a WHERE a.booking_id = b.id) AS addons
         FROM bookings b WHERE b.status IN ('CONFIRMED','COMPLETED') AND wib_month(b.start_at) = $1 ORDER BY b.start_at`, [month]);
    const expenses = await this.db.many(
      `SELECT e.paid_on, e.payee, e.note, e.amount, c.name AS category FROM expenses e JOIN expense_categories c ON c.id = e.category_id
        WHERE e.deleted_at IS NULL AND e.status = 'CONFIRMED' AND to_char(e.paid_on, 'YYYY-MM') = $1 ORDER BY e.paid_on`, [month]);
    // SEC-C5: text cells starting with = + - @ tab or CR are prefixed with ' so spreadsheets don't evaluate them
    const esc = (v: unknown) => {
      let s = String(v ?? '');
      if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows: unknown[][] = [['Date', 'Client', 'Description', 'Amount']];
    for (const b of bookings) {
      const amt = r.basis === 'BILLED' ? b.total : b.paidAmount;
      rows.push([wibDate(b.startAt), b.clientNameSnap, `${b.typeNameSnap} ${durationLabel(b.durationMin)}${b.addons ? ' + ' + b.addons : ''}`, amt]);
    }
    for (const e of expenses) rows.push([e.paidOn, e.payee ?? '', e.note?.startsWith(e.category) ? e.note : `${e.category}${e.note ? ' — ' + e.note : ''}`, -e.amount]);
    rows.push(['', '', 'Total', r.netProfit]);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="rekap-${month}.csv"` });
    res.send('﻿' + rows.map((row) => row.map(esc).join(',')).join('\r\n'));
  }

  @Get('reports/recap.pdf')
  async pdf(@Query('month') month: string, @Res() res: Response) {
    checkMonth(month);
    const pdf = await this.docs.recapPdf(await this.recaps.recap(month));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="rekap-${month}.pdf"` });
    res.send(pdf);
  }

  /** US-27.3/27.4: close needs no drafts left; locked by the month trigger (BR-13). */
  @Post('reports/months/:month/close') @HttpCode(200)
  async close(@Param('month') month: string, @CurrentUser() u: AuthUser) {
    checkMonth(month);
    if (month >= wibMonth(new Date())) throw badRequest('Hanya bulan yang sudah lewat yang bisa ditutup');
    const drafts = await this.db.one(
      `SELECT count(*)::int AS n FROM expenses WHERE deleted_at IS NULL AND status='DRAFT' AND to_char(paid_on,'YYYY-MM') = $1`, [month]);
    if (drafts.n > 0) throw conflict('DRAFTS_LEFT', `Konfirmasi atau hapus ${drafts.n} draft dulu`, { drafts: drafts.n });
    return this.db.one(
      `INSERT INTO month_closes (month, closed, closed_at, closed_by) VALUES ($1, true, now(), $2)
       ON CONFLICT (month) DO UPDATE SET closed = true, closed_at = now(), closed_by = $2 RETURNING *`, [month, u.id]);
  }

  @Post('reports/months/:month/reopen') @HttpCode(200)
  async reopen(@Param('month') month: string, @Body(Body$(reopenInput)) b: { reason: string }, @CurrentUser() u: AuthUser) {
    checkMonth(month);
    const r = await this.db.one(
      `UPDATE month_closes SET closed = false, reopened_at = now(), reopened_by = $2, reopen_reason = $3 WHERE month = $1 AND closed RETURNING *`,
      [month, u.id, b.reason]);
    if (!r) throw new AppError(409, 'NOT_CLOSED', 'Bulan ini belum ditutup');
    return r;
  }
}
