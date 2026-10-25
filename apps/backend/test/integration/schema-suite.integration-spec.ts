// M7 whole-schema checks (roadmap M7, "Whole-suite checks"): the complete inventory of the schema built from all migrations,
// the SQL limits against the M4 constants, the foreign-key actions against the Decision 91 delete-behavior table, every
// hand-written constraint and partial index of the architecture's integrity list, and replay + drift across all migrations.
// An unexpected addition fails these tests as loudly as a missing object: change the lists below in the same commit as the migration.
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { FILE_KINDS, TEXT_LIMITS } from '../../src/common/constants/limits.js';
import { LOCKABLE_TABLE_SQL_NAMES } from '../../src/common/constants/lock-tables.js';
import { createPool, resetData } from '../support/database.js';
import { createUser, createUserWithRoles } from '../support/factories.js';
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

/** The 25 entities of docs/architecture.md section 9. */
const TABLES = [
  'audit_logs',
  'auth_identities',
  'blocks',
  'categories',
  'content_blocks',
  'conversation_members',
  'conversations',
  'course_tags',
  'course_teachers',
  'courses',
  'direct_conversations',
  'email_tokens',
  'enrollments',
  'file_assets',
  'invitations',
  'lesson_completions',
  'lessons',
  'messages',
  'notifications',
  'refresh_tokens',
  'reports',
  'sections',
  'tags',
  'user_roles',
  'users',
];

const ENUMS = [
  'auth_provider',
  'content_block_type',
  'conversation_member_role',
  'conversation_type',
  'course_status',
  'course_teacher_role',
  'email_token_type',
  'enrollment_policy',
  'enrollment_status',
  'file_kind',
  'invitation_status',
  'lesson_status',
  'notification_type',
  'platform_role',
  'report_reason',
  'report_status',
  'report_target_type',
  'role_status',
  'user_status',
  'video_provider',
];

/** Every CHECK constraint (architecture section 9, "CHECK constraints"), by name. */
const CHECKS = [
  // G1
  'blocks_no_self_block',
  'file_assets_size_positive',
  'refresh_tokens_family_age',
  'user_roles_decided_pair',
  // G2
  'courses_admin_lock_needs_archived',
  'courses_non_draft_has_first_published_at',
  'courses_published_needs_category_summary',
  // G3
  'content_blocks_columns_match_type',
  'lessons_published_has_first_published_at',
  // G4
  'enrollments_completed_needs_first_activated',
  'enrollments_decided_pair',
  // G5
  'conversations_last_seq_nonneg',
  'conversations_type_shape',
  'direct_conversations_ordered_pair',
  'messages_deleted_pair',
  'reports_reviewed_pair',
  'reports_target_shape',
  // text limits (one per column that has a limit in TEXT_LIMITS, plus the proposed video-id length)
  'categories_name_length',
  'content_blocks_text_body_length',
  'content_blocks_video_external_id_length',
  'conversations_title_length',
  'courses_description_length',
  'courses_summary_length',
  'courses_title_length',
  'file_assets_original_name_length',
  'lessons_title_length',
  'messages_body_length',
  'reports_description_length',
  'reports_message_snapshot_length',
  'reports_resolution_note_length',
  'sections_title_length',
  'tags_name_length',
  'user_roles_application_message_length',
  'user_roles_decision_note_length',
  'users_email_length',
  'users_full_name_length',
];

/** Every partial index (architecture section 9, "Partial indexes"), by name. */
const PARTIAL_INDEXES = [
  'conversation_members_active_user_idx',
  'course_teachers_one_owner',
  'courses_cover_file_id_idx',
  'enrollments_active_incomplete_idx',
  'enrollments_last_visited_lesson_id_idx',
  'lessons_published_course_idx',
  'notifications_user_unread_idx',
  'reports_open_message_unique',
  'reports_open_user_unique',
  'users_avatar_file_id_idx',
];

