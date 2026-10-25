// A deterministic text description of a database schema (columns, constraints, indexes, triggers, extensions, enums),
// used to prove that replaying the migrations on a fresh database gives the same schema every time.
import type { Queryable } from './database.js';

export async function schemaFingerprint(q: Queryable): Promise<string[]> {
  const parts = await Promise.all([
    q.query<{ s: string }>(
      `SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || udt_name || ' null=' || is_nullable ||
              ' default=' || coalesce(column_default, '-') AS s
         FROM information_schema.columns WHERE table_schema = 'public'`,
    ),
    q.query<{ s: string }>(
      `SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS s
         FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
    ),
    q.query<{ s: string }>(
      `SELECT 'index ' || indexdef AS s FROM pg_indexes WHERE schemaname = 'public'`,
    ),
    q.query<{ s: string }>(
      `SELECT 'trigger ' || tgrelid::regclass::text || ' ' || tgname || ' ' || pg_get_triggerdef(oid) AS s
         FROM pg_trigger WHERE NOT tgisinternal`,
    ),
    q.query<{ s: string }>(
      `SELECT 'extension ' || extname AS s FROM pg_extension`,
    ),
    q.query<{ s: string }>(
      `SELECT 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS s
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`,
    ),
    q.query<{ s: string }>(
      `SELECT 'function ' || p.proname AS s FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`,
    ),
  ]);
  return parts.flatMap((result) => result.rows.map((row) => row.s)).sort();
}
