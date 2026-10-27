import { Prisma } from '../../generated/prisma/client.js';
import {
  ADVISORY_LOCK_KEYS,
  LOCKABLE_TABLE_SQL_NAMES,
  ROW_LOCK_MODES,
  type AdvisoryLockKey,
  type LockableTable,
  type RowLockMode,
} from '../../common/constants/lock-tables.js';
import type { Tx } from './tx.js';

const ROW_MODE_SQL: Record<RowLockMode, Prisma.Sql> = {
  SHARE: Prisma.raw('FOR SHARE'), // Course-S
  NO_KEY_UPDATE: Prisma.raw('FOR NO KEY UPDATE'), // Course-X; never FOR UPDATE (it blocks FK checks)
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Locks one row by id. The table comes from a closed whitelist mapped to SQL names in `LOCKABLE_TABLE_SQL_NAMES` (never
 * from the caller's string), the mode is one of two fixed fragments, and the id is a validated UUID passed as a bound
 * parameter. Returns whether the row exists (and is now locked).
 */
export async function lockRow(
  tx: Tx,
  table: LockableTable,
  id: string,
  mode: RowLockMode,
): Promise<boolean> {
  if (!Object.hasOwn(LOCKABLE_TABLE_SQL_NAMES, table))
    throw new TypeError(`lockRow: table "${String(table)}" is not lockable`);
  if (!(ROW_LOCK_MODES as readonly string[]).includes(mode))
    throw new TypeError(`lockRow: mode "${String(mode)}" is not allowed`);
  if (!UUID.test(id)) throw new TypeError('lockRow: id must be a UUID');
  const name = Prisma.raw(`"${LOCKABLE_TABLE_SQL_NAMES[table]}"`);
  const rows = await tx.$queryRaw<
    { one: number }[]
  >`SELECT 1 AS one FROM ${name} WHERE id = ${id}::uuid ${ROW_MODE_SQL[mode]}`;
  return rows.length === 1;
}

/**
 * Locks several rows of one table in ascending id order (Decision 160: ascending ids prevent deadlocks between two
 * transactions locking the same set). Returns the ids that exist.
 */
export async function lockRows(
  tx: Tx,
  table: LockableTable,
  ids: readonly string[],
  mode: RowLockMode,
): Promise<string[]> {
  const sorted = [...new Set(ids)].sort();
  const locked: string[] = [];
  for (const id of sorted) {
    if (await lockRow(tx, table, id, mode)) locked.push(id);
  }
  return locked;
}

/** Advisory transaction lock keyed by a constant name. The result is void, so `$executeRaw`, not `$queryRaw`. */
export async function lockAdvisory(
  tx: Tx,
  key: AdvisoryLockKey,
): Promise<void> {
  if (!(ADVISORY_LOCK_KEYS as readonly string[]).includes(key))
    throw new TypeError(`lockAdvisory: key "${String(key)}" is not allowed`);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
