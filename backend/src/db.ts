import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { config } from './config';

// bigint (int8) → JS number. Rupiah amounts stay far below 2^53.
types.setTypeParser(20, (v) => Number(v));
// date → plain "YYYY-MM-DD" string, never shifted by the server time zone
types.setTypeParser(1082, (v) => v);

export type Queryable = Pick<PoolClient, 'query'>;

const camelKey = (k: string) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
/** snake_case columns → camelCase keys (shallow; jsonb values are left as stored). */
export function camel<T = any>(row: Record<string, unknown>): T {
  const o: Record<string, unknown> = {};
  for (const k in row) o[camelKey(k)] = row[k];
  return o as T;
}

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool = pool;

  async many<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], q: Queryable = pool): Promise<T[]> {
    return (await q.query(sql, params)).rows.map((r) => camel<T>(r));
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], q: Queryable = pool): Promise<T | null> {
    const r = (await q.query(sql, params)).rows[0];
    return r ? camel<T>(r) : null;
  }

  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async onModuleDestroy() {
    await pool.end();
  }
}

/** Applies db/migrations/*.sql once each, in name order, under an advisory lock. */
export async function migrate(dir = join(__dirname, '..', 'db', 'migrations')) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(424242)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        console.log(`migrated ${f}`);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(424242)').catch(() => undefined);
    c.release();
  }
}
