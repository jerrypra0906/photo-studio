import {
  ArgumentsHost, CanActivate, Catch, ExceptionFilter, ExecutionContext, HttpException, HttpStatus,
  Injectable, PipeTransform, SetMetadata, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { ZodType } from 'zod';
import type { Role } from '@jes/shared';
import { config } from '../config';
import { Db } from '../db';

export interface AuthUser { id: string; role: Role; name: string; email: string }

/** Error body: { code, message, fields?, details? } */
export class AppError extends HttpException {
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super({ code, message, ...extra }, status);
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) => new AppError(400, 'VALIDATION', message, fields ? { fields } : {});
export const notFound = (what = 'Data') => new AppError(404, 'NOT_FOUND', `${what} tidak ditemukan`);
export const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new AppError(409, code, message, extra);
export const forbidden = () => new AppError(403, 'FORBIDDEN', 'Anda tidak memiliki akses');

export class ZodPipe implements PipeTransform {
  constructor(private schema: ZodType) {}
  transform(value: unknown) {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] ??= i.message;
    throw badRequest(Object.values(fields)[0] ?? 'Data tidak valid', fields);
  }
}

export const Body$ = (schema: ZodType) => new ZodPipe(schema);

const PUBLIC = 'isPublic';
const ROLES_KEY = 'roles';
export const Public = () => SetMetadata(PUBLIC, true);
export const OwnerOnly = () => SetMetadata(ROLES_KEY, ['OWNER']);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

// typ/aud separate access tokens from other JWTs signed with the same secret, e.g. the OAuth state (SEC-A6)
const ACCESS = { typ: 'access', aud: 'jes-api' } as const;

export function signAccess(u: AuthUser): string {
  return jwt.sign({ sub: u.id, role: u.role, name: u.name, email: u.email, typ: ACCESS.typ }, config.jwtSecret, { expiresIn: '15m', audience: ACCESS.aud, algorithm: 'HS256' });
}

/** Verified access-token payload, or null. Also used by the rate limiter to key requests per user. */
export function verifyAccess(header: string | undefined): jwt.JwtPayload | null {
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const p = jwt.verify(header.slice(7), config.jwtSecret, { audience: ACCESS.aud, algorithms: ['HS256'] }) as jwt.JwtPayload;
    return p.typ === ACCESS.typ && p.sub && (p.role === 'OWNER' || p.role === 'STAFF') ? p : null;
  } catch {
    return null;
  }
}

/** Deactivation and role changes take effect within seconds, not at token expiry (SEC-A13). */
const userCache = new Map<string, { active: boolean; role: Role; at: number }>();
export const forgetUser = (id: string) => userCache.delete(id);

/** JWT access guard + role guard on every endpoint (TD §3.4). Owner-only routes are checked server-side. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private db: Db) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const p = verifyAccess(req.headers.authorization);
    if (!p) throw new AppError(401, 'UNAUTHENTICATED', 'Sesi berakhir, silakan masuk kembali');
    let u = userCache.get(p.sub!);
    if (!u || Date.now() - u.at > 5000) {
      const row = await this.db.one(`SELECT active AND deleted_at IS NULL AS active, role FROM users WHERE id = $1`, [p.sub]);
      u = { active: !!row?.active, role: row?.role, at: Date.now() };
      userCache.set(p.sub!, u);
    }
    if (!u.active || u.role !== p.role) throw new AppError(401, 'UNAUTHENTICATED', 'Sesi berakhir, silakan masuk kembali');
    req.user = { id: p.sub!, role: p.role, name: p.name, email: p.email };
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    if (roles && !roles.includes(req.user.role)) throw forbidden();
    return true;
  }
}

/** Maps Postgres errors to API errors; everything else → 500 without leaking internals. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(err: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof HttpException) {
      const body = err.getResponse();
      const status = err.getStatus();
      res.status(status).json(typeof body === 'string' ? { code: 'ERROR', message: body } : { code: (body as any).code ?? HttpStatus[status], ...(body as object) });
      return;
    }
    if (err?.code === '23P01' && err?.constraint === 'bookings_no_overlap') {
      res.status(409).json({ code: 'SLOT_TAKEN', message: 'Slot ini baru saja terisi' });
      return;
    }
    if (err?.code === 'P0001' && String(err.message).startsWith('MONTH_CLOSED:')) {
      const m = String(err.message).split(':')[1];
      res.status(409).json({ code: 'MONTH_CLOSED', message: `Bulan ${m} sudah ditutup — buka kembali untuk mengubah`, month: m });
      return;
    }
    if (err?.code === '23505') {
      const email = err?.constraint === 'users_email_live';
      res.status(409).json({ code: 'DUPLICATE', message: email ? 'Email sudah terdaftar' : 'Nama sudah ada', ...(email ? { fields: { email: 'Email sudah terdaftar' } } : {}) });
      return;
    }
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      res.status(413).json({ code: 'TOO_LARGE', message: 'Data terlalu besar' });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ code: 'VALIDATION', message: 'JSON tidak valid' });
      return;
    }
    console.error(err);
    res.status(500).json({ code: 'INTERNAL', message: 'Terjadi kesalahan pada server' });
  }
}
