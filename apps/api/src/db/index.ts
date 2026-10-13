import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** A connection inside a transaction; exec runs multi-statement scripts. */
export interface TxQueryable extends Queryable {
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Runs fn inside a transaction; rolls back if it throws. */
  tx<T>(fn: (q: TxQueryable) => Promise<T>): Promise<T>;
  /** Runs a multi-statement SQL script (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** Production: node-postgres pool. */
export async function createPgDb(connectionString: string): Promise<Db> {
  const { default: pg } = await import('pg');
  // Keep DATE columns as 'YYYY-MM-DD' strings. The default parser makes a local-midnight Date,
  // which shifts warranty start/expiry dates by a day once serialized to JSON.
  pg.types.setTypeParser(1082, (v: string) => v);
  const pool = new pg.Pool({ connectionString });
  return {
    query: (sql, params) => pool.query(sql, params as any[]) as any,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({
          query: (s, p) => client.query(s, p as any[]) as any,
          exec: async (s) => { await client.query(s); },
        });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

/** Tests and local demo: in-process Postgres (PGlite). */
export async function createMemoryDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite({ parsers: { 1082: (v: string) => v } }); // DATE as 'YYYY-MM-DD', same as pg driver
  // PGlite runs one statement stream; serialize transactions so they never interleave.
  let chain: Promise<unknown> = Promise.resolve();
  type Raw = { query: (sql: string, params?: any[]) => Promise<{ rows: unknown[] }>; exec: (sql: string) => Promise<unknown> };
  const wrap = (q: Raw): TxQueryable => ({
    query: async (sql, params) => {
      const r = await q.query(sql, params as any[]);
      return { rows: r.rows as any[] };
    },
    exec: async (sql) => { await q.exec(sql); },
  });
  const db: Db = {
    query: async (sql, params) => {
      await chain;
      return wrap(pg).query(sql, params);
    },
    tx(fn) {
      const run = chain.then(() => pg.transaction((t) => fn(wrap(t))));
      chain = run.catch(() => undefined);
      return run;
    },
    exec: async (sql) => {
      await chain;
      await pg.exec(sql);
    },
    close: () => pg.close(),
  };
  return db;
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies each pending migration in its own transaction, so a failure leaves nothing half-built. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    await db.tx(async (q) => {
      await q.exec(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
  }
}
