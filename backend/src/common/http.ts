import {
  ArgumentsHost, CanActivate, Catch, ExceptionFilter, ExecutionContext, HttpException, HttpStatus,
  Injectable, PipeTransform, SetMetadata, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ZodSchema } from 'zod';
import type { Role } from '@jes/shared';
import { config } from '../config';

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
  constructor(private schema: ZodSchema) {}
  transform(value: unknown) {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] ??= i.message;
    throw badRequest(Object.values(fields)[0] ?? 'Data tidak valid', fields);
  }
}

export const Body$ = (schema: ZodSchema) => new ZodPipe(schema);

const PUBLIC = 'isPublic';
const ROLES_KEY = 'roles';
export const Public = () => SetMetadata(PUBLIC, true);
export const OwnerOnly = () => SetMetadata(ROLES_KEY, ['OWNER']);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

export function signAccess(u: AuthUser): string {
  return jwt.sign({ sub: u.id, role: u.role, name: u.name, email: u.email }, config.jwtSecret, { expiresIn: '15m' });
}

/** JWT access guard + role guard on every endpoint (TD §3.4). Owner-only routes are checked server-side. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHENTICATED', 'Silakan masuk kembali');
    try {
      const p = jwt.verify(h.slice(7), config.jwtSecret) as jwt.JwtPayload;
      req.user = { id: p.sub!, role: p.role, name: p.name, email: p.email };
    } catch {
      throw new AppError(401, 'UNAUTHENTICATED', 'Sesi berakhir, silakan masuk kembali');
    }
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
      res.status(409).json({ code: 'DUPLICATE', message: 'Nama sudah ada' });
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
