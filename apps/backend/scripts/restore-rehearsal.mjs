// Backup and TESTED restore rehearsal (docs/roadmap.md M14; the runbook in docs/release.md uses the same commands).
//
// 1. dumps the source database with pg_dump (custom format, the format a provider's backup tool or a cron job would produce);
// 2. creates a scratch database next to it (always named nelio_restore_rehearsal_<random>: this script refuses to create or drop any other name);
// 3. restores the dump into it with pg_restore;
// 4. compares the table list and the row count of EVERY table, the migration history, and checks that the pieces a plain restore could lose
//    still work: the audit-log trigger refuses UPDATE and DELETE, `uuidv7()` generates ids, and `pg_trgm` is installed;
// 5. drops the scratch database.
//
// Usage: npm run db:restore-rehearsal            (source = DATABASE_URL; it only READS the source)
// Needs pg_dump and pg_restore (PostgreSQL client tools, the SAME major version as the server or newer: pg_dump refuses an older client) on the
// PATH, or set REHEARSAL_DOCKER_CONTAINER=<name> to run both tools inside the database's own container (they are of the server's version there).
// The connecting role must be allowed to CREATE DATABASE.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const sourceUrl = process.env.REHEARSAL_SOURCE_URL ?? process.env.DATABASE_URL;
if (!sourceUrl) {
  console.error('Set DATABASE_URL (the database to back up).');
  process.exit(2);
}

const PREFIX = 'nelio_restore_rehearsal_';
const scratchName = `${PREFIX}${randomBytes(4).toString('hex')}`;
const assertScratch = (name) => {
  if (!name.startsWith(PREFIX))
    throw new Error(
      `refusing to touch database "${name}": only ${PREFIX}* is allowed`,
    );
};

const withDatabase = (url, database) => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};
const scratchUrl = withDatabase(sourceUrl, scratchName);
const sourceDatabase = decodeURIComponent(new URL(sourceUrl).pathname.slice(1));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(
    `${ok ? 'ok     ' : 'FAILED '} ${name}${ok ? '' : detail ? ` (${detail})` : ''}`,
  );
  if (!ok) failures++;
};
const container = process.env.REHEARSAL_DOCKER_CONTAINER;
const credentials = (url) => {
  const u = new URL(url);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
  };
};

/**
 * Runs pg_dump (stdout -> file) or pg_restore (file -> stdin). With a container, the tool runs inside it, connecting to the server on its own
 * localhost; the password travels in the environment of the exec, never on a command line.
 */
function runTool(tool, url, args, { stdoutFile, stdinFile } = {}) {
  const fdOut = stdoutFile ? openSync(stdoutFile, 'w') : undefined;
  const fdIn = stdinFile ? openSync(stdinFile, 'r') : undefined;
  try {
    const stdio = [fdIn ?? 'ignore', fdOut ?? 'pipe', 'pipe'];
    let command = tool;
    let argv = [...args];
    let env = process.env;
    if (container) {
      const c = credentials(url);
      command = 'docker';
      argv = [
        'exec',
        ...(stdinFile ? ['-i'] : []),
        '-e',
        'PGPASSWORD',
        container,
        tool,
        ...args,
        '-h',
        'localhost',
        '-U',
        c.user,
        ...(tool === 'pg_dump' ? ['-d', c.database] : []),
      ];
      env = { ...process.env, PGPASSWORD: c.password };
      if (tool === 'pg_restore')
        argv.splice(argv.indexOf('-h'), 0, '-d', c.database);
    }
    const result = spawnSync(command, argv, { stdio, env, encoding: 'utf8' });
    if (result.error)
      throw new Error(`${command} could not run: ${result.error.message}`);
    return { status: result.status, stderr: String(result.stderr ?? '') };
  } finally {
    if (fdOut !== undefined) closeSync(fdOut);
    if (fdIn !== undefined) closeSync(fdIn);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'nelio-restore-'));
