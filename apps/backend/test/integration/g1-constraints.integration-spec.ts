// M5 constraint tests for schema group G1 (users, auth, files, audit, blocks) against a real PostgreSQL database built
// from the migration files. Every hand-written object (Decision 102) has a test here that tries to break it.
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { TIME_LIMITS } from '../../src/common/constants/limits.js';
import { createPool, resetData } from '../support/database.js';
import {
  createAdmin,
  createAuditEntry,
  createFile,
  createRefreshToken,
  createUser,
  createUserWithRoles,
} from '../support/factories.js';
import {
  awaitBlockedBy,
  openTx,
  releaseAll,
  sleep,
  startStatement,
} from '../support/parallel-tx.js';
import { schemaFingerprint } from '../support/schema-fingerprint.js';
import { SQLSTATE, sqlError } from '../support/sql.js';
import {
  TEST_SHADOW_DATABASE,
  buildDatabaseNamed,
  testDatabaseUrl,
  testShadowDatabaseUrl,
} from '../support/test-database.mjs';

const run = promisify(execFile);
const backendDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DAY_MS = 24 * 3600 * 1000;

describe('G1 schema (real PostgreSQL, built from migrations)', () => {
  const pool = createPool();
  beforeEach(() => resetData(pool));
  afterEach(async () => {
    expect(await releaseAll()).toBe(0);
  });
  afterAll(() => pool.end());

  const names = async (sql: string, params: unknown[] = []) =>
    (await pool.query<{ n: string }>(sql, params)).rows.map((r) => r.n).sort();

  // ---- what the migrations built -------------------------------------------------------------------------------------

  describe('structure', () => {
    it('has exactly the 8 G1 tables, the enums and the pg_trgm extension', async () => {
      expect(
        await names(
          "SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'",
        ),
      ).toEqual([
        'audit_logs',
        'auth_identities',
        'blocks',
        'email_tokens',
        'file_assets',
        'refresh_tokens',
        'user_roles',
        'users',
      ]);
      expect(
        await names(
          "SELECT typname AS n FROM pg_type WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace",
        ),
      ).toEqual([
        'auth_provider',
        'email_token_type',
        'file_kind',
        'platform_role',
        'role_status',
        'user_status',
      ]);
      expect(await names('SELECT extname AS n FROM pg_extension')).toContain(
        'pg_trgm',
      );
    });

    it('Decision 165: every UUID primary key named id defaults to the native uuidv7(), and generated ids are version 7', async () => {
      const columns = await pool.query<{
        table_name: string;
        column_default: string | null;
      }>(
        `SELECT table_name, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'id' AND data_type = 'uuid' ORDER BY table_name`,
      );
      expect(columns.rows.map((c) => c.table_name)).toEqual([
        'audit_logs',
        'auth_identities',
        'email_tokens',
        'file_assets',
        'refresh_tokens',
        'users',
      ]);
      for (const column of columns.rows)
        expect(column.column_default).toBe('uuidv7()');

      const user = await createUser(pool);
      const { rows } = await pool.query<{ version: number }>(
        'SELECT uuid_extract_version($1::uuid) AS version',
        [user.id],
      );
      expect(rows[0].version).toBe(7);
    });

    it('timestamps are timestamptz everywhere (no timestamp without time zone)', async () => {
      const bad = await names(
        "SELECT table_name || '.' || column_name AS n FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'",
      );
      expect(bad).toEqual([]);
    });

    it('has every required index (unique keys, FK children, audit, trigram, partial avatar index)', async () => {
      const present = await names(
        "SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'public'",
      );
      for (const index of [
        'users_email_key',
        'users_full_name_trgm_idx',
        'users_avatar_file_id_idx',
        'user_roles_pkey',
        'user_roles_role_status_idx',
        'refresh_tokens_token_hash_key',
        'refresh_tokens_user_id_idx',
        'refresh_tokens_family_id_idx',
        'auth_identities_provider_provider_account_id_key',
        'auth_identities_user_id_provider_key',
        'email_tokens_token_hash_key',
        'email_tokens_user_id_type_idx',
        'file_assets_storage_key_key',
        'audit_logs_target_type_target_id_created_at_idx',
        'audit_logs_actor_id_created_at_idx',
        'audit_logs_action_created_at_idx',
        'blocks_pkey',
        'blocks_blocked_id_idx',
      ]) {
        expect(present).toContain(index);
      }
    });

    it('foreign-key delete actions match the architecture table: CASCADE for credentials and blocks, RESTRICT for everything else', async () => {
      const { rows } = await pool.query<{
        conname: string;
        confdeltype: string;
      }>(
        "SELECT conname, confdeltype::text FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace ORDER BY conname",
      );
      expect(
        Object.fromEntries(rows.map((r) => [r.conname, r.confdeltype])),
      ).toEqual({
        audit_logs_actor_id_fkey: 'r',
        auth_identities_user_id_fkey: 'c',
        blocks_blocked_id_fkey: 'c',
        blocks_blocker_id_fkey: 'c',
        email_tokens_user_id_fkey: 'c',
        file_assets_uploaded_by_fkey: 'r',
        refresh_tokens_user_id_fkey: 'c',
        user_roles_decided_by_fkey: 'r',
        user_roles_user_id_fkey: 'r',
        users_avatar_file_id_fkey: 'r',
      });
    });
  });

  // ---- unique keys ---------------------------------------------------------------------------------------------------

  describe('unique keys', () => {
    it('duplicate email is rejected (users_email_key)', async () => {
      await createUser(pool, { email: 'dup@example.test' });
      const error = await sqlError(
        createUser(pool, { email: 'dup@example.test' }),
      );
      expect(error).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'users_email_key',
      });
    });

    it('the database does not lowercase emails: the service must (documented: "lowercased in code")', async () => {
      await createUser(pool, { email: 'Case@example.test' });
      await createUser(pool, { email: 'case@example.test' }); // both rows are accepted at database level
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM users WHERE lower(email) = 'case@example.test'",
      );
      expect(rows[0].n).toBe(2);
    });

    it('duplicate (user_id, role) is rejected (user_roles_pkey)', async () => {
      const user = await createUserWithRoles(pool, [{ role: 'STUDENT' }]);
      const error = await sqlError(
        pool.query(
          "INSERT INTO user_roles (user_id, role, status) VALUES ($1, 'STUDENT', 'PENDING')",
          [user.id],
        ),
      );
      expect(error).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'user_roles_pkey',
      });
    });

    it('token hashes and storage keys are unique', async () => {
      const user = await createUser(pool);
      await createRefreshToken(pool, user.id, { tokenHash: 'same' });
      expect(
        await sqlError(
          createRefreshToken(pool, user.id, { tokenHash: 'same' }),
        ),
      ).toMatchObject({ constraint: 'refresh_tokens_token_hash_key' });

      await pool.query(
        "INSERT INTO email_tokens (user_id, type, token_hash, expires_at) VALUES ($1, 'EMAIL_VERIFICATION', 'same', now())",
        [user.id],
      );
      expect(
        await sqlError(
          pool.query(
            "INSERT INTO email_tokens (user_id, type, token_hash, expires_at) VALUES ($1, 'PASSWORD_RESET', 'same', now())",
            [user.id],
          ),
        ),
      ).toMatchObject({ constraint: 'email_tokens_token_hash_key' });

      const fileId = await createFile(pool, user.id);
      const { rows } = await pool.query<{ storage_key: string }>(
        'SELECT storage_key FROM file_assets WHERE id = $1',
        [fileId],
      );
      expect(
        await sqlError(
          pool.query(
            "INSERT INTO file_assets (uploaded_by, kind, storage_key, original_name, mime_type, size_bytes) VALUES ($1, 'AVATAR', $2, 'a', 'image/png', 1)",
            [user.id, rows[0].storage_key],
          ),
        ),
      ).toMatchObject({ constraint: 'file_assets_storage_key_key' });
    });

    it('a Google identity belongs to one user, and one user has one Google identity', async () => {
      const a = await createUser(pool);
      const b = await createUser(pool);
      await pool.query(
        "INSERT INTO auth_identities (user_id, provider, provider_account_id) VALUES ($1, 'GOOGLE', 'sub-1')",
        [a.id],
      );
      expect(
        await sqlError(
          pool.query(
            "INSERT INTO auth_identities (user_id, provider, provider_account_id) VALUES ($1, 'GOOGLE', 'sub-1')",
            [b.id],
          ),
        ),
      ).toMatchObject({
        constraint: 'auth_identities_provider_provider_account_id_key',
      });
      expect(
        await sqlError(
          pool.query(
            "INSERT INTO auth_identities (user_id, provider, provider_account_id) VALUES ($1, 'GOOGLE', 'sub-2')",
            [a.id],
          ),
        ),
      ).toMatchObject({ constraint: 'auth_identities_user_id_provider_key' });
    });
  });

  // ---- hand-written CHECK constraints --------------------------------------------------------------------------------

  describe('CHECK constraints', () => {
    it('UserRole: decided_by without decided_at (and the reverse) is rejected; both or neither is accepted', async () => {
      const user = await createUser(pool);
      const decider = await createAdmin(pool);
      const insert = (
        decidedBy: string | null,
        decidedAt: Date | null,
        role: string,
      ) =>
        pool.query(
          "INSERT INTO user_roles (user_id, role, status, decided_by, decided_at) VALUES ($1, $2, 'ACTIVE', $3, $4)",
          [user.id, role, decidedBy, decidedAt],
        );

      expect(await sqlError(insert(decider.id, null, 'TEACHER'))).toMatchObject(
        {
          sqlstate: SQLSTATE.CHECK_VIOLATION,
          constraint: 'user_roles_decided_pair',
        },
      );
      expect(await sqlError(insert(null, new Date(), 'TEACHER'))).toMatchObject(
        {
          sqlstate: SQLSTATE.CHECK_VIOLATION,
          constraint: 'user_roles_decided_pair',
        },
      );
      await insert(decider.id, new Date(), 'TEACHER');
      await insert(null, null, 'STUDENT');

      // the same rule on UPDATE
      expect(
        await sqlError(
          pool.query(
            "UPDATE user_roles SET decided_by = NULL WHERE user_id = $1 AND role = 'TEACHER'",
            [user.id],
          ),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'user_roles_decided_pair',
      });
    });

    it('RefreshToken: a family cannot end more than 90 days after it started (boundary included, one second more rejected)', async () => {
      expect(TIME_LIMITS.REFRESH_FAMILY_MAX_AGE_DAYS).toBe(90); // the SQL literal and the shared constant agree
      const user = await createUser(pool);
      const start = new Date('2026-01-01T00:00:00Z');
      const days = (n: number, extraMs = 0) =>
        new Date(start.getTime() + n * DAY_MS + extraMs);

      await createRefreshToken(pool, user.id, {
        familyStartedAt: start,
        expiresAt: days(90),
      });
      expect(
        await sqlError(
          createRefreshToken(pool, user.id, {
            familyStartedAt: start,
            expiresAt: days(90, 1000),
          }),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'refresh_tokens_family_age',
      });
      expect(
        await sqlError(
          createRefreshToken(pool, user.id, {
            familyStartedAt: start,
            expiresAt: days(91),
          }),
        ),
      ).toMatchObject({ constraint: 'refresh_tokens_family_age' });

      // rotating inside the family keeps the same family_started_at, so a later token cannot extend past the cap
      const id = await createRefreshToken(pool, user.id, {
        familyStartedAt: start,
        expiresAt: days(30),
      });
      expect(
        await sqlError(
          pool.query(
            'UPDATE refresh_tokens SET expires_at = $2 WHERE id = $1',
            [id, days(100)],
          ),
        ),
      ).toMatchObject({ constraint: 'refresh_tokens_family_age' });
    });

    it('FileAsset: size_bytes = 0 and negative sizes are rejected; 1 byte and large files are accepted', async () => {
      const user = await createUser(pool);
      expect(
        await sqlError(createFile(pool, user.id, { sizeBytes: 0 })),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'file_assets_size_positive',
      });
      expect(
        await sqlError(createFile(pool, user.id, { sizeBytes: -5 })),
      ).toMatchObject({ constraint: 'file_assets_size_positive' });
      await createFile(pool, user.id, { sizeBytes: 1 });
      await createFile(pool, user.id, { sizeBytes: 5_000_000_000 }); // larger than int4: the column is bigint
    });

    it('Block: blocking yourself is rejected; blocking twice is rejected; blocking each other is two different rows', async () => {
      const a = await createUser(pool);
      const b = await createUser(pool);
      expect(
        await sqlError(
          pool.query(
            'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $1)',
            [a.id],
          ),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'blocks_no_self_block',
      });
      await pool.query(
        'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)',
        [a.id, b.id],
      );
      expect(
        await sqlError(
          pool.query(
            'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)',
            [a.id, b.id],
          ),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'blocks_pkey',
      });
      await pool.query(
        'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)',
        [b.id, a.id],
      );
    });

    it('Block: deleting a user removes the blocks in both directions (CASCADE)', async () => {
      const a = await createUser(pool);
      const b = await createUser(pool);
      await pool.query(
        'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2), ($2, $1)',
        [a.id, b.id],
      );
      await pool.query('DELETE FROM users WHERE id = $1', [a.id]);
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM blocks',
      );
      expect(rows[0].n).toBe(0);
    });
  });

  // ---- the audit trigger ---------------------------------------------------------------------------------------------

  describe('AuditLog immutability trigger', () => {
    it('INSERT works; UPDATE and DELETE are rejected by the trigger and leave the row untouched', async () => {
      const admin = await createAdmin(pool);
      const id = await createAuditEntry(pool, admin.id, {
        action: 'USER_SUSPENDED',
        metadata: { reason: 'spam' },
      });

      const update = await sqlError(
        pool.query("UPDATE audit_logs SET action = 'TAMPERED' WHERE id = $1", [
          id,
        ]),
      );
      expect(update).toMatchObject({ sqlstate: SQLSTATE.RAISE_EXCEPTION });
      expect(update.message).toContain('audit_logs is immutable: UPDATE');
      const del = await sqlError(
        pool.query('DELETE FROM audit_logs WHERE id = $1', [id]),
      );
      expect(del).toMatchObject({ sqlstate: SQLSTATE.RAISE_EXCEPTION });
      expect(del.message).toContain('audit_logs is immutable: DELETE');

      const { rows } = await pool.query<{
        action: string;
        metadata: { reason: string };
      }>('SELECT action, metadata FROM audit_logs WHERE id = $1', [id]);
      expect(rows).toEqual([
        { action: 'USER_SUSPENDED', metadata: { reason: 'spam' } },
      ]);
    });

    it('a bulk UPDATE or DELETE is rejected as a whole, even when it also matches no protected row first', async () => {
      const admin = await createAdmin(pool);
      await createAuditEntry(pool, admin.id);
      await createAuditEntry(pool, admin.id);
      expect(
        await sqlError(
          pool.query("UPDATE audit_logs SET metadata = '{}'::jsonb"),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.RAISE_EXCEPTION });
      expect(
        await sqlError(pool.query('DELETE FROM audit_logs')),
      ).toMatchObject({ sqlstate: SQLSTATE.RAISE_EXCEPTION });
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM audit_logs',
      );
      expect(rows[0].n).toBe(2);
    });

    it('the actor cannot be deleted while audit rows reference them (AuditLog -> User is RESTRICT)', async () => {
      const admin = await createAdmin(pool);
      await createAuditEntry(pool, admin.id);
      expect(
        await sqlError(
          pool.query('DELETE FROM users WHERE id = $1', [admin.id]),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.RESTRICT_VIOLATION });
    });
  });

  // ---- User <-> FileAsset circular reference ------------------------------------------------------------------------

  describe('User <-> FileAsset circular reference (created in one migration)', () => {
    it('a user can upload a file and use it as the avatar; the file cannot be deleted while it is the avatar', async () => {
      const user = await createUser(pool);
      const fileId = await createFile(pool, user.id, { kind: 'AVATAR' });
      await pool.query('UPDATE users SET avatar_file_id = $2 WHERE id = $1', [
        user.id,
        fileId,
      ]);

      expect(
        await sqlError(
          pool.query('DELETE FROM file_assets WHERE id = $1', [fileId]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.RESTRICT_VIOLATION,
        constraint: 'users_avatar_file_id_fkey',
      });
      expect(
        await sqlError(
          pool.query('DELETE FROM users WHERE id = $1', [user.id]),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.RESTRICT_VIOLATION });
    });

    it('both foreign keys reject unknown ids', async () => {
      const user = await createUser(pool);
      const unknown = '00000000-0000-7000-8000-000000000000';
      expect(
        await sqlError(
          pool.query('UPDATE users SET avatar_file_id = $2 WHERE id = $1', [
            user.id,
            unknown,
          ]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION,
        constraint: 'users_avatar_file_id_fkey',
      });
      expect(await sqlError(createFile(pool, unknown))).toMatchObject({
        sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION,
        constraint: 'file_assets_uploaded_by_fkey',
      });
    });
  });

  // ---- hand-written / declared indexes actually work ---------------------------------------------------------------

  describe('indexes', () => {
    it('the trigram GIN index on users.full_name exists and serves similarity search, including Armenian names', async () => {
      await createUser(pool, { fullName: 'Gor Hakobyan' });
      await createUser(pool, { fullName: 'Գոռ Հակոբյան' });
      await createUser(pool, { fullName: 'Anna Petrosyan' });

      const def = await pool.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'users_full_name_trgm_idx'",
      );
      expect(def.rows[0].indexdef).toMatch(
        /USING gin \(full_name gin_trgm_ops\)/,
      );

      const hits = await pool.query<{ full_name: string }>(
        "SELECT full_name FROM users WHERE full_name % 'Գոռ Հակոբյան' ORDER BY full_name",
      );
      expect(hits.rows.map((r) => r.full_name)).toEqual(['Գոռ Հակոբյան']);

      const tx = await openTx(pool, 'explain-trigram');
      try {
        await tx.client.query('SET LOCAL enable_seqscan = off');
        const plan = await tx.client.query<{ 'QUERY PLAN': string }>(
          "EXPLAIN SELECT id FROM users WHERE full_name % 'Gor'",
        );
        expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
          'users_full_name_trgm_idx',
        );
      } finally {
        await tx.release('rollback');
      }
    });

    it('the avatar index is partial (only users that have an avatar) and is used for avatar lookups', async () => {
      const def = await pool.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'users_avatar_file_id_idx'",
      );
      expect(def.rows[0].indexdef).toMatch(
        /WHERE \(avatar_file_id IS NOT NULL\)/,
      );
      const tx = await openTx(pool, 'explain-avatar');
      try {
        await tx.client.query('SET LOCAL enable_seqscan = off');
        const plan = await tx.client.query<{ 'QUERY PLAN': string }>(
          "EXPLAIN SELECT 1 FROM users WHERE avatar_file_id = '00000000-0000-7000-8000-000000000000'",
        );
        expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
          'users_avatar_file_id_idx',
        );
      } finally {
        await tx.release('rollback');
      }
    });
  });

  // ---- concurrency on a real constraint (parallel-transaction helper) -----------------------------------------------

  describe('concurrency', () => {
    it('two transactions inserting the same email: the second waits for the first, then fails (commit) or succeeds (rollback)', async () => {
      for (const outcome of ['commit', 'rollback'] as const) {
        await resetData(pool);
        const first = await openTx(pool, `insert-email (${outcome})`);
        const second = await openTx(pool, `insert-same-email (${outcome})`);
        const insert =
          "INSERT INTO users (email, full_name) VALUES ('race@example.test', 'Race')";
        await first.client.query(insert);
        const pending = startStatement(second, insert);
        await awaitBlockedBy(pool, second.pid, first.pid);
        await sleep(100);
        expect(pending.isSettled()).toBe(false);
        await first.release(outcome);
        if (outcome === 'commit') {
          await expect(pending.promise).rejects.toMatchObject({
            code: SQLSTATE.UNIQUE_VIOLATION,
            constraint: 'users_email_key',
          });
        } else {
          expect((await pending.promise).rowCount).toBe(1);
        }
        await second.release('rollback');
      }
    });

    it('10 parallel registrations of the same email: exactly one row, the rest are unique violations (no duplicate ever)', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          pool.query(
            "INSERT INTO users (email, full_name) VALUES ('many@example.test', 'Many')",
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter(
        (x): x is PromiseRejectedResult => x.status === 'rejected',
      )) {
        expect(r.reason).toMatchObject({ code: SQLSTATE.UNIQUE_VIOLATION });
      }
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM users WHERE email = 'many@example.test'",
      );
      expect(rows[0].n).toBe(1);
    });
  });

  // ---- replay and drift ----------------------------------------------------------------------------------------------

  describe('migration replay and drift', () => {
    const prisma = join(backendDir, 'node_modules/prisma/build/index.js');
    const prismaDiff = (args: string[], databaseUrl: string) =>
      run(
        process.execPath,
        [prisma, 'migrate', 'diff', ...args, '--script', '--exit-code'],
        {
          cwd: backendDir,
          env: { ...process.env, DATABASE_URL: databaseUrl },
        },
      );

    it('replaying all migrations on a fresh database gives exactly the schema of the test database', async () => {
      const original = await schemaFingerprint(pool);
      await buildDatabaseNamed(TEST_SHADOW_DATABASE); // drops and recreates the shadow database, then applies every migration
      const replay = new pg.Pool({
        connectionString: testShadowDatabaseUrl(),
        max: 2,
      });
      try {
        expect(await schemaFingerprint(replay)).toEqual(original);
        expect(original.length).toBeGreaterThan(100);
      } finally {
        await replay.end();
      }
    }, 60_000);

    it('Prisma reports no drift between the migration history and prisma/schema (shadow-database replay)', async () => {
      const { stdout } = await prismaDiff(
        [
          '--from-migrations',
          'prisma/migrations',
          '--to-schema',
          'prisma/schema',
        ],
        testDatabaseUrl(),
      );
      expect(stdout).toContain('This is an empty migration');
    }, 60_000);

    it('Prisma reports no drift between the live test database and prisma/schema', async () => {
      const { stdout } = await prismaDiff(
        ['--from-config-datasource', '--to-schema', 'prisma/schema'],
        testDatabaseUrl(),
      );
      expect(stdout).toContain('This is an empty migration');
    }, 60_000);

    it('drift detection is not blind: an extra column in the live database makes the check fail', async () => {
      await pool.query('ALTER TABLE users ADD COLUMN drift_probe integer');
      try {
        await expect(
          prismaDiff(
            ['--from-config-datasource', '--to-schema', 'prisma/schema'],
            testDatabaseUrl(),
          ),
        ).rejects.toMatchObject({ code: 2 });
      } finally {
        await pool.query('ALTER TABLE users DROP COLUMN drift_probe');
      }
    }, 60_000);
  });
});
