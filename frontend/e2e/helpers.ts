import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, type Browser, type BrowserContext, type Page, expect } from '@playwright/test';

const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8').split('\n').filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
export const OWNER = { email: env.SEED_OWNER_EMAIL, password: env.SEED_OWNER_PASSWORD };
export const STAFF = { email: env.SEED_STAFF_EMAIL, password: env.SEED_STAFF_PASSWORD };
export const RUN = Date.now().toString(36);

/** A random far-future day nobody else books (YYYY-MM-DD), so specs never collide with real or earlier data. */
export function futureDay(offset = 0) {
  const base = new Date(Date.UTC(2090 + Math.floor(Math.random() * 9), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 20)));
  return new Date(base.getTime() + offset * 86400e3).toISOString().slice(0, 10);
}

async function withRetry(fn: () => Promise<{ status(): number; headers(): Record<string, string> }>) {
  for (;;) {
    const r = await fn();
    if (r.status() !== 429) return r;
    await new Promise((res) => setTimeout(res, (Number(r.headers()['retry-after']) || 5) * 1000 + 300));
  }
}

/** Signs a browser context in through the API (sets the httpOnly refresh cookie), retrying past rate limits. */
export async function signIn(request: APIRequestContext, user: { email: string; password: string }) {
  const r = await withRetry(() => request.post('/api/v1/auth/login', { data: user }));
  expect(r.status(), `login ${user.email}`).toBe(200);
}

/** Bearer token for direct API setup calls (rotates the context's own refresh cookie, which the page then keeps using). */
export async function token(request: APIRequestContext) {
  const r = await withRetry(() => request.post('/api/v1/auth/refresh'));
  expect(r.status()).toBe(200);
  return (await r.json()).accessToken as string;
}

export async function apiCall(request: APIRequestContext, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, data?: unknown) {
  const t = await token(request);
  const r = await withRetry(() => request.fetch(`/api/v1${path}`, { method, data, headers: { authorization: `Bearer ${t}` } }));
  return { status: r.status(), body: r.status() === 204 ? null : await r.json().catch(() => null) };
}

/** One signed-in mobile page per spec file. */
export async function session(browser: Browser, user: { email: string; password: string }, opts: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(opts);
  await signIn(context.request, user);
  const page = await context.newPage();
  if (process.env.E2E_TRACE) {
    context.on('response', (r) => { if (r.url().includes('/auth/') || (r.url().includes('/api/') && r.status() >= 400)) console.log(`AUTH ${Date.now() % 1e6} ${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`); });
    context.on('requestfailed', (r) => { if (r.url().includes('/auth/')) console.log(`AUTH-FAILED ${Date.now() % 1e6} ${new URL(r.url()).pathname} ${r.failure()?.errorText}`); });
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log(`NAV ${Date.now() % 1e6} ${new URL(f.url()).pathname}`); });
  }
  return { context, page };
}

/** No horizontal scrolling at the current viewport (PRD §2.3). */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(1);
}