/** Every index except primary keys and the partial indexes above (unique constraints and the "Other indexes" list). */
const OTHER_INDEXES = [
  'audit_logs_action_created_at_idx',
  'audit_logs_actor_id_created_at_idx',
  'audit_logs_target_type_target_id_created_at_idx',
  'auth_identities_provider_provider_account_id_key',
  'auth_identities_user_id_provider_key',
  'blocks_blocked_id_idx',
  'categories_slug_key',
  'content_blocks_file_id_key',
  'content_blocks_lesson_id_position_idx',
  'conversations_course_id_key',
  'course_tags_tag_id_idx',
  'course_teachers_user_id_idx',
  'courses_category_id_idx',
  'courses_search_vector_idx',
  'courses_status_first_published_at_idx',
  'direct_conversations_user_a_id_user_b_id_key',
  'email_tokens_token_hash_key',
  'email_tokens_user_id_type_idx',
  'enrollments_course_id_status_idx',
  'enrollments_course_id_user_id_key',
  'enrollments_id_course_id_key',
  'enrollments_user_id_status_idx',
  'file_assets_storage_key_key',
  'invitations_course_id_invited_user_id_key',
  'invitations_invited_user_id_idx',
  'lesson_completions_lesson_id_course_id_idx',
  'lessons_id_course_id_key',
  'lessons_section_id_position_idx',
  'messages_conversation_id_seq_key',
  'messages_sender_id_client_id_key',
  'notifications_course_id_idx',
  'notifications_user_id_created_at_idx',
  'refresh_tokens_family_id_idx',
  'refresh_tokens_token_hash_key',
  'refresh_tokens_user_id_idx',
  'reports_message_id_idx',
  'reports_status_created_at_idx',
  'reports_target_user_id_idx',
  'sections_course_id_position_idx',
  'sections_id_course_id_key',
  'tags_slug_key',
  'user_roles_role_status_idx',
  'users_email_key',
  'users_full_name_trgm_idx',
];

/**
 * Foreign-key actions, by constraint name: r = RESTRICT, c = CASCADE, n = SET NULL (Decision 91 and the delete-behavior
 * table in architecture section 8). RESTRICT is the default; CASCADE only for owned or disposable data; SET NULL only for
 * the two convenience pointers.
 */
const FK_ACTIONS: Record<string, 'r' | 'c' | 'n'> = {
  // RESTRICT: everything with business meaning, all "who and when" pairs, all FileAsset references
  audit_logs_actor_id_fkey: 'r',
  conversation_members_user_id_fkey: 'r',
  conversations_course_id_fkey: 'r',
  conversations_created_by_fkey: 'r',
  courses_category_id_fkey: 'r',
  courses_cover_file_id_fkey: 'r',
  content_blocks_file_id_fkey: 'r',
  course_teachers_added_by_fkey: 'r',
  course_teachers_user_id_fkey: 'r',
  direct_conversations_user_a_id_fkey: 'r',
  direct_conversations_user_b_id_fkey: 'r',
  enrollments_course_id_fkey: 'r',
  enrollments_decided_by_fkey: 'r',
  enrollments_user_id_fkey: 'r',
  file_assets_uploaded_by_fkey: 'r',
  invitations_course_id_fkey: 'r',
  invitations_invited_by_fkey: 'r',
  invitations_invited_user_id_fkey: 'r',
  lesson_completions_enrollment_id_course_id_fkey: 'r',
  lesson_completions_lesson_id_course_id_fkey: 'r',
  lessons_section_id_course_id_fkey: 'r',
  messages_conversation_id_fkey: 'r',
  messages_conversation_id_sender_id_fkey: 'r',
  messages_deleted_by_fkey: 'r',
  reports_message_id_fkey: 'r',
  reports_reporter_id_fkey: 'r',
  reports_reviewed_by_fkey: 'r',
  reports_target_user_id_fkey: 'r',
  user_roles_decided_by_fkey: 'r',
  user_roles_user_id_fkey: 'r',
  users_avatar_file_id_fkey: 'r',
  // CASCADE: credentials, notifications, blocks, join rows, and the owned children of a course, lesson or conversation
  auth_identities_user_id_fkey: 'c',
  blocks_blocked_id_fkey: 'c',
  blocks_blocker_id_fkey: 'c',
  content_blocks_lesson_id_fkey: 'c',
  conversation_members_conversation_id_fkey: 'c',
  course_tags_course_id_fkey: 'c',
  course_tags_tag_id_fkey: 'c',
  course_teachers_course_id_fkey: 'c',
  direct_conversations_conversation_id_fkey: 'c',
  email_tokens_user_id_fkey: 'c',
  notifications_course_id_fkey: 'c',
  notifications_user_id_fkey: 'c',
  refresh_tokens_user_id_fkey: 'c',
  sections_course_id_fkey: 'c',
  // SET NULL: convenience pointers only
  enrollments_last_visited_lesson_id_fkey: 'n',
  notifications_actor_id_fkey: 'n',
};

