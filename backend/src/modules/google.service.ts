import { Injectable } from '@nestjs/common';
import { auth, calendar, calendar_v3 } from '@googleapis/calendar';
import jwt from 'jsonwebtoken';
import { durationLabel, formatRp, wibDate, wibTime, displayPhone } from '@jes/shared';
import { AppError } from '../common/http';
import { decrypt, encrypt } from '../common/crypto';
import { config, googleConfigured } from '../config';
import { Db } from '../db';

const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
/** PRD 5.2.7: 30 s, 2 min, 10 min, 1 h, then Failed */
const BACKOFF_S = [30, 120, 600, 3600];

/** Google → app pull window: from yesterday to this many days ahead. */
const PULL_DAYS = 180;

const PAY_LABEL = (total: number, paid: number) => (paid >= total ? 'Lunas' : paid > 0 ? 'DP' : 'Belum bayar');
const wibIso = (d: Date) => `${wibDate(d)}T${wibTime(d)}:00+07:00`;

@Injectable()
export class GoogleService {
  constructor(private db: Db) {}

  private oauth() {
    if (!googleConfigured()) throw new AppError(503, 'GOOGLE_NOT_CONFIGURED', 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET belum diatur di server');
    return new auth.OAuth2(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
  }

  private async client() {
    const s = await this.db.one(`SELECT gcal_refresh_token, gcal_calendar_id FROM settings WHERE id = 1`);
    if (!s.gcalRefreshToken) throw Object.assign(new Error('not connected'), { notConnected: true });
    const o = this.oauth();
    o.setCredentials({ refresh_token: decrypt(s.gcalRefreshToken) });
    return { cal: calendar({ version: 'v3', auth: o }), calendarId: s.gcalCalendarId as string | null };
  }

  async status() {
    const s = await this.db.one(`SELECT gcal_status, gcal_account_email, gcal_calendar_id, gcal_calendar_name, gcal_cancel_mode, gcal_mark_completed, gcal_pulled_at, gcal_pull_error FROM settings WHERE id = 1`);
    const q = await this.db.one(
      `SELECT count(*) FILTER (WHERE done_at IS NULL AND failed_at IS NULL)::int AS pending,
              count(*) FILTER (WHERE failed_at IS NOT NULL AND failed_at > now() - interval '7 days')::int AS failed
         FROM sync_outbox`);
    return { configured: googleConfigured(), ...s, queue: q };
  }

  /** L2-5.1.2: state is a short-lived signed token naming the Owner who started the flow. */
  authUrl(userId: string) {
    const state = jwt.sign({ sub: userId, p: 'gcal' }, config.jwtSecret, { expiresIn: '10m', audience: 'jes-gcal-state', algorithm: 'HS256' });
    return this.oauth().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state, include_granted_scopes: true });
  }

  async callback(code: string | undefined, state: string | undefined, error?: string) {
    try {
      const p = jwt.verify(state ?? '', config.jwtSecret, { audience: 'jes-gcal-state', algorithms: ['HS256'] }) as jwt.JwtPayload;
      if (p.p !== 'gcal') throw new Error('bad state');
    } catch {
      return 'error=state';
    }
    if (error || !code) return 'error=denied'; // US-28.4: owner declined → stays Not connected
    const o = this.oauth();
    const { tokens } = await o.getToken(code);
    if (!tokens.refresh_token) return 'error=no_refresh_token';
    let email: string | null = null;
    if (tokens.id_token) {
      const t = await o.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
      email = t.getPayload()?.email ?? null;
    }
    await this.db.many(
      `UPDATE settings SET gcal_refresh_token = $1, gcal_account_email = $2, gcal_status = 'CONNECTED', updated_at = now() WHERE id = 1`,
      [encrypt(tokens.refresh_token), email]);
    // reconnect: release jobs parked while the token was revoked
    await this.db.many(`UPDATE sync_outbox SET next_run_at = now() WHERE done_at IS NULL AND failed_at IS NULL`);
    return 'connected=1';
  }

