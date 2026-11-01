import type { NextFunction, Request, Response } from 'express';
import { verifyAccess } from './http';

/**
 * TD §3.4: API 120 req/min per user (SEC-F1). Anonymous callers are keyed by IP.
 * In-memory fixed window — correct for the single API instance this stack runs; a second
 * replica would need a shared store (Postgres or Redis).
 */
const PER_USER = Number(process.env.RATE_LIMIT_PER_MIN ?? 120);
const PER_IP_ANON = Number(process.env.RATE_LIMIT_ANON_PER_MIN ?? 60);
// login attempts per IP per minute, checked in memory so a parallel burst can't race the DB throttle (SEC-F7)
const LOGIN_PER_IP = Number(process.env.RATE_LIMIT_LOGIN_PER_MIN ?? 10);
const WINDOW_MS = 60_000;
const hits = new Map<string, { n: number; reset: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
}, WINDOW_MS).unref();

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  if (/\/(health|ready)$/.test(req.path)) return next();
  const p = verifyAccess(req.headers.authorization);
  const login = req.method === 'POST' && req.path.endsWith('/auth/login');
  const [key, limit] = login ? [`login:${req.ip}`, LOGIN_PER_IP] : p ? [`u:${p.sub}`, PER_USER] : [`ip:${req.ip}`, PER_IP_ANON];
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset <= now) {
    h = { n: 0, reset: now + WINDOW_MS };
    hits.set(key, h);
  }
  h.n++;
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - h.n)));
  if (h.n > limit) {
    const retry = Math.ceil((h.reset - now) / 1000);
    res.setHeader('Retry-After', String(retry));
    res.status(429).json({ code: 'RATE_LIMITED', message: `Terlalu banyak permintaan — coba lagi dalam ${retry} detik` });
    return;
  }
  next();
}

/** Defence in depth for anything that reaches the API without nginx (SEC-E5). */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}
