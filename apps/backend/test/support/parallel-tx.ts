// Parallel-transaction helper (from Spike B, M2): holds a transaction open on one connection while another one runs and
// detects "blocked by" from PostgreSQL itself (pg_blocking_pids) instead of sleeping and hoping.
//
// Rules the helper enforces for every transaction it opens:
//   - a recognizable application_name (pids are easy to read in pg_stat_activity),
//   - lock_timeout 15 s, statement_timeout 30 s and idle_in_transaction_session_timeout 60 s as safety nets: a test that
//     forgets to release can never hold locks for long (releaseAll() also rolls back anything still open),
//   - a current_database() check: the helper refuses any database other than nelio_test,
//   - the connection is destroyed on release (client.release(true)), so session settings never leak into the pool.
//
// The pool must be larger than the number of simultaneously open transactions + 1 (the monitor query uses the pool).
import pg from 'pg';
import { TEST_DATABASE } from './test-database.mjs';

export type Mode = 'commit' | 'rollback';

export interface HeldTx {
  readonly label: string;
  readonly pid: number;
  readonly client: pg.PoolClient;
  /**
   * Ends the transaction and destroys the connection. Safe to call twice. A statement still in flight (for example one
   * blocked on a lock) is cancelled first, so releasing never waits for lock_timeout.
   */
  release(mode: Mode): Promise<void>;
  /** @internal statements sent with startStatement that have not settled yet */
  readonly inflight: Set<Promise<unknown>>;
}

export interface PendingStatement<
  T extends pg.QueryResultRow = pg.QueryResultRow,
> {
  /** Resolves/rejects with the statement outcome. A rejection that nobody awaits does not crash the process. */
  readonly promise: Promise<pg.QueryResult<T>>;
  isSettled(): boolean;
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every transaction opened and not yet released, so a failing test can never leave locks or hang pool.end(). */
const open = new Set<HeldTx>();

/** Rolls back every transaction still open (call from afterEach/afterAll). Returns how many it had to clean up. */
export async function releaseAll(): Promise<number> {
  const leaked = [...open];
  for (const tx of leaked) {
    await tx.release('rollback').catch(() => undefined);
  }
  return leaked.length;
}

/** Opens a transaction (BEGIN) on a fresh pooled connection and returns it with its backend pid. */
export async function openTx(pool: pg.Pool, label: string): Promise<HeldTx> {
  const client = await pool.connect();
  let done = false;
  try {
    await client.query('BEGIN');
    const db = await client.query<{ db: string }>(
      'SELECT current_database() AS db',
    );
    if (db.rows[0].db !== TEST_DATABASE) {
      throw new Error(
        `refusing to run: connected to "${db.rows[0].db}", expected "${TEST_DATABASE}"`,
      );
    }
    await client.query("SELECT set_config('application_name', $1, true)", [
      label,
    ]);
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    const { rows } = await client.query<{ pid: number }>(
      'SELECT pg_backend_pid()::int AS pid',
    );
    const inflight = new Set<Promise<unknown>>();
    const tx: HeldTx = {
      label,
      pid: rows[0].pid,
      client,
      inflight,
      async release(mode: Mode) {
        if (done) return;
        done = true;
        open.delete(tx);
        try {
          if (inflight.size > 0) {
            // COMMIT/ROLLBACK would queue behind a blocked statement. Cancel it from another connection first.
            await pool.query('SELECT pg_cancel_backend($1::int)', [
              rows[0].pid,
            ]);
            await Promise.allSettled(inflight);
            await client.query('ROLLBACK'); // a cancelled statement aborts the transaction; nothing to commit
          } else {
            await client.query(mode === 'commit' ? 'COMMIT' : 'ROLLBACK');
          }
        } finally {
          client.release(true);
        }
      },
    };
    open.add(tx);
    return tx;
  } catch (e) {
    done = true;
    client.release(true);
    throw e;
  }
}

/** Opens a transaction and runs a locking statement on it (for example `SELECT 1 FROM users WHERE id = $1 FOR SHARE`). */
export async function holdTx(
  pool: pg.Pool,
  label: string,
  lockSql: string,
  params: unknown[] = [],
): Promise<HeldTx> {
  const tx = await openTx(pool, label);
  try {
    await tx.client.query(lockSql, params);
  } catch (e) {
    await tx.release('rollback');
    throw e;
  }
  return tx;
}

/** Sends a statement on an open transaction WITHOUT waiting for it, so the caller can check that it is blocked. */
export function startStatement<T extends pg.QueryResultRow = pg.QueryResultRow>(
  tx: HeldTx,
  sql: string,
  params: unknown[] = [],
): PendingStatement<T> {
  let settled = false;
  const promise = tx.client.query<T>(sql, params).then(
    (result) => {
      settled = true;
      return result;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );
  promise.catch(() => undefined);
  tx.inflight.add(promise);
  const forget = () => {
    tx.inflight.delete(promise);
  };
  promise.then(forget, forget);
  return { promise, isSettled: () => settled };
}

/** Backend pids currently blocking `pid` (empty when it is not waiting for a lock). */
export async function blockersOf(
  pool: pg.Pool,
  pid: number,
): Promise<number[]> {
  const { rows } = await pool.query<{ b: number[] }>(
    'SELECT pg_blocking_pids($1::int) AS b',
    [pid],
  );
  return rows[0].b;
}

/** Waits until PostgreSQL reports that `waiterPid` is blocked by `holderPid`; fails with a clear message otherwise. */
export async function awaitBlockedBy(
  pool: pg.Pool,
  waiterPid: number,
  holderPid: number,
  timeoutMs = 5000,
  pollMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const blockers = await blockersOf(pool, waiterPid);
    if (blockers.includes(holderPid)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `pid ${waiterPid} is not blocked by pid ${holderPid} after ${timeoutMs} ms (blocked by: ${JSON.stringify(blockers)})`,
      );
    }
    await sleep(pollMs);
  }
}

/** True when the promise settles within `ms`; false when it is still pending (does not cancel it). */
export async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = promise.then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
