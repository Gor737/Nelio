// M7 constraint tests for schema group G3 (Section, Lesson, ContentBlock) against a real PostgreSQL database built from the
// migration files. Every hand-written object (Decision 102) has a test that tries to break it.
import { TEXT_LIMITS } from '../../src/common/constants/limits.js';
import { createPool, resetData } from '../support/database.js';
import { createFile, createUser } from '../support/factories.js';
import { createCourse } from '../support/factories-courses.js';
import {
  createBlock,
  createCourseTree,
  createFileBlock,
  createLesson,
  createSection,
  createTextBlock,
  createVideoBlock,
} from '../support/factories-content.js';
import { SQLSTATE, sqlError } from '../support/sql.js';

describe('G3 schema (real PostgreSQL, built from migrations)', () => {
  const pool = createPool();
  beforeEach(() => resetData(pool));
  afterAll(() => pool.end());

  const indexDef = async (name: string) =>
    (
      await pool.query<{ d: string }>(
        'SELECT indexdef AS d FROM pg_indexes WHERE schemaname = $1 AND indexname = $2',
        ['public', name],
      )
    ).rows[0]?.d;
  const count = async (table: string) =>
    (await pool.query(`SELECT 1 FROM ${table}`)).rowCount;
  const edge = (n: number) => 'x'.repeat(n);

  describe('structure', () => {
    it('has the three G3 tables', async () => {
      const { rows } = await pool.query<{ n: string }>(
        "SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'",
      );
      for (const t of ['content_blocks', 'lessons', 'sections'])
        expect(rows.map((r) => r.n)).toContain(t);
    });

    it('Section and Lesson are unique on (id, course_id): the targets of the same-course composite keys', async () => {
      expect(await indexDef('sections_id_course_id_key')).toMatch(
        /UNIQUE INDEX .*\(id, course_id\)/,
      );
      expect(await indexDef('lessons_id_course_id_key')).toMatch(
        /UNIQUE INDEX .*\(id, course_id\)/,
      );
    });
  });

  // ---- same-course guarantee --------------------------------------------------------------------------------------------

  describe('Lesson -> Section composite foreign key', () => {
    it('a lesson cannot be created in a section of another course', async () => {
      const [c1, c2] = [await createCourse(pool), await createCourse(pool)];
      const sectionOfC2 = await createSection(pool, c2);
      expect(await sqlError(createLesson(pool, c1, sectionOfC2))).toMatchObject(
        {
          sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION,
          constraint: 'lessons_section_id_course_id_fkey',
        },
      );
    });

    it('moving a lesson to a section of another course is rejected (cross-course move)', async () => {
      const [c1, c2] = [await createCourse(pool), await createCourse(pool)];
      const s1 = await createSection(pool, c1);
      const s2 = await createSection(pool, c2);
      const lesson = await createLesson(pool, c1, s1);
      expect(
        await sqlError(
          pool.query('UPDATE lessons SET section_id = $1 WHERE id = $2', [
            s2,
            lesson,
          ]),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION });
    });

    it('moving a lesson to another section of the same course succeeds', async () => {
      const course = await createCourse(pool);
      const [s1, s2] = [
        await createSection(pool, course),
        await createSection(pool, course),
      ];
      const lesson = await createLesson(pool, course, s1);
      await pool.query('UPDATE lessons SET section_id = $1 WHERE id = $2', [
        s2,
        lesson,
      ]);
      const { rows } = await pool.query(
        'SELECT section_id FROM lessons WHERE id = $1',
        [lesson],
      );
      expect(rows).toEqual([{ section_id: s2 }]);
    });

    it('changing the course_id of a lesson without moving its section is rejected', async () => {
      const [c1, c2] = [await createCourse(pool), await createCourse(pool)];
      const { lessonId } = await createCourseTree(pool, async () => c1);
      expect(
        await sqlError(
          pool.query('UPDATE lessons SET course_id = $1 WHERE id = $2', [
            c2,
            lessonId,
          ]),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION });
    });
  });

  // ---- delete behavior --------------------------------------------------------------------------------------------------

  describe('delete behavior', () => {
    it('a section that still has lessons cannot be deleted (RESTRICT); an empty one can', async () => {
      const { sectionId } = await createCourseTree(pool, createCourse);
      expect(
        await sqlError(
          pool.query('DELETE FROM sections WHERE id = $1', [sectionId]),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.RESTRICT_VIOLATION });
      const empty = await createSection(pool, await createCourse(pool));
      await pool.query('DELETE FROM sections WHERE id = $1', [empty]);
    });

    it('deleting a course that still has lessons is refused (the RESTRICT on lessons backstops a forgotten step)', async () => {
      const { courseId } = await createCourseTree(pool, createCourse);
      expect(
        await sqlError(
          pool.query('DELETE FROM courses WHERE id = $1', [courseId]),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.RESTRICT_VIOLATION });
    });

    it('the course-deletion order works: lessons, then sections (their blocks go with the lessons), then the course', async () => {
      const { courseId, lessonId } = await createCourseTree(pool, createCourse);
      await createTextBlock(pool, lessonId);
      await pool.query('DELETE FROM lessons WHERE course_id = $1', [courseId]);
      await pool.query('DELETE FROM courses WHERE id = $1', [courseId]); // sections go by CASCADE
      expect(await count('sections')).toBe(0);
      expect(await count('lessons')).toBe(0);
      expect(await count('content_blocks')).toBe(0);
    });

    it('deleting a lesson deletes its blocks (CASCADE)', async () => {
      const { lessonId } = await createCourseTree(pool, createCourse);
      await createTextBlock(pool, lessonId);
      await createVideoBlock(pool, lessonId);
      await pool.query('DELETE FROM lessons WHERE id = $1', [lessonId]);
      expect(await count('content_blocks')).toBe(0);
    });

    it('a file attached to a block cannot be deleted (RESTRICT)', async () => {
      const { lessonId } = await createCourseTree(pool, createCourse);
      const uploader = await createUser(pool);
      const file = await createFile(pool, uploader.id, {
        kind: 'LESSON_ATTACHMENT',
      });
      await createFileBlock(pool, lessonId, file);
      expect(
        await sqlError(
          pool.query('DELETE FROM file_assets WHERE id = $1', [file]),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.RESTRICT_VIOLATION });
    });
  });

  // ---- Lesson CHECK -----------------------------------------------------------------------------------------------------

  describe('Lesson CHECK', () => {
    it('a PUBLISHED lesson without first_published_at is rejected; with it, accepted; DRAFT and ARCHIVED need none', async () => {
      const course = await createCourse(pool);
      const section = await createSection(pool, course);
      expect(
        await sqlError(
          createLesson(pool, course, section, {
            status: 'PUBLISHED',
            firstPublishedAt: null,
          }),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'lessons_published_has_first_published_at',
      });
      await createLesson(pool, course, section, { status: 'PUBLISHED' });
      await createLesson(pool, course, section, { status: 'DRAFT' });
      await createLesson(pool, course, section, {
        status: 'ARCHIVED',
        firstPublishedAt: null,
      });
    });

    it('publishing a draft through UPDATE without first_published_at is rejected', async () => {
      const { lessonId } = await createCourseTree(pool, createCourse);
      expect(
        await sqlError(
          pool.query("UPDATE lessons SET status = 'PUBLISHED' WHERE id = $1", [
            lessonId,
          ]),
        ),
      ).toMatchObject({
        constraint: 'lessons_published_has_first_published_at',
      });
    });
  });

  // ---- ContentBlock CHECK -----------------------------------------------------------------------------------------------

  describe('ContentBlock columns match the type', () => {
    let lessonId: string;
    let fileId: string;
    beforeEach(async () => {
      ({ lessonId } = await createCourseTree(pool, createCourse));
      fileId = await createFile(pool, (await createUser(pool)).id, {
        kind: 'LESSON_ATTACHMENT',
      });
    });
    const rejected = (promise: Promise<unknown>) =>
      sqlError(promise).then((e) =>
        expect(e).toMatchObject({
          sqlstate: SQLSTATE.CHECK_VIOLATION,
          constraint: 'content_blocks_columns_match_type',
        }),
      );

    it('accepts one valid block of each type', async () => {
      await createTextBlock(pool, lessonId);
      await createVideoBlock(pool, lessonId);
      await createBlock(pool, lessonId, {
        type: 'VIDEO',
        videoProvider: 'VIMEO',
        videoExternalId: '123456789',
      });
      await createFileBlock(pool, lessonId, fileId);
    });

    it('rejects a VIDEO block without a provider, without an external id, and with a text body or a file', async () => {
      await rejected(
        createBlock(pool, lessonId, { type: 'VIDEO', videoExternalId: 'abc' }),
      );
      await rejected(
        createBlock(pool, lessonId, {
          type: 'VIDEO',
          videoProvider: 'YOUTUBE',
        }),
      );
      await rejected(
        createBlock(pool, lessonId, {
          type: 'VIDEO',
          videoProvider: 'YOUTUBE',
          videoExternalId: 'abc',
          textBody: 'x',
        }),
      );
      await rejected(
        createBlock(pool, lessonId, {
          type: 'VIDEO',
          videoProvider: 'YOUTUBE',
          videoExternalId: 'abc',
          fileId,
        }),
      );
    });

    it('rejects a TEXT block without a body, with a file, or with video columns', async () => {
      await rejected(createBlock(pool, lessonId, { type: 'TEXT' }));
      await rejected(
        createBlock(pool, lessonId, { type: 'TEXT', textBody: 'x', fileId }),
      );
      await rejected(
        createBlock(pool, lessonId, {
          type: 'TEXT',
          textBody: 'x',
          videoProvider: 'YOUTUBE',
        }),
      );
      await rejected(
        createBlock(pool, lessonId, {
          type: 'TEXT',
          textBody: 'x',
          videoExternalId: 'abc',
        }),
      );
    });

    it('rejects a FILE block without a file, or with text or video columns', async () => {
      await rejected(createBlock(pool, lessonId, { type: 'FILE' }));
      await rejected(
        createBlock(pool, lessonId, { type: 'FILE', fileId, textBody: 'x' }),
      );
      await rejected(
        createBlock(pool, lessonId, {
          type: 'FILE',
          fileId,
          videoProvider: 'VIMEO',
          videoExternalId: '1',
        }),
      );
    });

    it('changing the type of an existing block without changing its columns is rejected', async () => {
      const id = await createTextBlock(pool, lessonId);
      await rejected(
        pool.query("UPDATE content_blocks SET type = 'VIDEO' WHERE id = $1", [
          id,
        ]),
      );
    });

    it('one file on two blocks is rejected, also across lessons', async () => {
      await createFileBlock(pool, lessonId, fileId);
      const { lessonId: other } = await createCourseTree(pool, createCourse);
      expect(
        await sqlError(createFileBlock(pool, other, fileId)),
      ).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'content_blocks_file_id_key',
      });
    });

    it('many TEXT blocks (file_id NULL) in one lesson are fine: NULLs do not collide in the unique index', async () => {
      for (let i = 0; i < 5; i++) await createTextBlock(pool, lessonId);
      expect(await count('content_blocks')).toBe(5);
    });
  });

  // ---- text limits ------------------------------------------------------------------------------------------------------

  describe('text length CHECKs follow TEXT_LIMITS', () => {
    it.each([
      [
        'sections.title',
        TEXT_LIMITS.SECTION_TITLE,
        async (v: string) =>
          createSection(pool, await createCourse(pool), { title: v }),
        'sections_title_length',
      ],
      [
        'lessons.title',
        TEXT_LIMITS.LESSON_TITLE,
        async (v: string) => {
          const course = await createCourse(pool);
          return createLesson(pool, course, await createSection(pool, course), {
            title: v,
          });
        },
        'lessons_title_length',
      ],
      [
        'content_blocks.text_body',
        TEXT_LIMITS.TEXT_BLOCK_BODY,
        async (v: string) => {
          const { lessonId } = await createCourseTree(pool, createCourse);
          return createTextBlock(pool, lessonId, v);
        },
        'content_blocks_text_body_length',
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

    it('video_external_id must be 1-64 characters (proposed default)', async () => {
      const { lessonId } = await createCourseTree(pool, createCourse);
      const video = (id: string) =>
        createBlock(pool, lessonId, {
          type: 'VIDEO',
          videoProvider: 'YOUTUBE',
          videoExternalId: id,
        });
      await video('a');
      await video(edge(64));
      expect(await sqlError(video(''))).toMatchObject({
        constraint: 'content_blocks_video_external_id_length',
      });
      expect(await sqlError(video(edge(65)))).toMatchObject({
        constraint: 'content_blocks_video_external_id_length',
      });
    });
  });

  // ---- indexes ---------------------------------------------------------------------------------------------------------

  describe('indexes', () => {
    it('have the documented definitions', async () => {
      expect(await indexDef('lessons_published_course_idx')).toMatch(
        /\(course_id\) WHERE \(status = 'PUBLISHED'::lesson_status\)/,
      );
      expect(await indexDef('sections_course_id_position_idx')).toContain(
        '(course_id, "position")',
      );
      expect(await indexDef('lessons_section_id_position_idx')).toContain(
        '(section_id, "position")',
      );
      expect(await indexDef('content_blocks_file_id_key')).toMatch(
        /UNIQUE INDEX .*\(file_id\)/,
      );
      expect(await indexDef('content_blocks_lesson_id_position_idx')).toContain(
        '(lesson_id, "position")',
      );
    });

    it('the published-lessons partial index is used for "published lessons of a course"', async () => {
      const course = await createCourse(pool);
      const section = await createSection(pool, course);
      for (let i = 0; i < 20; i++)
        await createLesson(pool, course, section, {
          status: i % 2 ? 'PUBLISHED' : 'DRAFT',
          position: i,
        });
      await pool.query('ANALYZE lessons');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          "EXPLAIN SELECT 1 FROM lessons WHERE course_id = $1 AND status = 'PUBLISHED'",
          [course],
        );
        expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
          'lessons_published_course_idx',
        );
        await client.query('ROLLBACK');
      } finally {
        client.release(true);
      }
    });
  });
});
