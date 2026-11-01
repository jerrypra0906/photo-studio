import { Body, Controller, Get, HttpCode, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, Body$, CurrentUser, OwnerOnly, Public } from '../common/http';
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

@Controller()
export class HealthController {
  constructor(private db: Db) {}

  @Public() @Get('health')
  health() {
    return { ok: true };
  }

  /** DB + queue check (TD §3.5) */
  @Public() @Get('ready')
  async ready() {
    const q = await this.db.one(`SELECT count(*)::int AS backlog FROM sync_outbox WHERE done_at IS NULL AND failed_at IS NULL`);
    return { ok: true, db: true, queueBacklog: q.backlog };
  }
}
