import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AppError, AuthUser, Body$, CurrentUser, OwnerOnly, Public, badRequest, conflict, notFound } from '../common/http';
import { config } from '../config';
import { Db } from '../db';
import { GoogleService } from './google.service';

/** PRD P5 / L2-5.1 — Owner only. */
@Controller('integrations/google')
export class IntegrationsController {
  constructor(private g: GoogleService) {}

  @OwnerOnly() @Get()
  status() {
    return this.g.status();
  }

  @OwnerOnly() @Get('auth-url')
  authUrl(@CurrentUser() u: AuthUser) {
    return { url: this.g.authUrl(u.id) };
  }

  /** Google redirects the browser here; the signed state proves an Owner started the flow. */
  @Public() @Get('callback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Query('error') error: string, @Res() res: Response) {
    const result = await this.g.callback(code, state, error).catch((e) => {
      console.error('gcal callback', e?.message);
      return 'error=exchange';
    });
    res.redirect(`${config.appUrl}/admin/integrations?${result}`);
  }

  @OwnerOnly() @Get('calendars')
  calendars() {
    return this.g.calendars();
  }

  @OwnerOnly() @Put('calendar')
  select(@Body(Body$(z.object({ calendarId: z.string().min(1).max(300), pushExisting: z.boolean().default(false) }))) b: { calendarId: string; pushExisting: boolean }) {
    return this.g.selectCalendar(b.calendarId, b.pushExisting);
  }

  @OwnerOnly() @Post('resync') @HttpCode(200)
  async resync() {
    return { queued: await this.g.resyncAll() };
  }

  @OwnerOnly() @Post('test') @HttpCode(200)
  test() {
    return this.g.test();
  }

  @OwnerOnly() @Post('disconnect') @HttpCode(204)
  disconnect() {
    return this.g.disconnect();
  }
}

/** Events made directly in Google Calendar, waiting to become a booking or be ignored. Owner and Staff both take bookings. */
@Controller('calendar-inbox')
export class CalendarInboxController {
  constructor(private db: Db, private g: GoogleService) {}

  @Get()
  async list(@Query('status') status = 'PENDING') {
    if (!['PENDING', 'IGNORED'].includes(status)) throw badRequest('Status tidak valid');
    const s = await this.db.one(`SELECT gcal_status, gcal_calendar_name, gcal_pulled_at, gcal_pull_error FROM settings WHERE id = 1`);
    const items = await this.db.many(
      `SELECT id, event_id, summary, description, location, start_at, end_at, status, updated_at FROM gcal_inbox
        WHERE status = $1 AND end_at > now() - interval '1 day' ORDER BY start_at LIMIT 200`, [status]);
    return { ...s, items };
  }

  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.db.one(`SELECT id, event_id, summary, description, location, start_at, end_at, status, booking_id FROM gcal_inbox WHERE id = $1`, [id]);
    if (!r) throw notFound('Event kalender');
    return r;
  }

  /** "Periksa sekarang": the worker also pulls every few minutes. */
  @Post('pull') @HttpCode(200)
  async pull() {
    try {
      const r = await this.g.pull();
      if (!r) throw conflict('GOOGLE_NOT_CONNECTED', 'Google Calendar belum terhubung atau kalender belum dipilih');
      return r;
    } catch (e: any) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, 'GOOGLE_UNAVAILABLE', 'Google Calendar tidak dapat dihubungi. Coba lagi sebentar lagi.');
    }
  }

  @Post(':id/ignore') @HttpCode(200)
  async ignore(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() u: AuthUser) {
    const r = await this.db.one(
      `UPDATE gcal_inbox SET status = 'IGNORED', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = $1 AND status = 'PENDING' RETURNING id`, [id, u.id]);
    if (!r) throw conflict('INBOX_DECIDED', 'Event ini sudah diproses');
    return { ok: true };
  }

  @Post(':id/restore') @HttpCode(200)
  async restore(@Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.db.one(
      `UPDATE gcal_inbox SET status = 'PENDING', decided_by = NULL, decided_at = NULL, updated_at = now() WHERE id = $1 AND status = 'IGNORED' RETURNING id`, [id]);
    if (!r) throw conflict('INBOX_DECIDED', 'Event ini sudah diproses');
    return { ok: true };
  }
}

@Controller()
export class HealthController {
  constructor(private db: Db) {}

  @Public() @Get('health')
  health() {
    return { ok: true };
  }

  /** DB check for the load balancer (TD §3.5). Queue depth is Owner-only via /integrations/google (SEC-F6). */
  @Public() @Get('ready')
  async ready() {
    await this.db.one(`SELECT 1 FROM sync_outbox LIMIT 1`);
    return { ok: true };
  }
}