/** TEXT_LIMITS entry -> the CHECK that must carry the same numbers. */
const LIMIT_CONSTRAINTS: Record<string, keyof typeof TEXT_LIMITS> = {
  users_email_length: 'EMAIL',
  users_full_name_length: 'USER_FULL_NAME',
  user_roles_application_message_length: 'TEACHER_APPLICATION_MESSAGE',
  user_roles_decision_note_length: 'DECISION_NOTE',
  file_assets_original_name_length: 'FILE_ORIGINAL_NAME',
  courses_title_length: 'COURSE_TITLE',
  courses_summary_length: 'COURSE_SUMMARY',
  courses_description_length: 'COURSE_DESCRIPTION',
  sections_title_length: 'SECTION_TITLE',
  lessons_title_length: 'LESSON_TITLE',
  content_blocks_text_body_length: 'TEXT_BLOCK_BODY',
  tags_name_length: 'TAG_NAME',
  categories_name_length: 'CATEGORY_NAME',
  conversations_title_length: 'GROUP_TITLE',
  messages_body_length: 'MESSAGE_BODY',
  reports_description_length: 'REPORT_DESCRIPTION',
  reports_message_snapshot_length: 'MESSAGE_BODY', // the snapshot is a copy of a message body (Decision 77)
  reports_resolution_note_length: 'REPORT_RESOLUTION_NOTE',
};
/** TEXT_LIMITS entries that deliberately have no SQL CHECK, and why. A new entry must be mapped above or listed here. */
const LIMITS_WITHOUT_SQL: Record<string, string> = {
  PASSWORD:
    'only the Argon2id hash is stored; the length is validated before hashing',
  ADMIN_LOCK_REASON:
    'API-only: it travels in a notification snapshot and has no column',
};