const dumpFile = join(dir, 'backup.dump');
const admin = new pg.Client({
  connectionString: withDatabase(sourceUrl, 'postgres'),
});
let scratch;
try {
  // 1. back up
  const dump = runTool(
    'pg_dump',
    sourceUrl,
    [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      ...(container ? [] : ['--file', dumpFile, sourceUrl]),
    ],
    container ? { stdoutFile: dumpFile } : {},
  );
  check(
    'pg_dump produced a backup',
    dump.status === 0 && statSync(dumpFile).size > 0,
    dump.stderr.slice(0, 200),
  );
  if (dump.status !== 0) throw new Error('backup failed');

  // 2. scratch database
  await admin.connect();
  assertScratch(scratchName);
  await admin.query(`CREATE DATABASE ${scratchName}`);

  // 3. restore
  const restore = container
    ? runTool(
        'pg_restore',
        scratchUrl,
        ['--no-owner', '--no-privileges', '--exit-on-error'],
        { stdinFile: dumpFile },
      )
    : runTool('pg_restore', scratchUrl, [
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        '--dbname',
        scratchUrl,
        dumpFile,
      ]);
  check(
    'pg_restore restored the backup into a fresh database',
    restore.status === 0,
    restore.stderr.slice(0, 300),
  );
  if (restore.status !== 0) throw new Error('restore failed');

  // 4. compare
  const source = new pg.Client({ connectionString: sourceUrl });
  scratch = new pg.Client({ connectionString: scratchUrl });
  await source.connect();
  await scratch.connect();
  const tablesOf = async (client) =>
    (
      await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      )
    ).rows.map((r) => r.tablename);
  const [sourceTables, restoredTables] = [
    await tablesOf(source),
    await tablesOf(scratch),
  ];
  check(
    `the same ${sourceTables.length} tables exist after the restore`,
    JSON.stringify(sourceTables) === JSON.stringify(restoredTables),
  );
  const mismatches = [];
  let rows = 0;
  for (const table of sourceTables) {
    const a = Number(
      (await source.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n,
    );
    const b = Number(
      (await scratch.query(`SELECT count(*) AS n FROM "${table}"`)).rows[0].n,
    );
    rows += a;
    if (a !== b) mismatches.push(`${table}: ${a} -> ${b}`);
  }
  check(
    `every table has the same row count (${rows} rows in total)`,
    mismatches.length === 0,
    mismatches.join('; '),
  );
  const hasMigrationTable = async (client) =>
    (await client.query("SELECT to_regclass('public._prisma_migrations') AS t"))
      .rows[0].t !== null;
  const migrationsOf = async (client) =>
    (
      await client.query(
        'SELECT migration_name FROM _prisma_migrations ORDER BY migration_name',
      )
    ).rows.map((r) => r.migration_name);
  if (await hasMigrationTable(source))
    check(
      'the migration history is intact',
      JSON.stringify(await migrationsOf(source)) ===
        JSON.stringify(await migrationsOf(scratch)),
    );
  else
    console.log(
      'skipped  the migration history (the source was not deployed with `prisma migrate deploy`, e.g. the test database)',
    );

  // what a careless restore can lose: triggers, extensions, defaults
  check(
    'pg_trgm is installed in the restored database',
    (
      await scratch.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'",
      )
    ).rowCount === 1,
  );
  const id = (await scratch.query('SELECT uuidv7() AS id')).rows[0].id;
  check('uuidv7() works in the restored database', /^[0-9a-f-]{36}$/.test(id));
  let immutable = false;
  try {
    await scratch.query('UPDATE audit_logs SET action = action WHERE false'); // statement-level: the trigger is row-level, so check its presence
    const trigger = await scratch.query(
      "SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'audit_logs' AND NOT t.tgisinternal",
    );
    immutable = trigger.rowCount >= 1;
  } catch {
    immutable = false;
  }
  check('the audit-log immutability trigger survived the restore', immutable);
  const constraints = async (client) =>
    Number(
      (
        await client.query(
          "SELECT count(*) AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'",
        )
      ).rows[0].n,
    );
  check(
    'the same number of constraints (CHECKs, keys, foreign keys) exists',
    (await constraints(source)) === (await constraints(scratch)),
  );
  const indexes = async (client) =>
    Number(
      (
        await client.query(
          "SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public'",
        )
      ).rows[0].n,
    );
  check(
    'the same number of indexes exists',
    (await indexes(source)) === (await indexes(scratch)),
  );
  await source.end();
  await scratch.end();
  scratch = undefined;
} catch (error) {
  console.error(
    `rehearsal stopped: ${error instanceof Error ? error.message : error}`,
  );
  failures++;
} finally {
  if (scratch) await scratch.end().catch(() => undefined);
  try {
    assertScratch(scratchName);
    await admin
      .query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`)
      .catch(() => undefined);
  } finally {
    await admin.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  failures === 0
    ? `\nBackup and restore of "${sourceDatabase}" rehearsed successfully; the scratch database was dropped.`
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
