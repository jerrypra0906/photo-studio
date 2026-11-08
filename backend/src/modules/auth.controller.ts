import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { loginSchema, passwordChangeInput, profileInput } from '@jes/shared';
import { AppError, AuthUser, Body$, CurrentUser, Public, badRequest, forgetUser, signAccess } from '../common/http';
import { randomToken, sha256 } from '../common/crypto';
import { config } from '../config';
import { Db } from '../db';
import { audit } from './masters.controller';

const COOKIE = 'jes_rt';
const REFRESH_DAYS = 30;

@Controller('auth')
export class AuthController {
  constructor(private db: Db) {}

  /** US-01: 5 failures in 10 min (per IP + email) → locked 15 min; message never says which field was wrong. */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(Body$(loginSchema)) body: { email: string; password: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const email = body.email.toLowerCase();
    const key = `${req.ip}|${email}`;
    // SEC-A9: password spraying — at most 20 failed logins per IP per 10 min, whatever the account
    const perIp = await this.db.one(
      `SELECT count(*)::int AS n FROM login_attempts WHERE split_part(key, '|', 1) = $1 AND at > now() - interval '10 minutes'`, [req.ip]);
    if (perIp.n >= 20) throw new AppError(429, 'LOCKED', 'Terlalu banyak percobaan masuk dari perangkat ini. Coba lagi dalam 10 menit');
    // SEC-A8: an account is locked after 10 failures in 15 min from any mix of IPs
    const perAccount = await this.db.one(
      `SELECT count(*)::int AS n, max(at) AS last FROM login_attempts WHERE split_part(key, '|', 2) = $1 AND at > now() - interval '15 minutes'`, [email]);
    if (perAccount.n >= 10) {
      const until = new Date(new Date(perAccount.last).getTime() + 15 * 60_000);
      throw new AppError(429, 'LOCKED', `Terlalu banyak percobaan. Coba lagi setelah ${until.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })} WIB`, { retryAt: until });
    }
    const fails = await this.db.many<{ at: Date }>(
      `SELECT at FROM login_attempts WHERE key = $1 AND at > now() - interval '25 minutes' ORDER BY at DESC LIMIT 5`, [key]);
    if (fails.length === 5 && fails[0].at.getTime() - fails[4].at.getTime() <= 10 * 60_000) {
      const until = new Date(fails[0].at.getTime() + 15 * 60_000);
      if (until > new Date()) {
        throw new AppError(429, 'LOCKED', `Terlalu banyak percobaan. Coba lagi setelah ${until.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })} WIB`, { retryAt: until });
      }
    }
    const u = await this.db.one(`SELECT id, name, email, role, password_hash FROM users WHERE email = $1 AND active AND deleted_at IS NULL`, [body.email]);
    const ok = u ? await argon2.verify(u.passwordHash, body.password) : (await argon2.hash('x'), false);
    if (!u || !ok) {
      await this.db.many(`INSERT INTO login_attempts(key) VALUES ($1)`, [key]);
      throw new AppError(401, 'BAD_CREDENTIALS', 'Email atau kata sandi salah');
    }
    await this.db.many(`DELETE FROM login_attempts WHERE key = $1`, [key]);
    await this.db.many(`UPDATE users SET last_login_at = now() WHERE id = $1`, [u.id]);
    const user: AuthUser = { id: u.id, name: u.name, email: u.email, role: u.role };
    await this.issueRefresh(res, user.id, randomUUID());
    return { accessToken: signAccess(user), user };
  }

