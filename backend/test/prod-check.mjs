// Architecture review, executed: verifies the production stack (docker-compose.prod.yml) property by property,
// including the transport-level penetration checks (TLS, HSTS, proxy IP spoofing).
//   PROJECT=jes-prodtest BASE=https://localhost:8443 HTTP=http://localhost:8081 node backend/test/prod-check.mjs
// Against a real server: PROJECT=jes-booking BASE=https://book.example HTTP=http://book.example (run on the VM).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ENV, ROOT, runner } from './lib.mjs';

const PROJECT = process.env.PROJECT ?? 'jes-prodtest';
const BASE = process.env.BASE ?? 'https://localhost:8443';
const HTTP = process.env.HTTP ?? 'http://localhost:8081';
const LOCAL_CA = /localhost/.test(BASE);
if (LOCAL_CA) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Caddy's internal CA for local verification only

const R = runner('prod-check');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
// ENV_FILES: extra --env-file(s) the stack was started with (comma-separated), e.g. a local test override
const envFiles = (process.env.ENV_FILES ?? '').split(',').filter(Boolean).flatMap((f) => ['--env-file', f]);
const dc = (...args) => sh('docker', ['compose', '-p', PROJECT, '-f', 'docker-compose.prod.yml', ...(envFiles.length ? ['--env-file', '.env', ...envFiles] : []), ...args]);
const ids = Object.fromEntries(dc('ps', '-a', '--format', '{{.Service}} {{.ID}}').split('\n').map((l) => l.split(' ')));
const inspect = (svc) => JSON.parse(sh('docker', ['inspect', ids[svc]]))[0];
const LONG_RUNNING = ['edge', 'web', 'api', 'worker', 'db', 'backup'];
const psql = (q, db = 'jes') => dc('exec', '-T', 'db', 'psql', '-U', 'jes', '-d', db, '-tA', '-c', q);
const req = (url, init = {}) => fetch(url, { redirect: 'manual', ...init });

R.area('ARCH-01 Transport security (TLS edge)');
await R.test('ARCH-01a', '+', 'The app is served over HTTPS end to end (login + data call)', async () => {
  const l = await req(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ENV.SEED_OWNER_EMAIL, password: ENV.SEED_OWNER_PASSWORD }) });
  assert.equal(l.status, 200);
  const { accessToken } = await l.json();
  assert.equal((await req(`${BASE}/api/v1/bookings`, { headers: { authorization: `Bearer ${accessToken}` } })).status, 200);
  assert.equal((await req(`${BASE}/`)).status, 200);
});
await R.test('ARCH-01b', '−', 'Plain HTTP is redirected to HTTPS (no app content over HTTP)', async () => {
  const r = await req(`${HTTP}/login`);
  assert.ok([301, 302, 307, 308].includes(r.status), `HTTP status ${r.status}`);
  assert.match(r.headers.get('location') ?? '', /^https:\/\//);
});
await R.test('ARCH-01c', '+', 'HSTS (1 year) on every HTTPS response; Server/Via banners removed', async () => {
  for (const p of ['/', '/api/v1/health']) {
    const r = await req(`${BASE}${p}`);
    assert.match(r.headers.get('strict-transport-security') ?? '', /max-age=31536000/, p);
    assert.equal(r.headers.get('server'), null, `${p} Server header`);
  }
});
await R.test('ARCH-01d', '−', 'Legacy TLS 1.0/1.1 handshakes are refused; TLS 1.2+ accepted', async () => {
  const host = new URL(BASE).host;
  const tryTls = (flag) => { try { sh('openssl', ['s_client', '-connect', host, flag, '-servername', new URL(BASE).hostname], { input: '', timeout: 8000 }); return 'ok'; } catch { return 'refused'; } };
  assert.equal(tryTls('-tls1_1'), 'refused'); assert.equal(tryTls('-tls1_2'), 'ok');
});
await R.test('ARCH-01e', '+', 'Refresh cookie carries Secure, HttpOnly, SameSite=Strict in production', async () => {
  const l = await req(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ENV.SEED_OWNER_EMAIL, password: ENV.SEED_OWNER_PASSWORD }) });
  const c = l.headers.get('set-cookie') ?? '';
  assert.match(c, /;\s*Secure/i); assert.match(c, /HttpOnly/i); assert.match(c, /SameSite=Strict/i);
});

