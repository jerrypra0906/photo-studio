import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import argon2 from 'argon2';
import { z } from 'zod';
import {
  DEFAULT_TEMPLATES, PLACEHOLDERS, TEMPLATE_KINDS, addonInput, bookingTypeInput, expenseCategoryInput, photographerInput,
  settingsInput, unknownPlaceholders, userInput,
} from '@jes/shared';
import { AuthUser, Body$, CurrentUser, OwnerOnly, badRequest, conflict, forgetUser, notFound } from '../common/http';
import { Db } from '../db';

const Id = new ParseUUIDPipe();

/** Admin masters (PRD P3). Reads are open to signed-in users (the booking form needs them); writes are Owner only. */
@Controller()
export class MastersController {
  constructor(private db: Db) {}

  // ---------- booking types (L2-3.1) ----------
  @Get('booking-types')
  bookingTypes() {
    return this.db.many(`
      SELECT t.*, EXISTS (SELECT 1 FROM bookings b WHERE b.type_id = t.id) AS in_use
        FROM booking_types t ORDER BY t.sort_order, t.name`);
  }

  @OwnerOnly() @Post('booking-types')
  createType(@Body(Body$(bookingTypeInput)) b: z.infer<typeof bookingTypeInput>) {
    if (b.maxHours < b.minHours) throw badRequest('Maks jam harus ≥ min jam', { maxHours: 'Maks jam harus ≥ min jam' });
    return this.db.one(
      `INSERT INTO booking_types (name, hourly_rate, requires_photographer, min_hours, max_hours, calendar_keyword, color_id, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.name, b.hourlyRate, b.requiresPhotographer, b.minHours, b.maxHours, b.calendarKeyword, b.colorId ?? null, b.active, b.sortOrder]);
  }

  @OwnerOnly() @Patch('booking-types/:id')
  async updateType(@Param('id', Id) id: string, @Body(Body$(bookingTypeInput)) b: z.infer<typeof bookingTypeInput>) {
    if (b.maxHours < b.minHours) throw badRequest('Maks jam harus ≥ min jam', { maxHours: 'Maks jam harus ≥ min jam' });
    const r = await this.db.one(
      `UPDATE booking_types SET name=$2, hourly_rate=$3, requires_photographer=$4, min_hours=$5, max_hours=$6, calendar_keyword=$7,
              color_id=$8, active=$9, sort_order=$10, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, b.name, b.hourlyRate, b.requiresPhotographer, b.minHours, b.maxHours, b.calendarKeyword, b.colorId ?? null, b.active, b.sortOrder]);
    return r ?? Promise.reject(notFound('Jenis booking'));
  }

  @OwnerOnly() @Delete('booking-types/:id') @HttpCode(204)
  async deleteType(@Param('id', Id) id: string) {
    if (await this.db.one(`SELECT 1 FROM bookings WHERE type_id=$1 LIMIT 1`, [id])) throw conflict('IN_USE', 'Sudah dipakai booking — nonaktifkan saja');
    await this.db.many(`DELETE FROM addon_types WHERE type_id=$1`, [id]);
    await this.db.many(`DELETE FROM booking_types WHERE id=$1`, [id]);
  }

  // ---------- photographers (L2-3.2) ----------
  @Get('photographers')
  photographers() {
    return this.db.many(`
      SELECT p.*, EXISTS (SELECT 1 FROM bookings b WHERE b.photographer_id = p.id) AS in_use
        FROM photographers p ORDER BY p.active DESC, p.name`);
  }

  @OwnerOnly() @Post('photographers')
  createPhotographer(@Body(Body$(photographerInput)) b: z.infer<typeof photographerInput>) {
    return this.db.one(
      `INSERT INTO photographers (name, phone, email, default_fee, fee_unit, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.name, b.phone || null, b.email || null, b.defaultFee ?? null, b.feeUnit, b.active]);
  }

  /** US-19.3: deactivating with future bookings returns the list unless ?confirm=true. */
  @OwnerOnly() @Patch('photographers/:id')
  async updatePhotographer(@Param('id', Id) id: string, @Body(Body$(photographerInput)) b: z.infer<typeof photographerInput>, @Query('confirm') confirm?: string) {
    if (!b.active && confirm !== 'true') {
      const future = await this.db.many(
        `SELECT id, booking_no, client_name_snap, start_at FROM bookings
          WHERE photographer_id=$1 AND status='CONFIRMED' AND start_at > now() ORDER BY start_at`, [id]);
      if (future.length) throw conflict('FUTURE_BOOKINGS', `Masih ada ${future.length} booking mendatang`, { bookings: future });
    }
    const r = await this.db.one(
      `UPDATE photographers SET name=$2, phone=$3, email=$4, default_fee=$5, fee_unit=$6, active=$7, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, b.name, b.phone || null, b.email || null, b.defaultFee ?? null, b.feeUnit, b.active]);
    return r ?? Promise.reject(notFound('Fotografer'));
  }

  @OwnerOnly() @Delete('photographers/:id') @HttpCode(204)
  async deletePhotographer(@Param('id', Id) id: string) {
    if (await this.db.one(`SELECT 1 FROM bookings WHERE photographer_id=$1 UNION ALL SELECT 1 FROM expenses WHERE photographer_id=$1 LIMIT 1`, [id]))
      throw conflict('IN_USE', 'Sudah dipakai — nonaktifkan saja');
    await this.db.many(`DELETE FROM photographers WHERE id=$1`, [id]);
  }

  // ---------- add-ons (L2-3.3) ----------
  @Get('addons')
  addons() {
    return this.db.many(`
      SELECT a.*, coalesce(array_agg(at.type_id) FILTER (WHERE at.type_id IS NOT NULL), '{}') AS type_ids,
             EXISTS (SELECT 1 FROM booking_addons ba WHERE ba.addon_id = a.id) AS in_use
        FROM addons a LEFT JOIN addon_types at ON at.addon_id = a.id
       GROUP BY a.id ORDER BY a.sort_order, a.name`);
  }

  @OwnerOnly() @Post('addons')
  createAddon(@Body(Body$(addonInput)) b: z.infer<typeof addonInput>) {
    return this.db.tx(async (c) => {
      const a = await this.db.one(
        `INSERT INTO addons (name, price, unit, vendor_fee, vendor_name, active, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.name, b.price, b.unit, b.vendorFee ?? null, b.vendorName || null, b.active, b.sortOrder], c);
      await c.query(`INSERT INTO addon_types (addon_id, type_id) SELECT $1, unnest($2::uuid[])`, [a.id, b.typeIds]);
      return { ...a, typeIds: b.typeIds };
    });
  }

  @OwnerOnly() @Patch('addons/:id')
  updateAddon(@Param('id', Id) id: string, @Body(Body$(addonInput)) b: z.infer<typeof addonInput>) {
    return this.db.tx(async (c) => {
      const a = await this.db.one(
        `UPDATE addons SET name=$2, price=$3, unit=$4, vendor_fee=$5, vendor_name=$6, active=$7, sort_order=$8, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, b.name, b.price, b.unit, b.vendorFee ?? null, b.vendorName || null, b.active, b.sortOrder], c);
      if (!a) throw notFound('Add-on');
      await c.query(`DELETE FROM addon_types WHERE addon_id=$1`, [id]);
      await c.query(`INSERT INTO addon_types (addon_id, type_id) SELECT $1, unnest($2::uuid[])`, [id, b.typeIds]);
      return { ...a, typeIds: b.typeIds };
    });
  }

  @OwnerOnly() @Delete('addons/:id') @HttpCode(204)
  async deleteAddon(@Param('id', Id) id: string) {
    if (await this.db.one(`SELECT 1 FROM booking_addons WHERE addon_id=$1 LIMIT 1`, [id])) throw conflict('IN_USE', 'Sudah dipakai booking — nonaktifkan saja');
    await this.db.many(`DELETE FROM addons WHERE id=$1`, [id]);
  }

  // ---------- expense categories (L2-3.5) — Owner only, finance data ----------
  @OwnerOnly() @Get('expense-categories')
  categories() {
    return this.db.many(`
      SELECT c.*, EXISTS (SELECT 1 FROM expenses e WHERE e.category_id = c.id) AS in_use,
             (SELECT count(*)::int FROM expenses e WHERE e.category_id = c.id AND e.created_at > now() - interval '90 days') AS recent_uses
        FROM expense_categories c ORDER BY c.sort_order, c.name`);
  }

  @OwnerOnly() @Post('expense-categories')
  createCategory(@Body(Body$(expenseCategoryInput)) b: z.infer<typeof expenseCategoryInput>) {
    return this.db.one(
      `INSERT INTO expense_categories (name, kind, recurring, default_amount, active, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.name, b.kind, b.recurring, b.defaultAmount ?? null, b.active, b.sortOrder]);
  }

  @OwnerOnly() @Patch('expense-categories/:id')
  async updateCategory(@Param('id', Id) id: string, @Body(Body$(expenseCategoryInput)) b: z.infer<typeof expenseCategoryInput>) {
    const r = await this.db.one(
      `UPDATE expense_categories SET name=$2, kind=$3, recurring=$4, default_amount=$5, active=$6, sort_order=$7, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, b.name, b.kind, b.recurring, b.defaultAmount ?? null, b.active, b.sortOrder]);
    return r ?? Promise.reject(notFound('Kategori'));
  }

  @OwnerOnly() @Delete('expense-categories/:id') @HttpCode(204)
  async deleteCategory(@Param('id', Id) id: string) {
    const c = await this.db.one(`SELECT code FROM expense_categories WHERE id=$1`, [id]);
    if (c?.code) throw conflict('IN_USE', 'Kategori sistem tidak bisa dihapus');
    if (await this.db.one(`SELECT 1 FROM expenses WHERE category_id=$1 LIMIT 1`, [id])) throw conflict('IN_USE', 'Sudah ada pengeluaran — nonaktifkan saja');
    await this.db.many(`DELETE FROM expense_categories WHERE id=$1`, [id]);
  }

  // ---------- users (Staff role, FR-16) ----------
  @OwnerOnly() @Get('users')
  users() {
    return this.db.many(`SELECT id, name, email, role, active, created_at FROM users ORDER BY role, name`);
  }

  @OwnerOnly() @Post('users')
  async createUser(@Body(Body$(userInput)) b: z.infer<typeof userInput>) {
    if (!b.password) throw badRequest('Kata sandi wajib diisi', { password: 'Kata sandi wajib diisi' });
    return this.db.one(
      `INSERT INTO users (name, email, password_hash, role, active) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role, active`,
      [b.name, b.email, await argon2.hash(b.password, { type: argon2.argon2id }), b.role, b.active]);
  }

  @OwnerOnly() @Patch('users/:id')
  async updateUser(@Param('id', Id) id: string, @Body(Body$(userInput)) b: z.infer<typeof userInput>, @CurrentUser() me: AuthUser) {
    if (id === me.id && (!b.active || b.role !== 'OWNER')) throw badRequest('Tidak bisa menonaktifkan atau menurunkan akun sendiri');
    const hash = b.password ? await argon2.hash(b.password, { type: argon2.argon2id }) : null;
    const r = await this.db.one(
      `UPDATE users SET name=$2, email=$3, role=$4, active=$5, password_hash=coalesce($6, password_hash), updated_at=now()
        WHERE id=$1 RETURNING id, name, email, role, active`, [id, b.name, b.email, b.role, b.active, hash]);
    if (r && (!b.active || hash)) await this.db.many(`UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [id]);
    forgetUser(id);
    return r ?? Promise.reject(notFound('Pengguna'));
  }

  // ---------- settings (L2-3.4) ----------
  @Get('settings')
  async settings(@CurrentUser() u: AuthUser) {
    const s = await this.db.one(`SELECT * FROM settings WHERE id = 1`);
    delete s.gcalRefreshToken;
    if (u.role !== 'OWNER') delete s.revenueBasis;
    return s;
  }

  @OwnerOnly() @Put('settings')
  async updateSettings(@Body(Body$(settingsInput)) b: z.infer<typeof settingsInput>) {
    const s = await this.db.one(
      `UPDATE settings SET studio_name=$1, studio_phone=$2, address=$3, maps_url=$4, bank_name=$5, account_no=$6, account_holder=$7,
              open_hours=$8, slot_step_min=$9, max_hours=$10, buffer_min=$11, dp_rule_text=$12, terms_text=$13, revenue_basis=$14,
              gcal_cancel_mode=$15, gcal_mark_completed=$16, updated_at=now()
        WHERE id=1 RETURNING *`,
      [b.studioName, b.studioPhone, b.address, b.mapsUrl, b.bankName, b.accountNo, b.accountHolder, JSON.stringify(b.openHours),
       b.slotStepMin, b.maxHours, b.bufferMin, b.dpRuleText, b.termsText, b.revenueBasis, b.gcalCancelMode, b.gcalMarkCompleted]);
    delete s.gcalRefreshToken;
    return s;
  }

  // ---------- WhatsApp templates (L2-3.4.3) ----------
  @Get('templates')
  async templates() {
    const rows = await this.db.many(`SELECT kind, body, updated_at FROM message_templates`);
    return { templates: rows, placeholders: PLACEHOLDERS, defaults: DEFAULT_TEMPLATES };
  }

  @OwnerOnly() @Put('templates/:kind')
  async updateTemplate(@Param('kind') kind: string, @Body(Body$(z.object({ body: z.string().min(1).max(4000) }))) b: { body: string }) {
    if (!(TEMPLATE_KINDS as readonly string[]).includes(kind)) throw notFound('Template');
    const unknown = unknownPlaceholders(b.body);
    if (unknown.length) {
      throw badRequest(`Placeholder tidak dikenal: ${unknown.map((u) => `{${u}}`).join(', ')}`, {
        body: `Placeholder tidak dikenal: ${unknown.map((u) => `{${u}}`).join(', ')}. Yang valid: ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}`,
      });
    }
    return this.db.one(
      `INSERT INTO message_templates (kind, body) VALUES ($1,$2) ON CONFLICT (kind) DO UPDATE SET body=$2, updated_at=now() RETURNING *`, [kind, b.body]);
  }
}