describe('whole schema (real PostgreSQL, built from all migrations)', () => {
  const pool = createPool();
  beforeEach(() => resetData(pool));
  afterAll(() => pool.end());

  const names = async (sql: string) =>
    (await pool.query<{ n: string }>(sql)).rows.map((r) => r.n).sort();

  describe('inventory', () => {
    it('has exactly the 25 tables of the architecture, and the pg_trgm extension', async () => {
      expect(
        await names(
          "SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'",
        ),
      ).toEqual(TABLES);
      expect(TABLES).toHaveLength(25);
      expect(await names('SELECT extname AS n FROM pg_extension')).toContain(
        'pg_trgm',
      );
    });

    it('has exactly the expected enums', async () => {
      expect(
        await names(
          "SELECT typname AS n FROM pg_type WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace",
        ),
      ).toEqual(ENUMS);
    });

    it('has exactly the expected CHECK constraints (nothing silently added or dropped)', async () => {
      expect(
        await names(
          "SELECT conname AS n FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace",
        ),
      ).toEqual([...CHECKS].sort());
    });

    it('has exactly the expected partial indexes', async () => {
      expect(
        await names(
          `SELECT i.indexname AS n FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname JOIN pg_index x ON x.indexrelid = c.oid
            WHERE i.schemaname = 'public' AND x.indpred IS NOT NULL`,
        ),
      ).toEqual([...PARTIAL_INDEXES].sort());
    });

    it('has exactly the expected unique constraints and other indexes', async () => {
      expect(
        await names(
          `SELECT i.indexname AS n FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname JOIN pg_index x ON x.indexrelid = c.oid
            WHERE i.schemaname = 'public' AND x.indpred IS NULL AND i.indexname NOT LIKE '%\\_pkey'`,
        ),
      ).toEqual([...OTHER_INDEXES].sort());
    });

    it('every table has a primary key', async () => {
      expect(
        await names(
          `SELECT t.tablename AS n FROM pg_tables t WHERE t.schemaname = 'public'
            AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = (quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))::regclass AND c.contype = 'p')`,
        ),
      ).toEqual([]);
    });

    it('every UUID primary key named id defaults to the native uuidv7() (Decision 165)', async () => {
      const { rows } = await pool.query<{
        table_name: string;
        column_default: string | null;
      }>(
        `SELECT table_name, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'id' AND data_type = 'uuid'`,
      );
      expect(rows).toHaveLength(18); // 25 tables minus the 7 keyed by their relationship (user_roles, blocks, course_teachers, course_tags, lesson_completions, conversation_members, direct_conversations)
      for (const row of rows)
        expect([row.table_name, row.column_default]).toEqual([
          row.table_name,
          'uuidv7()',
        ]);
    });

    it('timestamps are timestamptz everywhere', async () => {
      expect(
        await names(
          "SELECT table_name || '.' || column_name AS n FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'",
        ),
      ).toEqual([]);
    });

    it('the tables named in LOCKABLE_TABLE_SQL_NAMES exist (the lock whitelist of Decision 160)', async () => {
      const tables = await names(
        "SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'",
      );
      for (const table of Object.values(LOCKABLE_TABLE_SQL_NAMES))
        expect(tables).toContain(table);
    });

    it('the file_kind enum equals FILE_KINDS', async () => {
      expect(
        await names(
          `SELECT e.enumlabel AS n FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'file_kind'`,
        ),
      ).toEqual([...FILE_KINDS].sort());
    });
  });

  describe('foreign-key actions match the Decision 91 delete-behavior table', () => {
    it('every foreign key has exactly the documented action (and every documented key exists)', async () => {
      const { rows } = await pool.query<{ n: string; a: string }>(
        `SELECT conname AS n, confdeltype AS a FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
      );
      const actual = Object.fromEntries(rows.map((r) => [r.n, r.a]));
      expect(actual).toEqual(FK_ACTIONS);
    });

    it('RESTRICT is the rule: SET NULL only on the two pointers, CASCADE on fewer than half of the keys', () => {
      const cascade = Object.values(FK_ACTIONS).filter((a) => a === 'c').length;
      const setNull = Object.entries(FK_ACTIONS)
        .filter(([, a]) => a === 'n')
        .map(([n]) => n);
      expect(setNull).toEqual([
        'enrollments_last_visited_lesson_id_fkey',
        'notifications_actor_id_fkey',
      ]);
      expect(cascade).toBeLessThan(Object.keys(FK_ACTIONS).length / 2);
    });
  });

  describe('SQL limits match the M4 constants', () => {
    const numbers = (definition: string) => ({
      min: [...definition.matchAll(/char_length\([^)]*\) >= (\d+)/g)].map((m) =>
        Number(m[1]),
      )[0],
      max: [...definition.matchAll(/char_length\([^)]*\) <= (\d+)/g)].map((m) =>
        Number(m[1]),
      )[0],
    });

    it('every TEXT_LIMITS entry is either checked in SQL or explicitly excluded', () => {
      const mapped = Object.values(LIMIT_CONSTRAINTS) as string[];
      const excluded = Object.keys(LIMITS_WITHOUT_SQL);
      expect([...new Set(mapped), ...excluded].sort()).toEqual(
        Object.keys(TEXT_LIMITS).sort(),
      );
    });

    it.each(Object.entries(LIMIT_CONSTRAINTS))(
      '%s carries the min and max of TEXT_LIMITS.%s',
      async (constraint, key) => {
        const { rows } = await pool.query<{ d: string }>(
          `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1 AND connamespace = 'public'::regnamespace`,
          [constraint],
        );
        expect(rows).toHaveLength(1);
        const { min, max } = numbers(rows[0].d);
        const limit = TEXT_LIMITS[key];
        expect(max).toBe(limit.max);
        if (limit.min > 0) expect(min).toBe(limit.min);
        else expect(min).toBeUndefined();
      },
    );
  });

  describe('G1 text limits (migration g1_text_limits) hold at both edges', () => {
    const edge = (n: number) => 'x'.repeat(n);
    const user = async (overrides: { email?: string; fullName?: string }) =>
      createUser(pool, overrides);
    const emailOf = (length: number) =>
      `${edge(length - '@e.test'.length)}@e.test`;

    it('users.email 3-254 and users.full_name 1-100', async () => {
      await user({ email: emailOf(TEXT_LIMITS.EMAIL.max) });
      await user({ email: 'a@b' });
      expect(
        await sqlError(user({ email: emailOf(TEXT_LIMITS.EMAIL.max + 1) })),
      ).toMatchObject({ constraint: 'users_email_length' });
      expect(await sqlError(user({ email: 'a@' }))).toMatchObject({
        constraint: 'users_email_length',
      });
      await user({ fullName: edge(TEXT_LIMITS.USER_FULL_NAME.max) });
      expect(
        await sqlError(
          user({ fullName: edge(TEXT_LIMITS.USER_FULL_NAME.max + 1) }),
        ),
      ).toMatchObject({ constraint: 'users_full_name_length' });
      expect(await sqlError(user({ fullName: '' }))).toMatchObject({
        constraint: 'users_full_name_length',
      });
    });

    it('user_roles.application_message 10-1000 and decision_note 1-1000 (both optional)', async () => {
      const applicant = await createUserWithRoles(pool, [
        { role: 'TEACHER', status: 'PENDING' },
      ]);
      const set = (column: string, value: string | null) =>
        pool.query(
          `UPDATE user_roles SET ${column} = $1 WHERE user_id = $2 AND role = 'TEACHER'`,
          [value, applicant.id],
        );
      await set(
        'application_message',
        edge(TEXT_LIMITS.TEACHER_APPLICATION_MESSAGE.min),
      );
      await set(
        'application_message',
        edge(TEXT_LIMITS.TEACHER_APPLICATION_MESSAGE.max),
      );
      await set('application_message', null);
      expect(
        await sqlError(
          set(
            'application_message',
            edge(TEXT_LIMITS.TEACHER_APPLICATION_MESSAGE.min - 1),
          ),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'user_roles_application_message_length',
      });
      expect(
        await sqlError(
          set(
            'application_message',
            edge(TEXT_LIMITS.TEACHER_APPLICATION_MESSAGE.max + 1),
          ),
        ),
      ).toMatchObject({
        constraint: 'user_roles_application_message_length',
      });
      await set('decision_note', edge(TEXT_LIMITS.DECISION_NOTE.max));
      expect(await sqlError(set('decision_note', ''))).toMatchObject({
        constraint: 'user_roles_decision_note_length',
      });
      expect(
        await sqlError(
          set('decision_note', edge(TEXT_LIMITS.DECISION_NOTE.max + 1)),
        ),
      ).toMatchObject({
        constraint: 'user_roles_decision_note_length',
      });
    });

    it('file_assets.original_name 1-255', async () => {
      const uploader = await createUser(pool);
      const insert = (name: string) =>
        pool.query(
          `INSERT INTO file_assets (uploaded_by, kind, storage_key, original_name, mime_type, size_bytes)
           VALUES ($1, 'AVATAR', gen_random_uuid()::text, $2, 'image/png', 1)`,
          [uploader.id, name],
        );
      await insert(edge(TEXT_LIMITS.FILE_ORIGINAL_NAME.max));
      expect(
        await sqlError(insert(edge(TEXT_LIMITS.FILE_ORIGINAL_NAME.max + 1))),
      ).toMatchObject({
        constraint: 'file_assets_original_name_length',
      });
      expect(await sqlError(insert(''))).toMatchObject({
        constraint: 'file_assets_original_name_length',
      });
    });
  });

  // ---- replay and drift ----------------------------------------------------------------------------------------------

  describe('migration replay and drift (all migrations)', () => {
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
        expect(original.length).toBeGreaterThan(300); // 25 tables: far more objects than the 100 of G1 alone
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
