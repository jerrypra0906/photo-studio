// Shared helpers for the functional and security suites. Run against a dev stack only — they create data.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENV = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n').filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
export const BASE = `${BASE_URL}/api/v1`;
export const OWNER = { email: ENV.SEED_OWNER_EMAIL, password: ENV.SEED_OWNER_PASSWORD };
export const STAFF = { email: ENV.SEED_STAFF_EMAIL, password: ENV.SEED_STAFF_PASSWORD };

/** Calls the API. A 429 RATE_LIMITED is waited out (Retry-After) unless headers.__noRetry is set. */
export async function api(token, method, path, body, headers = {}) {
  const { __noRetry, ...hdrs } = headers;
  for (;;) {
    const r = await call(token, method, path, body, hdrs);
    if (r.status !== 429 || __noRetry || r.data?.code !== 'RATE_LIMITED') return r;
    await sleep((Number(r.headers.get('retry-after')) || 5) * 1000 + 200);
  }
}

async function call(token, method, path, body, headers) {
  const isForm = body instanceof FormData;
  const t0 = performance.now();
  const r = await fetch(path.startsWith('http') ? path : BASE + path, {
    method,
    headers: { ...(isForm || body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : isForm ? body : typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  const ms = performance.now() - t0;
  const type = r.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await r.json().catch(() => null) : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, type, headers: r.headers, ms };
}

export async function login(u) {
  let r = await api(null, 'POST', '/auth/login', u);
  if (r.status === 429) { resetLoginThrottle(); r = await api(null, 'POST', '/auth/login', u); }
  if (r.status !== 200) throw new Error(`login ${u.email} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.accessToken;
}

/** Runs SQL in the db container (white-box setup only: simulating Google states, reading audit rows). */
export function sql(query) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'jes', '-d', 'jes', '-tA', '-c', query], { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** Test setup only: earlier attack cases may have tripped the per-IP login throttle. */
export const resetLoginThrottle = () => sql('DELETE FROM login_attempts');

export const wibToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
export const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal runner: each case has an id, a polarity (+ / −), a title and an async body. */
export function runner(suite) {
  const results = [];
  let area = '';
  return {
    area(name) { area = name; console.log(`\n▸ ${name}`); },
    async test(id, type, title, fn) {
      const t0 = performance.now();
      try {
        const note = await fn();
        results.push({ area, id, type, title, status: 'PASS', note: note ?? '', ms: Math.round(performance.now() - t0) });
        console.log(`  ✔ ${id} [${type}] ${title}${note ? ` — ${note}` : ''}`);
      } catch (e) {
        const status = e.skip ? 'SKIP' : 'FAIL';
        results.push({ area, id, type, title, status, note: e.message.split('\n').slice(0, 4).join(' '), ms: Math.round(performance.now() - t0) });
        console.log(`  ${status === 'SKIP' ? '○' : '✘'} ${id} [${type}] ${title} — ${e.message.split('\n')[0]}`);
      }
    },
    skip(reason) { throw Object.assign(new Error(reason), { skip: true }); },
    done() {
      const by = (s) => results.filter((r) => r.status === s).length;
      console.log(`\n${suite}: ${results.length} cases · ${by('PASS')} pass · ${by('FAIL')} fail · ${by('SKIP')} not executable`);
      mkdirSync(join(ROOT, 'docs', 'test-results'), { recursive: true });
      writeFileSync(join(ROOT, 'docs', 'test-results', `${suite}.json`), JSON.stringify({ suite, ranAt: new Date().toISOString(), baseUrl: BASE_URL, results }, null, 2));
      if (by('FAIL')) process.exitCode = 1;
      return results;
    },
  };
}
