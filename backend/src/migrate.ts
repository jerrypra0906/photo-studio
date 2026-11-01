import { migrate, pool } from './db';
import { seed } from './seed';

/**
 * One-shot job run with the database owner's credentials before the API starts:
 * schema migrations, first-run seed, and the least-privilege role the API and worker use (SEC-G3).
 */
async function ensureAppRole() {
  const password = process.env.APP_DB_PASSWORD;
  if (!password) throw new Error('Missing env APP_DB_PASSWORD');
  const c = await pool.connect();
  try {
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jes_app') THEN CREATE ROLE jes_app LOGIN; END IF;
    END $$`);
    const alter = (await c.query(`SELECT format('ALTER ROLE jes_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text) AS q`, [password])).rows[0].q;
    await c.query(alter);
    await c.query(`GRANT CONNECT ON DATABASE ${(await c.query('SELECT current_database() AS d')).rows[0].d} TO jes_app`);
    await c.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await c.query(`GRANT USAGE ON SCHEMA public TO jes_app`);
    // data access only: no DDL, no TRUNCATE, no ownership
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jes_app`);
    await c.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jes_app`);
    await c.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM jes_app`);
    // audit rows are append-only for the application
    await c.query(`REVOKE UPDATE, DELETE ON booking_history, expense_audit FROM jes_app`);
  } finally {
    c.release();
  }
}

(async () => {
  await migrate();
  await seed();
  await ensureAppRole();
  await pool.end();
  console.log('migrate: done');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