  /** L2-5.1.3: only calendars the account can write to. */
  async calendars() {
    const { cal } = await this.client();
    const r = await cal.calendarList.list({ minAccessRole: 'writer', maxResults: 100 });
    return (r.data.items ?? []).map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary, timeZone: c.timeZone, primary: !!c.primary }));
  }

  /** L2-5.1.4–5: select target; warn when its zone isn't WIB (events still carry Asia/Jakarta, BR-17). */
  async selectCalendar(calendarId: string, pushExisting: boolean) {
    const cals = await this.calendars();
    const c = cals.find((x) => x.id === calendarId);
    if (!c) throw new AppError(400, 'VALIDATION', 'Kalender tidak ditemukan atau tidak bisa ditulis');
    await this.db.many(`UPDATE settings SET gcal_calendar_id = $1, gcal_calendar_name = $2, updated_at = now() WHERE id = 1`, [c.id, c.name]);
    // waiting events came from the previous calendar
    await this.db.many(`DELETE FROM gcal_inbox WHERE status = 'PENDING'`);
    const pushed = pushExisting ? await this.resyncAll() : 0;
    return { calendar: c, timeZoneWarning: c.timeZone !== 'Asia/Jakarta' ? `Zona waktu kalender ${c.timeZone}; acara tetap dibuat dalam WIB.` : null, pushed };
  }

  /** L2-5.2.9: rebuild every future event from the app. */
  async resyncAll() {
    const rows = await this.db.many(`SELECT id FROM bookings WHERE status <> 'CANCELLED' AND end_at >= now() - interval '1 day'`);
    await this.db.tx(async (c) => {
      for (const r of rows) {
        await c.query(`UPDATE sync_outbox SET done_at = now(), last_error = 'superseded' WHERE booking_id = $1 AND done_at IS NULL AND failed_at IS NULL`, [r.id]);
        await c.query(`INSERT INTO sync_outbox (booking_id, op) VALUES ($1, 'UPSERT')`, [r.id]);
        await c.query(`UPDATE bookings SET gcal_sync_status = 'PENDING' WHERE id = $1`, [r.id]);
      }
    });
    return rows.length;
  }

  async disconnect() {
    const s = await this.db.one(`SELECT gcal_refresh_token FROM settings WHERE id = 1`);
    if (s.gcalRefreshToken && googleConfigured()) {
      await this.oauth().revokeToken(decrypt(s.gcalRefreshToken)).catch(() => undefined);
    }
    await this.db.many(
      `UPDATE settings SET gcal_refresh_token = NULL, gcal_account_email = NULL, gcal_calendar_id = NULL, gcal_calendar_name = NULL,
              gcal_status = 'NOT_CONNECTED', updated_at = now() WHERE id = 1`);
    await this.db.many(`UPDATE sync_outbox SET done_at = now(), last_error = 'disconnected' WHERE done_at IS NULL AND failed_at IS NULL`);
    await this.db.many(`UPDATE bookings SET gcal_sync_status = 'NONE' WHERE gcal_sync_status = 'PENDING'`);
    await this.db.many(`DELETE FROM gcal_inbox WHERE status = 'PENDING'`);
  }

  /**
   * Google → app: copy events made directly in Google Calendar into the inbox (read-only on Google's side).
   * Skips events the app created or already linked, all-day events (reminders, birthdays) and cancelled ones.
   * A waiting item follows changes in Google and disappears when its event is deleted.
   */
  async pull(): Promise<{ added: number; pending: number } | null> {
    const st = await this.db.one(`SELECT gcal_status, gcal_calendar_id FROM settings WHERE id = 1`);
    if (st.gcalStatus !== 'CONNECTED' || !st.gcalCalendarId || !googleConfigured()) return null;
    const { cal, calendarId } = await this.client();
    const timeMin = new Date(Date.now() - 86400_000);
    const timeMax = new Date(Date.now() + PULL_DAYS * 86400_000);
    const items: calendar_v3.Schema$Event[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const r = await cal.events.list({ calendarId: calendarId!, timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
          singleEvents: true, showDeleted: false, maxResults: 250, pageToken });
        items.push(...(r.data.items ?? []));
        pageToken = r.data.nextPageToken ?? undefined;
      } while (pageToken && items.length < 2500);
    } catch (e: any) {
      const msg = String(e?.response?.data?.error_description ?? e?.message ?? e).slice(0, 300);
      if (/invalid_grant|Token has been expired or revoked/i.test(msg)) await this.db.many(`UPDATE settings SET gcal_status = 'RECONNECT_NEEDED' WHERE id = 1`);
      await this.db.many(`UPDATE settings SET gcal_pull_error = $1 WHERE id = 1`, [msg]);
      throw e;
    }
    const linked = new Set((await this.db.many(`SELECT gcal_event_id FROM bookings WHERE gcal_event_id IS NOT NULL`)).map((r) => r.gcalEventId));
    const seen: string[] = [];
    let added = 0;
    for (const e of items) {
      if (!e.id || e.status === 'cancelled' || !e.start?.dateTime || !e.end?.dateTime) continue;
      if (e.extendedProperties?.private?.jesApp === 'jes-booking' || linked.has(e.id)) continue;
      if (e.eventType && e.eventType !== 'default') continue; // focus time, out of office, birthdays from contacts
      seen.push(e.id);
      const r = await this.db.one(
        `INSERT INTO gcal_inbox (event_id, summary, description, location, start_at, end_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id) DO UPDATE SET summary = EXCLUDED.summary, description = EXCLUDED.description, location = EXCLUDED.location,
           start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at, updated_at = now()
           WHERE gcal_inbox.status = 'PENDING' AND (gcal_inbox.summary, gcal_inbox.description, gcal_inbox.start_at, gcal_inbox.end_at)
                 IS DISTINCT FROM (EXCLUDED.summary, EXCLUDED.description, EXCLUDED.start_at, EXCLUDED.end_at)
         RETURNING (xmax = 0) AS inserted`,
        [e.id, (e.summary ?? '').slice(0, 300), e.description?.slice(0, 4000) ?? null, e.location?.slice(0, 300) ?? null, e.start.dateTime, e.end.dateTime]);
      if (r?.inserted) added++;
    }
    // deleted in Google (or turned all-day / linked) → no longer waiting
    await this.db.many(`DELETE FROM gcal_inbox WHERE status = 'PENDING' AND NOT (event_id = ANY($1::text[]))`, [seen]);
    await this.db.many(`UPDATE settings SET gcal_pulled_at = now(), gcal_pull_error = NULL WHERE id = 1`);
    const pending = (await this.db.one(`SELECT count(*)::int AS n FROM gcal_inbox WHERE status = 'PENDING' AND end_at > now() - interval '1 day'`)).n;
    if (added) console.log(`gcal pull: ${added} new event(s) in the inbox`);
    return { added, pending };
  }

  async test() {
    const { cal, calendarId } = await this.client();
    if (!calendarId) throw new AppError(400, 'VALIDATION', 'Pilih kalender dulu');
    try {
      // only calls the granted scopes cover: calendarList (calendarlist.readonly) and events (calendar.events).
      // calendars.get needs the broader calendar.readonly scope and fails with "insufficient authentication scopes".
      const r = await cal.calendarList.get({ calendarId });
      await cal.events.list({ calendarId, maxResults: 1, timeMin: new Date().toISOString() });
      return { ok: true, calendar: r.data.summaryOverride ?? r.data.summary, timeZone: r.data.timeZone };
    } catch (e: any) {
      const status = e?.response?.status ?? e?.status;
      if (status === 401 || e?.response?.data?.error === 'invalid_grant') {
        throw new AppError(409, 'GOOGLE_RECONNECT', 'Akses Google kedaluwarsa atau dicabut. Hubungkan ulang Google Calendar.');
      }
      if (status === 403 || status === 404) {
        throw new AppError(409, 'GOOGLE_NO_ACCESS', 'Akun Google tidak punya akses tulis ke kalender ini. Pilih kalender lain atau hubungkan ulang.');
      }
      throw new AppError(502, 'GOOGLE_UNAVAILABLE', 'Google Calendar tidak dapat dihubungi. Coba lagi sebentar lagi.');
    }
  }

  // ---------- worker side ----------

  private async eventBody(bookingId: string): Promise<{ b: any; body: calendar_v3.Schema$Event }> {
    const b = await this.db.one(`SELECT b.*, t.color_id FROM bookings b JOIN booking_types t ON t.id = b.type_id WHERE b.id = $1`, [bookingId]);
    const addons = await this.db.many(`SELECT name_snap, qty, line_total FROM booking_addons WHERE booking_id = $1`, [bookingId]);
    const s = await this.db.one(`SELECT gcal_mark_completed FROM settings WHERE id = 1`);
    // PRD 5.2.3: "<Client> <type keyword>", e.g. "Lilin group" / "dea sewa"
    let title = `${b.clientNameSnap} ${b.typeKeywordSnap ?? ''}`.trim();
    if (b.status === 'COMPLETED' && s.gcalMarkCompleted) title = `✓ ${title} — ${PAY_LABEL(b.total, b.paidAmount)}`;
    const description = [
      `No. booking: ${b.bookingNo}`,
      `${b.typeNameSnap} · ${durationLabel(b.durationMin)}`,
      b.photographerNameSnap ? `Fotografer: ${b.photographerNameSnap}` : null,
      addons.length ? `Add-on: ${addons.map((a) => `${a.nameSnap}${a.qty > 1 ? ` ×${a.qty}` : ''}`).join(', ')}` : null,
      `Total: ${formatRp(b.total)}`,
      `DP/dibayar: ${formatRp(b.paidAmount)} · Sisa: ${formatRp(b.total - b.paidAmount)}`,
      b.clientPhoneSnap ? `Telp: ${displayPhone(b.clientPhoneSnap)}` : null,
      b.notes ? `Catatan: ${b.notes}` : null,
      `${config.appUrl}/bookings/${b.id}`,
    ].filter(Boolean).join('\n');
    return {
      b,
      body: {
        summary: title,
        description,
        start: { dateTime: wibIso(b.startAt), timeZone: 'Asia/Jakarta' },
        end: { dateTime: wibIso(b.endAt), timeZone: 'Asia/Jakarta' },
        colorId: b.colorId ?? undefined,
        extendedProperties: { private: { jesBooking: b.id, jesApp: 'jes-booking' } },
      },
    };
  }

  /** One outbox job. Returns normally on success; throws for retryable failures. */
  async process(job: { id: number; bookingId: string; op: 'UPSERT' | 'DELETE' }) {
    const { cal, calendarId } = await this.client();
    if (!calendarId) throw new Error('no calendar selected');
    const { b, body } = await this.eventBody(job.bookingId);
    const op = b.status === 'CANCELLED' ? 'DELETE' : job.op;

    if (op === 'DELETE') {
      const mode = (await this.db.one(`SELECT gcal_cancel_mode FROM settings WHERE id = 1`)).gcalCancelMode;
      if (b.gcalEventId) {
        try {
          if (mode === 'MARK') await cal.events.patch({ calendarId, eventId: b.gcalEventId, requestBody: { summary: `CANCELLED – ${body.summary}`, transparency: 'transparent' } });
          else await cal.events.delete({ calendarId, eventId: b.gcalEventId });
        } catch (e: any) {
          if (![404, 410].includes(e?.code)) throw e;
        }
      }
      await this.db.many(
        `UPDATE bookings SET gcal_sync_status = 'SYNCED', gcal_synced_at = now(), gcal_last_error = NULL,
                gcal_event_id = CASE WHEN $2 = 'DELETE' THEN NULL ELSE gcal_event_id END WHERE id = $1`, [b.id, mode]);
      return;
    }

    let eventId = b.gcalEventId as string | null;
    if (eventId) {
      try {
        const r = await cal.events.update({ calendarId, eventId, requestBody: { ...body, status: 'confirmed' } });
        eventId = r.data.id!;
      } catch (e: any) {
        // US-29.8: deleted in Google → recreate
        if (![404, 410].includes(e?.code)) throw e;
        eventId = null;
      }
    }
    if (!eventId) eventId = (await cal.events.insert({ calendarId, requestBody: body })).data.id!;
    await this.db.many(
      `UPDATE bookings SET gcal_event_id = $2, gcal_sync_status = 'SYNCED', gcal_synced_at = now(), gcal_last_error = NULL WHERE id = $1`, [b.id, eventId]);
  }

  /** Claims due jobs with SKIP LOCKED and runs them; safe with several workers. */
  async drain() {
    for (;;) {
      const job = await this.db.tx(async (c) => {
        const j = await this.db.one(
          `SELECT id, booking_id, op, attempts FROM sync_outbox
            WHERE done_at IS NULL AND failed_at IS NULL AND next_run_at <= now()
            ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`, [], c);
        if (!j) return null;
        // lease the job so a crash re-runs it later rather than never
        await c.query(`UPDATE sync_outbox SET next_run_at = now() + interval '2 minutes' WHERE id = $1`, [j.id]);
        return j;
      });
      if (!job) return;
      try {
        await this.process(job);
        await this.db.many(`UPDATE sync_outbox SET done_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [job.id]);
      } catch (e: any) {
        const msg = String(e?.response?.data?.error_description ?? e?.message ?? e).slice(0, 500);
        if (e?.notConnected) {
          await this.db.many(`UPDATE sync_outbox SET done_at = now(), last_error = 'not connected' WHERE id = $1`, [job.id]);
          await this.db.many(`UPDATE bookings SET gcal_sync_status = 'NONE' WHERE id = $1 AND gcal_sync_status = 'PENDING'`, [job.bookingId]);
          continue;
        }
        if (/invalid_grant|unauthorized_client|Token has been expired or revoked/i.test(msg)) {
          // US-28.5: Reconnect needed; jobs stay Pending until reconnected
          await this.db.many(`UPDATE settings SET gcal_status = 'RECONNECT_NEEDED' WHERE id = 1`);
          await this.db.many(`UPDATE sync_outbox SET next_run_at = now() + interval '1 hour', last_error = $2 WHERE id = $1`, [job.id, msg]);
          continue;
        }
        const attempts = job.attempts + 1;
        if (attempts > BACKOFF_S.length) {
          await this.db.many(`UPDATE sync_outbox SET attempts = $2, failed_at = now(), last_error = $3 WHERE id = $1`, [job.id, attempts, msg]);
          await this.db.many(`UPDATE bookings SET gcal_sync_status = 'FAILED', gcal_last_error = $2 WHERE id = $1`, [job.bookingId, msg]);
        } else {
          await this.db.many(
            `UPDATE sync_outbox SET attempts = $2, last_error = $3, next_run_at = now() + make_interval(secs => $4) WHERE id = $1`,
            [job.id, attempts, msg, BACKOFF_S[attempts - 1]]);
          await this.db.many(`UPDATE bookings SET gcal_last_error = $2 WHERE id = $1`, [job.bookingId, msg]);
        }
        console.warn(`gcal job ${job.id} failed (attempt ${attempts}): ${msg}`);
      }
    }
  }
}
