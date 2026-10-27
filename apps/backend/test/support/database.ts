// Real-PostgreSQL access for integration tests: a pool larger than 1 (concurrency tests need it), the safety check, and
// per-test isolation by truncating every table. The database itself is built from the migrations by globalSetup.
import pg from 'pg';
import { TEST_DATABASE, testDatabaseUrl } from './test-database.mjs';

/** A pool on `nelio_test`. Default size 10: parallel-transaction tests hold several connections plus a monitor. */
export function createPool(max = 10): pg.Pool {
  return new pg.Pool({
    connectionString: testDatabaseUrl(),
    max,
    connectionTimeoutMillis: 5000,
  });
}

export type Queryable = Pick<pg.Pool, 'query'>;

/** Throws unless connected to the test database. Called before anything destructive. */
export async function assertTestDatabase(q: Queryable): Promise<void> {
  const { rows } = await q.query<{ db: string }>(
    'SELECT current_database() AS db',
  );
  if (rows[0].db !== TEST_DATABASE) {
    throw new Error(
      `refusing to run: connected to "${rows[0].db}", expected "${TEST_DATABASE}"`,
    );
  }
}

/** Test isolation: empties every table of the public schema (the schema grows with each milestone; nothing is listed by hand). */
export async function resetData(pool: pg.Pool): Promise<void> {
  await assertTestDatabase(pool);
  const { rows } = await pool.query<{ t: string }>(
    "SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public'",
  );
  if (rows.length > 0)
    await pool.query(
      `TRUNCATE ${rows.map((r) => r.t).join(', ')} RESTART IDENTITY CASCADE`,
    );
}
