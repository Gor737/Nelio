// M7 constraint tests for schema group G2 (Category, Tag, Course, CourseTeacher, CourseTag, Notification) against a real
// PostgreSQL database built from the migration files. Every hand-written object (Decision 102) has a test that tries to break it.
import { TEXT_LIMITS } from '../../src/common/constants/limits.js';
import { NOTIFICATION_TYPE_NAMES } from '../../src/common/constants/notification-types.js';
import { createPool, resetData } from '../support/database.js';
import { createFile, createTeacher, createUser } from '../support/factories.js';
import {
  addCourseTeacher,
  createCategory,
  createCourse,
  createNotification,
  createPublishedCourse,
  createTag,
} from '../support/factories-courses.js';
import { SQLSTATE, sqlError } from '../support/sql.js';

describe('G2 schema (real PostgreSQL, built from migrations)', () => {
  const pool = createPool();
  beforeEach(() => resetData(pool));
  afterAll(() => pool.end());

  const names = async (sql: string, params: unknown[] = []) =>
    (await pool.query<{ n: string }>(sql, params)).rows.map((r) => r.n).sort();
  const indexDef = async (name: string) =>
    (
      await pool.query<{ d: string }>(
        'SELECT indexdef AS d FROM pg_indexes WHERE schemaname = $1 AND indexname = $2',
        ['public', name],
      )
    ).rows[0]?.d;

  describe('structure', () => {
    it('has the six G2 tables', async () => {
      const tables = await names(
        "SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'",
      );
      for (const t of [
        'categories',
        'course_tags',
        'course_teachers',
        'courses',
        'notifications',
        'tags',
      ])
        expect(tables).toContain(t);
    });

    it('notification_type has exactly the 12 values of NOTIFICATION_TYPE_NAMES', async () => {
      const values = await names(
        `SELECT e.enumlabel AS n FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'notification_type'`,
      );
      expect(values).toEqual([...NOTIFICATION_TYPE_NAMES].sort());
    });
  });

  // ---- Course CHECKs ---------------------------------------------------------------------------------------------------

  describe('Course CHECKs', () => {
    it('a PUBLISHED course without a category is rejected', async () => {
      const error = await sqlError(
        createCourse(pool, {
          status: 'PUBLISHED',
          summary: 'A summary that is long enough',
          firstPublishedAt: new Date(),
        }),
      );
      expect(error).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'courses_published_needs_category_summary',
      });
    });

    it('a PUBLISHED course without a summary is rejected', async () => {
      const error = await sqlError(
        createCourse(pool, {
          status: 'PUBLISHED',
          categoryId: await createCategory(pool),
          firstPublishedAt: new Date(),
        }),
      );
      expect(error).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'courses_published_needs_category_summary',
      });
    });

    it('a PUBLISHED course with category, summary and first_published_at is accepted; a DRAFT needs neither', async () => {
      await expect(createPublishedCourse(pool)).resolves.toEqual(
        expect.any(String),
      );
      await expect(createCourse(pool)).resolves.toEqual(expect.any(String));
    });

    it('publishing an existing DRAFT without a category is rejected (UPDATE path)', async () => {
      const id = await createCourse(pool, { summary: 'A summary long enough' });
      const error = await sqlError(
        pool.query(
          "UPDATE courses SET status = 'PUBLISHED', first_published_at = now() WHERE id = $1",
          [id],
        ),
      );
      expect(error.constraint).toBe('courses_published_needs_category_summary');
    });

    it.each(['PUBLISHED', 'ARCHIVED'] as const)(
      'a %s course without first_published_at is rejected',
      async (status) => {
        const error = await sqlError(
          createCourse(pool, {
            status,
            summary: 'A summary that is long enough',
            categoryId: await createCategory(pool),
          }),
        );
        expect(error.sqlstate).toBe(SQLSTATE.CHECK_VIOLATION);
        expect([
          'courses_non_draft_has_first_published_at',
          'courses_published_needs_category_summary',
        ]).toContain(error.constraint);
      },
    );

    it('an ARCHIVED course without first_published_at names the right constraint', async () => {
      const error = await sqlError(createCourse(pool, { status: 'ARCHIVED' }));
      expect(error).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'courses_non_draft_has_first_published_at',
      });
    });

    it.each(['DRAFT', 'PUBLISHED'] as const)(
      'locked_by_admin_at on a %s course is rejected',
      async (status) => {
        const error = await sqlError(
          createCourse(pool, {
            status,
            lockedByAdminAt: new Date(),
            ...(status === 'PUBLISHED'
              ? {
                  summary: 'A summary that is long enough',
                  categoryId: await createCategory(pool),
                  firstPublishedAt: new Date(),
                }
              : {}),
          }),
        );
        expect(error).toMatchObject({
          sqlstate: SQLSTATE.CHECK_VIOLATION,
          constraint: 'courses_admin_lock_needs_archived',
        });
      },
    );

    it('locked_by_admin_at on an ARCHIVED course is accepted, and un-archiving a locked course is rejected', async () => {
      const id = await createCourse(pool, {
        status: 'ARCHIVED',
        firstPublishedAt: new Date(),
        archivedAt: new Date(),
        lockedByAdminAt: new Date(),
      });
      const error = await sqlError(
        pool.query("UPDATE courses SET status = 'DRAFT' WHERE id = $1", [id]),
      );
      expect(error.constraint).toBe('courses_admin_lock_needs_archived');
    });
  });

  // ---- text limits (boundaries on both sides) --------------------------------------------------------------------------

  describe('text length CHECKs follow TEXT_LIMITS', () => {
    const edge = (n: number) => 'x'.repeat(n);

    it.each([
      [
        'courses.title',
        TEXT_LIMITS.COURSE_TITLE,
        (v: string) => createCourse(pool, { title: v }),
        'courses_title_length',
      ],
      [
        'courses.summary',
        TEXT_LIMITS.COURSE_SUMMARY,
        (v: string) => createCourse(pool, { summary: v }),
        'courses_summary_length',
      ],
      [
        'categories.name',
        TEXT_LIMITS.CATEGORY_NAME,
        (v: string) => createCategory(pool, { name: v }),
        'categories_name_length',
      ],
      [
        'tags.name',
        TEXT_LIMITS.TAG_NAME,
        (v: string) => createTag(pool, { name: v }),
        'tags_name_length',
      ],
    ] as const)(
      '%s accepts min and max and rejects min-1 and max+1',
      async (_label, range, insert, constraint) => {
        await expect(insert(edge(range.min))).resolves.toEqual(
          expect.any(String),
        );
        await expect(insert(edge(range.max))).resolves.toEqual(
          expect.any(String),
        );
        expect(await sqlError(insert(edge(range.min - 1)))).toMatchObject({
          sqlstate: SQLSTATE.CHECK_VIOLATION,
          constraint,
        });
        expect(await sqlError(insert(edge(range.max + 1)))).toMatchObject({
          sqlstate: SQLSTATE.CHECK_VIOLATION,
          constraint,
        });
      },
    );

    it('courses.description accepts empty and max, rejects max+1, and counts characters, not bytes', async () => {
      const max = TEXT_LIMITS.COURSE_DESCRIPTION.max;
      await createCourse(pool, { description: '' });
      await createCourse(pool, { description: edge(max) });
      await createCourse(pool, { description: 'ա'.repeat(max) }); // Armenian: 2 bytes per character, still within the limit
      expect(
        await sqlError(createCourse(pool, { description: edge(max + 1) })),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'courses_description_length',
      });
    });

    it('optional summary and description may be NULL', async () => {
      await expect(
        createCourse(pool, { summary: null, description: null }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  // ---- one OWNER per course --------------------------------------------------------------------------------------------

  describe('CourseTeacher', () => {
    it('two OWNERs of one course are rejected', async () => {
      const [a, b] = [await createTeacher(pool), await createTeacher(pool)];
      const course = await createCourse(pool);
      await addCourseTeacher(pool, course, a.id, 'OWNER');
      const error = await sqlError(
        addCourseTeacher(pool, course, b.id, 'OWNER'),
      );
      expect(error).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'course_teachers_one_owner',
      });
    });

    it('demote-first succeeds: the old Owner becomes ASSISTANT, then the new Owner is promoted', async () => {
      const [a, b] = [await createTeacher(pool), await createTeacher(pool)];
      const course = await createCourse(pool);
      await addCourseTeacher(pool, course, a.id, 'OWNER');
      await addCourseTeacher(pool, course, b.id, 'ASSISTANT', a.id);
      await pool.query(
        "UPDATE course_teachers SET role = 'ASSISTANT' WHERE course_id = $1 AND user_id = $2",
        [course, a.id],
      );
      await pool.query(
        "UPDATE course_teachers SET role = 'OWNER' WHERE course_id = $1 AND user_id = $2",
        [course, b.id],
      );
      const { rows } = await pool.query<{ user_id: string }>(
        "SELECT user_id FROM course_teachers WHERE course_id = $1 AND role = 'OWNER'",
        [course],
      );
      expect(rows).toEqual([{ user_id: b.id }]);
    });

    it('promoting the new Owner BEFORE demoting the old one is rejected (the order matters)', async () => {
      const [a, b] = [await createTeacher(pool), await createTeacher(pool)];
      const course = await createCourse(pool);
      await addCourseTeacher(pool, course, a.id, 'OWNER');
      await addCourseTeacher(pool, course, b.id, 'ASSISTANT', a.id);
      const error = await sqlError(
        pool.query(
          "UPDATE course_teachers SET role = 'OWNER' WHERE course_id = $1 AND user_id = $2",
          [course, b.id],
        ),
      );
      expect(error.constraint).toBe('course_teachers_one_owner');
    });

    it('many ASSISTANTs are allowed; the same user twice in one course is rejected; one user may teach many courses', async () => {
      const [owner, a1, a2] = [
        await createTeacher(pool),
        await createTeacher(pool),
        await createTeacher(pool),
      ];
      const [c1, c2] = [await createCourse(pool), await createCourse(pool)];
      await addCourseTeacher(pool, c1, owner.id, 'OWNER');
      await addCourseTeacher(pool, c1, a1.id, 'ASSISTANT', owner.id);
      await addCourseTeacher(pool, c1, a2.id, 'ASSISTANT', owner.id);
      await addCourseTeacher(pool, c2, owner.id, 'OWNER');
      expect(
        await sqlError(
          addCourseTeacher(pool, c1, a1.id, 'ASSISTANT', owner.id),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.UNIQUE_VIOLATION });
    });

    it('a user who teaches a course cannot be deleted (RESTRICT), neither can the adder', async () => {
      const [owner, adder] = [
        await createTeacher(pool),
        await createTeacher(pool),
      ];
      const course = await createCourse(pool);
      await addCourseTeacher(pool, course, owner.id, 'OWNER', adder.id);
      expect(
        await sqlError(
          pool.query('DELETE FROM users WHERE id = $1', [owner.id]),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.RESTRICT_VIOLATION });
      expect(
        await sqlError(
          pool.query('DELETE FROM users WHERE id = $1', [adder.id]),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.RESTRICT_VIOLATION });
    });

    it('deleting a course deletes its team (CASCADE)', async () => {
      const owner = await createTeacher(pool);
      const course = await createCourse(pool);
      await addCourseTeacher(pool, course, owner.id, 'OWNER');
      await pool.query('DELETE FROM courses WHERE id = $1', [course]);
      const { rowCount } = await pool.query(
        'SELECT 1 FROM course_teachers WHERE course_id = $1',
        [course],
      );
      expect(rowCount).toBe(0);
    });

    it('the (user_id) index exists for "my courses" lookups', async () => {
      expect(await indexDef('course_teachers_user_id_idx')).toContain(
        '(user_id)',
      );
    });
  });

  // ---- search vector -----------------------------------------------------------------------------------------------------

  describe('Course.search_vector (generated, simple configuration)', () => {
    const matches = async (query: string) =>
      (
        await pool.query<{ id: string }>(
          `SELECT id FROM courses WHERE search_vector @@ websearch_to_tsquery('simple', $1)`,
          [query],
        )
      ).rows.map((r) => r.id);

    it('is filled from title, summary and description, and updates when the title changes', async () => {
      const id = await createCourse(pool, {
        title: 'Introduction to Postgres',
        summary: 'Learn relational databases fast',
        description: 'Covers indexing and transactions',
      });
      expect(await matches('postgres')).toEqual([id]);
      expect(await matches('relational')).toEqual([id]);
      expect(await matches('transactions')).toEqual([id]);
      expect(await matches('kubernetes')).toEqual([]);

      await pool.query(
        "UPDATE courses SET title = 'Kubernetes basics' WHERE id = $1",
        [id],
      );
      expect(await matches('kubernetes')).toEqual([id]);
      expect(await matches('postgres')).toEqual([]); // the old title no longer matches
    });

    it('matches Armenian text (simple configuration does no stemming)', async () => {
      const id = await createCourse(pool, { title: 'Ծրագրավորման հիմունքներ' });
      expect(await matches('ծրագրավորման')).toEqual([id]);
    });

    it('cannot be written directly (generated column)', async () => {
      const id = await createCourse(pool);
      const error = await sqlError(
        pool.query(
          "UPDATE courses SET search_vector = to_tsvector('simple', 'x') WHERE id = $1",
          [id],
        ),
      );
      expect(error.sqlstate).toBe('428C9'); // generated_always
    });

    it('is indexed with GIN', async () => {
      expect(await indexDef('courses_search_vector_idx')).toMatch(
        /USING gin \(search_vector\)/i,
      );
    });
  });

  // ---- delete behavior --------------------------------------------------------------------------------------------------

  describe('Course references', () => {
    it('a category in use cannot be deleted; an unused one can', async () => {
      const used = await createCategory(pool);
      const unused = await createCategory(pool);
      await createCourse(pool, { categoryId: used });
      expect(
        await sqlError(
          pool.query('DELETE FROM categories WHERE id = $1', [used]),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.RESTRICT_VIOLATION });
      await pool.query('DELETE FROM categories WHERE id = $1', [unused]);
    });

    it('a cover file in use cannot be deleted', async () => {
      const uploader = await createUser(pool);
      const file = await createFile(pool, uploader.id, {
        kind: 'COURSE_COVER',
      });
      await createCourse(pool, { coverFileId: file });
      expect(
        await sqlError(
          pool.query('DELETE FROM file_assets WHERE id = $1', [file]),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.RESTRICT_VIOLATION });
    });

    it('slugs are unique for categories and tags', async () => {
      await createCategory(pool, { slug: 'same' });
      await createTag(pool, { slug: 'same' });
      expect(
        await sqlError(createCategory(pool, { slug: 'same' })),
      ).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'categories_slug_key',
      });
      expect(await sqlError(createTag(pool, { slug: 'same' }))).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'tags_slug_key',
      });
    });
  });

  describe('CourseTag', () => {
    it('a duplicate (course, tag) is rejected; deleting the course or the tag removes the link (CASCADE)', async () => {
      const [c1, c2] = [await createCourse(pool), await createCourse(pool)];
      const tag = await createTag(pool);
      const link = (course: string) =>
        pool.query(
          'INSERT INTO course_tags (course_id, tag_id) VALUES ($1, $2)',
          [course, tag],
        );
      await link(c1);
      await link(c2);
      expect(await sqlError(link(c1))).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
      });

      await pool.query('DELETE FROM courses WHERE id = $1', [c1]);
      expect((await pool.query('SELECT 1 FROM course_tags')).rowCount).toBe(1);
      await pool.query('DELETE FROM tags WHERE id = $1', [tag]);
      expect((await pool.query('SELECT 1 FROM course_tags')).rowCount).toBe(0);
    });

    it('a link to a missing tag is rejected (the tag-merge race surfaces as a foreign-key error)', async () => {
      const course = await createCourse(pool);
      expect(
        await sqlError(
          pool.query(
            'INSERT INTO course_tags (course_id, tag_id) VALUES ($1, uuidv7())',
            [course],
          ),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION });
    });

    it('the (tag_id) index exists for "courses with this tag"', async () => {
      expect(await indexDef('course_tags_tag_id_idx')).toContain('(tag_id)');
    });
  });

  // ---- Notification ----------------------------------------------------------------------------------------------------

  describe('Notification', () => {
    it('accepts all 12 types and rejects an unknown one', async () => {
      const user = await createUser(pool);
      for (const type of NOTIFICATION_TYPE_NAMES)
        await createNotification(pool, user.id, { type });
      expect(
        await sqlError(
          createNotification(pool, user.id, { type: 'MESSAGE_RECEIVED' }),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.INVALID_TEXT_REPRESENTATION });
    });

    it('deleting the course deletes its notifications (CASCADE) and deleting the actor nulls actor_id (SET NULL)', async () => {
      const [user, actor] = [await createUser(pool), await createUser(pool)];
      const course = await createCourse(pool);
      const byCourse = await createNotification(pool, user.id, {
        courseId: course,
      });
      const byActor = await createNotification(pool, user.id, {
        actorId: actor.id,
      });
      await pool.query('DELETE FROM courses WHERE id = $1', [course]);
      expect(
        (
          await pool.query('SELECT 1 FROM notifications WHERE id = $1', [
            byCourse,
          ])
        ).rowCount,
      ).toBe(0);
      await pool.query('DELETE FROM users WHERE id = $1', [actor.id]);
      const { rows } = await pool.query(
        'SELECT actor_id FROM notifications WHERE id = $1',
        [byActor],
      );
      expect(rows).toEqual([{ actor_id: null }]);
    });

    it('deleting the recipient deletes the notification (CASCADE)', async () => {
      const user = await createUser(pool);
      await createNotification(pool, user.id);
      await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
      expect((await pool.query('SELECT 1 FROM notifications')).rowCount).toBe(
        0,
      );
    });

    it('data defaults to an empty JSON object', async () => {
      const user = await createUser(pool);
      const { rows } = await pool.query(
        `INSERT INTO notifications (user_id, type) VALUES ($1, 'LESSON_PUBLISHED') RETURNING data`,
        [user.id],
      );
      expect(rows[0].data).toEqual({});
    });
  });

  // ---- indexes (definitions and planner use) ------------------------------------------------------------------------------

  describe('indexes', () => {
    it('have the documented definitions', async () => {
      expect(await indexDef('courses_status_first_published_at_idx')).toMatch(
        /\(status, first_published_at DESC\)/,
      );
      expect(await indexDef('courses_category_id_idx')).toContain(
        '(category_id)',
      );
      expect(await indexDef('courses_cover_file_id_idx')).toMatch(
        /\(cover_file_id\) WHERE \(cover_file_id IS NOT NULL\)/,
      );
      expect(await indexDef('course_teachers_one_owner')).toMatch(
        /UNIQUE INDEX .*\(course_id\) WHERE \(role = 'OWNER'::course_teacher_role\)/,
      );
      expect(await indexDef('notifications_user_id_created_at_idx')).toMatch(
        /\(user_id, created_at DESC\)/,
      );
      expect(await indexDef('notifications_user_unread_idx')).toMatch(
        /\(user_id\) WHERE \(read_at IS NULL\)/,
      );
      expect(await indexDef('notifications_course_id_idx')).toContain(
        '(course_id)',
      );
    });

    it('the unread partial index is used for the unread query', async () => {
      const user = await createUser(pool);
      for (let i = 0; i < 20; i++)
        await createNotification(pool, user.id, {
          readAt: i % 2 ? new Date() : null,
        });
      await pool.query('ANALYZE notifications');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          'EXPLAIN SELECT 1 FROM notifications WHERE user_id = $1 AND read_at IS NULL',
          [user.id],
        );
        expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
          'notifications_user_unread_idx',
        );
        await client.query('ROLLBACK');
      } finally {
        client.release(true);
      }
    });
  });
});
