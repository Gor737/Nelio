// Test database lifecycle: build `nelio_test` from the migration files, every integration run.
// Plain ESM so that Jest's globalSetup can run it without a TypeScript transform.
//
// SAFETY: the only database this module ever drops or recreates is named exactly TEST_DATABASE ('nelio_test'), and the
// shadow database used by the drift check is TEST_SHADOW_DATABASE. The application database and any other database are
// never touched: assertTestDatabaseName() throws for every other name before a statement is sent.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  resolveDatabaseUrl,
  withDatabase,
} from '../../prisma/database-url.mjs';

export const TEST_DATABASE = 'nelio_test';
export const TEST_SHADOW_DATABASE = 'nelio_test_shadow';

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../prisma/migrations',
);

/** @param {string} name */
export function assertTestDatabaseName(name) {
  if (name !== TEST_DATABASE && name !== TEST_SHADOW_DATABASE) {
    throw new Error(
      `refusing to touch database "${name}": only ${TEST_DATABASE} and ${TEST_SHADOW_DATABASE} are allowed`,
    );
  }
}

/** Connection string of the server's maintenance database (credentials from DATABASE_URL or POSTGRES_*). */
export function adminUrl() {
  return withDatabase(resolveDatabaseUrl(), 'postgres');
}

export function testDatabaseUrl() {
  return withDatabase(resolveDatabaseUrl(), TEST_DATABASE);
}

export function testShadowDatabaseUrl() {
  return withDatabase(resolveDatabaseUrl(), TEST_SHADOW_DATABASE);
}

/** Migration directories in application order (their names start with a timestamp). */
export function migrationFiles() {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'),
    }));
}

/** @param {pg.Client} admin @param {string} name */
async function recreate(admin, name) {
  assertTestDatabaseName(name);
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
}

/** @param {pg.Client} admin @param {string} name */
async function ensure(admin, name) {
  assertTestDatabaseName(name);
  const exists = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [name],
  );
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
}

/**
 * Drops and recreates `nelio_test`, applies every migration in order (each file is one simple-protocol query, so it
 * runs as a single implicit transaction), and makes sure the shadow database exists. Returns the applied names.
 */
export async function buildTestDatabase() {
  return buildDatabaseNamed(TEST_DATABASE);
}

/** Drops, recreates and migrates one of the two allowed databases (used for the replay-equals-original test). @param {string} target */
export async function buildDatabaseNamed(target) {
  assertTestDatabaseName(target);
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await recreate(admin, target);
    await ensure(admin, TEST_SHADOW_DATABASE); // already exists when it is the target (recreated just above)
  } finally {
    await admin.end();
  }

  const db = new pg.Client({
    connectionString: withDatabase(resolveDatabaseUrl(), target),
  });
  await db.connect();
  const applied = [];
  try {
    for (const migration of migrationFiles()) {
      await db.query(migration.sql);
      applied.push(migration.name);
    }
  } finally {
    await db.end();
  }
  return applied;
}