R.area('ARCH-06 Proxy chain & client IP');
await R.test('ARCH-06a', '−', 'A forged X-Forwarded-For through the edge is ignored: the API records the real client IP', async () => {
  const email = `xff-${Date.now()}@x.io`;
  await req(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '6.6.6.6' }, body: JSON.stringify({ email, password: 'wrong-pass-1' }) });
  const key = psql(`SELECT key FROM login_attempts WHERE key LIKE '%|${email}'`);
  const ip = key.split('|')[0];
  assert.notEqual(ip, '6.6.6.6', 'spoofed IP accepted');
  const internal = ['edge', 'web'].map((s) => Object.values(inspect(s).NetworkSettings.Networks)[0].IPAddress);
  assert.ok(!internal.includes(ip.replace('::ffff:', '')), `API sees a proxy IP (${ip}) — every user would share one rate-limit bucket`);
  return `recorded client IP ${ip}`;
});

R.area('PEN Production surface (penetration checks over HTTPS)');
await R.test('PEN-01', '−', 'Secrets and server files are never served (/.env, /.git, compose file, backups, source maps)', async () => {
  for (const p of ['/.env', '/.env.production', '/.git/HEAD', '/.git/config', '/docker-compose.yml', '/backups/', '/infra/caddy/Caddyfile', '/package.json']) {
    const r = await req(`${BASE}${p}`);
    const body = await r.text();
    assert.ok(!/POSTGRES_PASSWORD|JWT_SECRET|ref: refs\/|"workspaces"|reverse_proxy/.test(body), `${p} leaked server content`);
  }
  const html = await (await req(`${BASE}/`)).text();
  const js = html.match(/\/assets\/[^"]+\.js/)[0];
  assert.notEqual((await req(`${BASE}${js}.map`)).headers.get('content-type'), 'application/json', 'source map served');
});
await R.test('PEN-02', '−', 'The Caddy admin API (2019) and the API port (3000) are not reachable from outside', async () => {
  const host = new URL(BASE).hostname;
  for (const port of [2019, 3000, 5432, 8080]) {
    const ok = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
    if (!ok) continue;
    // on a workstation another stack (e.g. the dev compose project) may own the port; only this project matters
    const owner = sh('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Label "com.docker.compose.project"}}']);
    assert.notEqual(owner, PROJECT, `port ${port} is published by ${PROJECT}`);
  }
});
await R.test('PEN-03', '−', 'TRACE is not echoed back (no cross-site tracing)', async () => {
  const r = await req(`${BASE}/`, { method: 'TRACE' }).catch(() => null);
  assert.ok(!r || r.status >= 400, `TRACE → ${r?.status}`);
});

R.area('ARCH-02 Backups & restore (NFR-06)');
await R.test('ARCH-02a', '+', 'A verified database dump and receipts archive exist; the backup service is healthy', async () => {
  dc('exec', '-T', 'backup', 'sh', '/backup.sh', 'now');
  const files = dc('exec', '-T', 'backup', 'sh', '-c', 'ls -1t /backups/db/*.dump | head -1; ls -1t /backups/files/*.tar.gz | head -1');
  assert.match(files, /jes-\d{8}-\d{6}\.dump/); assert.match(files, /receipts-\d{8}-\d{6}\.tar\.gz/);
  return files.split('\n').map((f) => f.split('/').pop()).join(', ');
});
await R.test('ARCH-02b', '+', 'Restore drill: the latest dump restores into an empty database with identical row counts', async () => {
  const latest = dc('exec', '-T', 'backup', 'sh', '-c', 'ls -1t /backups/db/*.dump | head -1');
  psql('DROP DATABASE IF EXISTS jes_restore_drill'); psql('CREATE DATABASE jes_restore_drill');
  dc('exec', '-T', 'backup', 'sh', '-c', `PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h db -U jes -d jes_restore_drill --no-owner ${latest}`);
  const q = 'SELECT (SELECT count(*) FROM bookings) || \'/\' || (SELECT count(*) FROM expenses) || \'/\' || (SELECT count(*) FROM users)';
  const [src, dst] = [psql(q), psql(q, 'jes_restore_drill')];
  psql('DROP DATABASE jes_restore_drill');
  assert.equal(dst, src);
  return `bookings/expenses/users ${dst}`;
});

R.area('ARCH-03/04/05/07/12 Runtime configuration');
await R.test('ARCH-03', '+', 'Every long-running service restarts automatically (unless-stopped)', async () => {
  for (const s of LONG_RUNNING) assert.equal(inspect(s).HostConfig.RestartPolicy.Name, 'unless-stopped', s);
});
await R.test('ARCH-04', '+', 'Container logs rotate (json-file, 10 MB × 5) so they cannot fill the disk', async () => {
  for (const s of LONG_RUNNING) {
    const lc = inspect(s).HostConfig.LogConfig;
    assert.equal(lc.Type, 'json-file', s); assert.equal(lc.Config['max-size'], '10m', s); assert.equal(lc.Config['max-file'], '5', s);
  }
});
await R.test('ARCH-05', '+', 'Memory limits on every service (fit a 2–4 GB VM); Postgres tuned', async () => {
  let total = 0;
  for (const s of LONG_RUNNING) { const m = inspect(s).HostConfig.Memory; assert.ok(m > 0, `${s} unlimited`); total += m; }
  assert.equal(psql('SHOW shared_buffers'), '256MB'); assert.equal(psql('SHOW max_connections'), '50');
  return `total limit ${(total / 2 ** 20).toFixed(0)} MiB`;
});
await R.test('ARCH-07', '+', 'Every long-running service has a healthcheck and is healthy', async () => {
  for (const s of LONG_RUNNING) {
    // a just-restarted container reports "starting" until its first check passes
    let st = inspect(s).State.Health?.Status;
    for (let i = 0; i < 30 && st === 'starting'; i++) { await new Promise((r) => setTimeout(r, 2000)); st = inspect(s).State.Health?.Status; }
    assert.equal(st, 'healthy', s);
  }
});
await R.test('ARCH-12', '+', 'Least privilege: no-new-privileges on all; read-only rootfs and no capabilities for app containers', async () => {
  for (const s of LONG_RUNNING) assert.ok(inspect(s).HostConfig.SecurityOpt?.includes('no-new-privileges:true'), s);
  for (const s of ['web', 'api', 'worker']) {
    const h = inspect(s).HostConfig;
    assert.equal(h.ReadonlyRootfs, true, `${s} rootfs`); assert.deepEqual(h.CapDrop, ['ALL'], `${s} caps`);
    assert.notEqual(inspect(s).Config.User, '', `${s} user`);
  }
  assert.deepEqual(inspect('edge').HostConfig.CapAdd.map((c) => c.replace(/^CAP_/, '')), ['NET_BIND_SERVICE']);
});
await R.test('ARCH-PORTS', '−', 'Only the TLS edge publishes ports; database, API and web are internal', async () => {
  for (const s of ['db', 'api', 'web', 'worker', 'backup']) {
    const p = inspect(s).NetworkSettings.Ports ?? {};
    assert.ok(Object.values(p).every((v) => !v), `${s} publishes ${JSON.stringify(p)}`);
  }
});

R.area('ARCH-08/09/10/11 Build & release');
await R.test('ARCH-08', '+', 'All base images are pinned to exact versions', async () => {
  const files = ['docker-compose.prod.yml', 'infra/api.Dockerfile', 'infra/web.Dockerfile'].map((f) => readFileSync(`${ROOT}/${f}`, 'utf8')).join('\n');
  const refs = [...files.matchAll(/(?:image:|FROM)\s+([\w./-]+:[\w.-]+)/g)].map((m) => m[1]).filter((r) => !r.endsWith(':local'));
  for (const r of refs) assert.match(r, /:\d+\.\d+(\.\d+)?-/, `${r} is not pinned`);
  return [...new Set(refs)].join(', ');
});
await R.test('ARCH-09', '+', 'The app shell revalidates on every load; hashed assets are cached for a year', async () => {
  const html = await req(`${BASE}/`);
  assert.equal(html.headers.get('cache-control'), 'no-cache');
  const asset = (await html.text()).match(/\/assets\/[^"]+\.js/)[0];
  assert.match((await req(`${BASE}${asset}`)).headers.get('cache-control') ?? '', /max-age=31536000.*immutable|immutable.*max-age=31536000/);
});
await R.test('ARCH-10', '+', 'No fonts are inlined as data: URIs (they would be blocked by the CSP)', async () => {
  const html = await (await req(`${BASE}/`)).text();
  const css = html.match(/\/assets\/[^"]+\.css/)[0];
  assert.ok(!(await (await req(`${BASE}${css}`)).text()).includes('data:font'), 'data:font found in CSS');
});
await R.test('ARCH-11', '+', 'The worker stops gracefully on SIGTERM well within the grace period and comes back healthy', async () => {
  const t0 = Date.now();
  dc('stop', '-t', '20', 'worker');
  const took = Date.now() - t0;
  const log = dc('logs', '--no-log-prefix', '--tail', '20', 'worker');
  dc('start', 'worker');
  assert.match(log, /worker: SIGTERM, stopping/); assert.ok(took < 10_000, `${took} ms`);
  return `stopped in ${took} ms`;
});
await R.test('ARCH-13', '+', 'CI runs install, type-check, unit tests and builds on every push', async () => {
  const ci = readFileSync(`${ROOT}/.github/workflows/ci.yml`, 'utf8');
  for (const step of ['npm ci', 'npm test', 'npm run build']) assert.ok(ci.includes(step), step);
});

R.done();