  /** Rotating refresh token; reuse of a rotated token revokes the whole family. */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = req.cookies?.[COOKIE];
    if (!raw) throw new AppError(401, 'UNAUTHENTICATED', 'Silakan masuk');
    const t = await this.db.one(
      `SELECT rt.id, rt.family_id, rt.revoked_at, rt.rotated_at, rt.expires_at, u.id AS user_id, u.name, u.email, u.role, u.active AND u.deleted_at IS NULL AS active
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = $1`, [sha256(raw)]);
    if (!t || !t.active || t.expiresAt < new Date()) {
      res.clearCookie(COOKIE, { path: '/api/v1/auth' });
      throw new AppError(401, 'UNAUTHENTICATED', 'Sesi berakhir, silakan masuk kembali');
    }
    // a token rotated seconds ago (second tab, retried request) is tolerated; older reuse means theft → revoke the family
    const reused = t.rotatedAt && Date.now() - new Date(t.rotatedAt).getTime() > 30_000;
    if (t.revokedAt || reused) {
      await this.db.many(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [t.familyId]);
      res.clearCookie(COOKIE, { path: '/api/v1/auth' });
      throw new AppError(401, 'UNAUTHENTICATED', 'Sesi berakhir, silakan masuk kembali');
    }
    await this.db.many(`UPDATE refresh_tokens SET rotated_at = coalesce(rotated_at, now()) WHERE id = $1`, [t.id]);
    const user: AuthUser = { id: t.userId, name: t.name, email: t.email, role: t.role };
    await this.issueRefresh(res, user.id, t.familyId);
    return { accessToken: signAccess(user), user };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = req.cookies?.[COOKIE];
    if (raw) {
      await this.db.many(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
        [sha256(raw)]);
    }
    res.clearCookie(COOKIE, { path: '/api/v1/auth' });
  }

  /** Self-service: change own display name (any role; role and email stay Owner-managed). */
  @Patch('me')
  async updateMe(@Body(Body$(profileInput)) b: { name: string }, @CurrentUser() me: AuthUser, @Res({ passthrough: true }) res: Response) {
    const u = await this.db.tx(async (c) => {
      const r = await this.db.one(`UPDATE users SET name = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id, name, email, role`, [me.id, b.name], c);
      await audit(c, me, 'PROFILE_UPDATE', 'user', me.id, { name: b.name });
      return r;
    });
    const user: AuthUser = { id: u.id, name: u.name, email: u.email, role: u.role };
    res.setHeader('Cache-Control', 'no-store');
    return { accessToken: signAccess(user), user };
  }

  /**
   * Self-service password change: needs the current password (5 wrong tries / 10 min → locked),
   * ends every other session and returns a fresh one for this device.
   */
  @Post('password')
  @HttpCode(200)
  async changePassword(@Body(Body$(passwordChangeInput)) b: { currentPassword: string; newPassword: string }, @CurrentUser() me: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const key = `${req.ip}|pwchange:${me.id}`;
    const fails = await this.db.one(`SELECT count(*)::int AS n FROM login_attempts WHERE key = $1 AND at > now() - interval '10 minutes'`, [key]);
    if (fails.n >= 5) throw new AppError(429, 'LOCKED', 'Terlalu banyak percobaan. Coba lagi dalam 10 menit');
    const u = await this.db.one(`SELECT id, name, email, role, password_hash FROM users WHERE id = $1 AND active AND deleted_at IS NULL`, [me.id]);
    if (!u || !(await argon2.verify(u.passwordHash, b.currentPassword))) {
      await this.db.many(`INSERT INTO login_attempts(key) VALUES ($1)`, [key]);
      throw badRequest('Kata sandi saat ini salah', { currentPassword: 'Kata sandi saat ini salah' });
    }
    if (b.newPassword.toLowerCase() === u.email) throw badRequest('Kata sandi tidak boleh sama dengan email', { newPassword: 'Kata sandi tidak boleh sama dengan email' });
    const hash = await argon2.hash(b.newPassword, { type: argon2.argon2id });
    await this.db.tx(async (c) => {
      await c.query(`UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1`, [me.id, hash]);
      await c.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [me.id]);
      await c.query(`DELETE FROM login_attempts WHERE key = $1`, [key]);
      await audit(c, me, 'PASSWORD_CHANGE', 'user', me.id);
    });
    forgetUser(me.id);
    const user: AuthUser = { id: u.id, name: u.name, email: u.email, role: u.role };
    await this.issueRefresh(res, user.id, randomUUID());
    return { accessToken: signAccess(user), user };
  }

  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return u;
  }

  private async issueRefresh(res: Response, userId: string, familyId: string) {
    const raw = randomToken();
    await this.db.many(
      `INSERT INTO refresh_tokens(user_id, family_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '${REFRESH_DAYS} days')`,
      [userId, familyId, sha256(raw)]);
    res.cookie(COOKIE, raw, {
      httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/api/v1/auth', maxAge: REFRESH_DAYS * 86400_000,
    });
  }
}
