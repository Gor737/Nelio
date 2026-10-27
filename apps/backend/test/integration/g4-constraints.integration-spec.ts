// M7 constraint tests for schema group G4 (Enrollment, Invitation, LessonCompletion) against a real PostgreSQL database built
// from the migration files. Every hand-written object (Decision 102) has a test that tries to break it.
import { createPool, resetData } from '../support/database.js';
import { createTeacher, createUser } from '../support/factories.js';
import { createCourse } from '../support/factories-courses.js';
import {
  createCourseTree,
  createLesson,
  createSection,
} from '../support/factories-content.js';
import {
  createCompletion,
  createEnrollment,
  createInvitation,
} from '../support/factories-learning.js';
import { SQLSTATE, sqlError } from '../support/sql.js';

describe('G4 schema (real PostgreSQL, built from migrations)', () => {
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

  /** A course with a section and a lesson, plus a student enrolled (ACTIVE) in it. */
  async function setup() {
    const tree = await createCourseTree(pool, createCourse);
    const student = await createUser(pool);
    const enrollmentId = await createEnrollment(
      pool,
      tree.courseId,
      student.id,
    );
    return { ...tree, student, enrollmentId };
  }

  describe('structure', () => {
    it('has the three G4 tables and the status enums', async () => {
      const tables = (
        await pool.query<{ n: string }>(
          "SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'",
        )
      ).rows.map((r) => r.n);
      for (const t of ['enrollments', 'invitations', 'lesson_completions'])
        expect(tables).toContain(t);
      const enums = await pool.query<{ t: string; v: string }>(
        `SELECT t.typname AS t, e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname IN ('enrollment_status', 'invitation_status') ORDER BY t.typname, e.enumsortorder`,
      );
      expect(
        enums.rows.filter((r) => r.t === 'enrollment_status').map((r) => r.v),
      ).toEqual(['PENDING', 'ACTIVE', 'LEFT', 'REJECTED', 'REMOVED']);
      expect(
        enums.rows.filter((r) => r.t === 'invitation_status').map((r) => r.v),
      ).toEqual(['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED']);
    });
  });

  // ---- Enrollment ---------------------------------------------------------------------------------------------------------

  describe('Enrollment', () => {
    it('a second enrollment of the same user in the same course is rejected', async () => {
      const { courseId, student } = await setup();
      expect(
        await sqlError(
          createEnrollment(pool, courseId, student.id, { status: 'PENDING' }),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'enrollments_course_id_user_id_key',
      });
    });

    it('the same user may enroll in other courses, and other users in the same course', async () => {
      const { courseId, student } = await setup();
      const other = await createUser(pool);
      await createEnrollment(pool, courseId, other.id);
      await createEnrollment(pool, await createCourse(pool), student.id);
    });

    it('decided_by without decided_at (and the reverse) is rejected; both together are accepted', async () => {
      const { courseId } = await setup();
      const [decider, s1, s2, s3] = [
        await createTeacher(pool),
        await createUser(pool),
        await createUser(pool),
        await createUser(pool),
      ];
      expect(
        await sqlError(
          createEnrollment(pool, courseId, s1.id, { decidedBy: decider.id }),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'enrollments_decided_pair',
      });
      expect(
        await sqlError(
          createEnrollment(pool, courseId, s2.id, { decidedAt: new Date() }),
        ),
      ).toMatchObject({
        constraint: 'enrollments_decided_pair',
      });
      await createEnrollment(pool, courseId, s3.id, {
        decidedBy: decider.id,
        decidedAt: new Date(),
      });
    });

    it('completed_at without first_activated_at is rejected; with it, accepted', async () => {
      const { courseId } = await setup();
      const [s1, s2] = [await createUser(pool), await createUser(pool)];
      expect(
        await sqlError(
          createEnrollment(pool, courseId, s1.id, {
            status: 'LEFT',
            firstActivatedAt: null,
            completedAt: new Date(),
          }),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'enrollments_completed_needs_first_activated',
      });
      await createEnrollment(pool, courseId, s2.id, {
        completedAt: new Date(),
      }); // ACTIVE default sets first_activated_at
    });

    it('setting completed_at on an enrollment that was never activated is rejected (UPDATE path)', async () => {
      const { courseId } = await setup();
      const s = await createUser(pool);
      const id = await createEnrollment(pool, courseId, s.id, {
        status: 'PENDING',
      });
      expect(
        await sqlError(
          pool.query(
            'UPDATE enrollments SET completed_at = now() WHERE id = $1',
            [id],
          ),
        ),
      ).toMatchObject({
        constraint: 'enrollments_completed_needs_first_activated',
      });
    });

    it('rejects an unknown status', async () => {
      const { courseId } = await setup();
      const s = await createUser(pool);
      expect(
        await sqlError(
          createEnrollment(pool, courseId, s.id, { status: 'BANNED' as never }),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.INVALID_TEXT_REPRESENTATION,
      });
    });

    it('a user with an enrollment cannot be deleted, nor the user who decided it (RESTRICT)', async () => {
      const { courseId, student } = await setup();
      const decider = await createTeacher(pool);
      const s2 = await createUser(pool);
      await createEnrollment(pool, courseId, s2.id, {
        decidedBy: decider.id,
        decidedAt: new Date(),
      });
      expect(
        await sqlError(
          pool.query('DELETE FROM users WHERE id = $1', [student.id]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.RESTRICT_VIOLATION,
      });
      expect(
        await sqlError(
          pool.query('DELETE FROM users WHERE id = $1', [decider.id]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.RESTRICT_VIOLATION,
      });
    });

    it('deleting a course that has an enrollment is rejected', async () => {
      const course = await createCourse(pool);
      await createEnrollment(pool, course, (await createUser(pool)).id);
      expect(
        await sqlError(
          pool.query('DELETE FROM courses WHERE id = $1', [course]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.RESTRICT_VIOLATION,
      });
    });

    it('deleting a lesson sets last_visited_lesson_id to NULL and keeps the enrollment (SET NULL)', async () => {
      const { courseId, sectionId, enrollmentId } = await setup();
      const lesson = await createLesson(pool, courseId, sectionId);
      await pool.query(
        'UPDATE enrollments SET last_visited_lesson_id = $1, last_visited_at = now() WHERE id = $2',
        [lesson, enrollmentId],
      );
      await pool.query('DELETE FROM lessons WHERE id = $1', [lesson]);
      const { rows } = await pool.query(
        'SELECT last_visited_lesson_id, last_visited_at FROM enrollments WHERE id = $1',
        [enrollmentId],
      );
      expect(rows[0].last_visited_lesson_id).toBeNull();
      expect(rows[0].last_visited_at).not.toBeNull();
    });
  });

  // ---- Invitation ---------------------------------------------------------------------------------------------------------

  describe('Invitation', () => {
    it('a second invitation of the same user to the same course is rejected (a new invite reuses the row)', async () => {
      const course = await createCourse(pool);
      const [inviter, invitee] = [
        await createTeacher(pool),
        await createUser(pool),
      ];
      await createInvitation(pool, course, invitee.id, inviter.id);
      expect(
        await sqlError(
          createInvitation(pool, course, invitee.id, inviter.id, {
            status: 'DECLINED',
          }),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'invitations_course_id_invited_user_id_key',
      });
    });

    it('re-inviting works by updating the existing row (new 7-day expiry, back to PENDING)', async () => {
      const course = await createCourse(pool);
      const [inviter, invitee] = [
        await createTeacher(pool),
        await createUser(pool),
      ];
      const id = await createInvitation(pool, course, invitee.id, inviter.id, {
        status: 'DECLINED',
      });
      await pool.query(
        "UPDATE invitations SET status = 'PENDING', expires_at = now() + interval '7 days', responded_at = NULL WHERE id = $1",
        [id],
      );
      const { rows } = await pool.query(
        'SELECT status FROM invitations WHERE id = $1',
        [id],
      );
      expect(rows).toEqual([{ status: 'PENDING' }]);
    });

    it('deleting a course that has an invitation is rejected (Decision 91 amendment)', async () => {
      const course = await createCourse(pool);
      await createInvitation(
        pool,
        course,
        (await createUser(pool)).id,
        (await createTeacher(pool)).id,
      );
      expect(
        await sqlError(
          pool.query('DELETE FROM courses WHERE id = $1', [course]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.RESTRICT_VIOLATION,
      });
    });

    it('the invitee and the inviter cannot be deleted (RESTRICT)', async () => {
      const course = await createCourse(pool);
      const [inviter, invitee] = [
        await createTeacher(pool),
        await createUser(pool),
      ];
      await createInvitation(pool, course, invitee.id, inviter.id);
      for (const user of [inviter, invitee])
        expect(
          await sqlError(
            pool.query('DELETE FROM users WHERE id = $1', [user.id]),
          ),
        ).toMatchObject({
          sqlstate: SQLSTATE.RESTRICT_VIOLATION,
        });
    });
  });

  // ---- LessonCompletion ---------------------------------------------------------------------------------------------------

  describe('LessonCompletion same-course guarantee', () => {
    it('a completion whose enrollment and lesson are in the same course is accepted', async () => {
      const { courseId, lessonId, enrollmentId } = await setup();
      await createCompletion(pool, enrollmentId, lessonId, courseId);
      expect(await count('lesson_completions')).toBe(1);
    });

    it('a completion of a lesson of ANOTHER course is rejected, whichever course_id is written', async () => {
      const a = await setup();
      const b = await createCourseTree(pool, createCourse);
      // course_id = enrollment's course: the lesson key (lesson, course A) does not exist.
      expect(
        await sqlError(
          createCompletion(pool, a.enrollmentId, b.lessonId, a.courseId),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION,
        constraint: 'lesson_completions_lesson_id_course_id_fkey',
      });
      // course_id = lesson's course: the enrollment key (enrollment, course B) does not exist.
      expect(
        await sqlError(
          createCompletion(pool, a.enrollmentId, b.lessonId, b.courseId),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION,
        constraint: 'lesson_completions_enrollment_id_course_id_fkey',
      });
    });

    it('the same lesson cannot be completed twice by one enrollment (composite primary key)', async () => {
      const { courseId, lessonId, enrollmentId } = await setup();
      await createCompletion(pool, enrollmentId, lessonId, courseId);
      expect(
        await sqlError(
          createCompletion(pool, enrollmentId, lessonId, courseId),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'lesson_completions_pkey',
      });
    });

    it('a completed lesson cannot be deleted, and an enrollment with completions cannot be deleted (RESTRICT)', async () => {
      const { courseId, lessonId, enrollmentId } = await setup();
      await createCompletion(pool, enrollmentId, lessonId, courseId);
      expect(
        await sqlError(
          pool.query('DELETE FROM lessons WHERE id = $1', [lessonId]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.RESTRICT_VIOLATION,
      });
      expect(
        await sqlError(
          pool.query('DELETE FROM enrollments WHERE id = $1', [enrollmentId]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.RESTRICT_VIOLATION,
      });
    });

    it('a lesson without completions can still be deleted', async () => {
      const { courseId, sectionId } = await setup();
      const lesson = await createLesson(pool, courseId, sectionId);
      await pool.query('DELETE FROM lessons WHERE id = $1', [lesson]);
    });

    it('moving a completed lesson to a section of the same course is allowed; to another course it is rejected anyway', async () => {
      const { courseId, lessonId, enrollmentId } = await setup();
      await createCompletion(pool, enrollmentId, lessonId, courseId);
      const sameCourseSection = await createSection(pool, courseId);
      await pool.query('UPDATE lessons SET section_id = $1 WHERE id = $2', [
        sameCourseSection,
        lessonId,
      ]);
      const otherSection = await createSection(pool, await createCourse(pool));
      expect(
        await sqlError(
          pool.query('UPDATE lessons SET section_id = $1 WHERE id = $2', [
            otherSection,
            lessonId,
          ]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION,
      });
    });

    it('completed_at defaults to now', async () => {
      const { courseId, lessonId, enrollmentId } = await setup();
      await createCompletion(pool, enrollmentId, lessonId, courseId);
      const { rows } = await pool.query<{ ok: boolean }>(
        "SELECT completed_at > now() - interval '1 minute' AS ok FROM lesson_completions",
      );
      expect(rows[0].ok).toBe(true);
    });
  });

  // ---- indexes ------------------------------------------------------------------------------------------------------------

  describe('indexes', () => {
    it('have the documented definitions', async () => {
      expect(await indexDef('enrollments_active_incomplete_idx')).toMatch(
        /\(course_id\) WHERE \(\(status = 'ACTIVE'::enrollment_status\) AND \(completed_at IS NULL\)\)/,
      );
      expect(await indexDef('enrollments_course_id_status_idx')).toContain(
        '(course_id, status)',
      );
      expect(await indexDef('enrollments_user_id_status_idx')).toContain(
        '(user_id, status)',
      );
      expect(await indexDef('enrollments_last_visited_lesson_id_idx')).toMatch(
        /\(last_visited_lesson_id\) WHERE \(last_visited_lesson_id IS NOT NULL\)/,
      );
      expect(await indexDef('enrollments_id_course_id_key')).toMatch(
        /UNIQUE INDEX .*\(id, course_id\)/,
      );
      expect(await indexDef('invitations_invited_user_id_idx')).toContain(
        '(invited_user_id)',
      );
      expect(
        await indexDef('lesson_completions_lesson_id_course_id_idx'),
      ).toContain('(lesson_id, course_id)');
    });

    it('the active-and-incomplete partial index is used for the completion recheck query', async () => {
      const { courseId } = await setup();
      for (let i = 0; i < 20; i++) {
        const u = await createUser(pool);
        await createEnrollment(pool, courseId, u.id, {
          status: i % 2 ? 'ACTIVE' : 'LEFT',
          firstActivatedAt: new Date(),
        });
      }
      await pool.query('ANALYZE enrollments');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          "EXPLAIN SELECT id FROM enrollments WHERE course_id = $1 AND status = 'ACTIVE' AND completed_at IS NULL",
          [courseId],
        );
        expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
          'enrollments_active_incomplete_idx',
        );
        await client.query('ROLLBACK');
      } finally {
        client.release(true);
      }
    });

    it('the last-visited partial index is used when a lesson is deleted (finding enrollments to NULL)', async () => {
      const { courseId, sectionId, enrollmentId } = await setup();
      const lesson = await createLesson(pool, courseId, sectionId);
      await pool.query(
        'UPDATE enrollments SET last_visited_lesson_id = $1 WHERE id = $2',
        [lesson, enrollmentId],
      );
      await pool.query('ANALYZE enrollments');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          'EXPLAIN SELECT 1 FROM enrollments WHERE last_visited_lesson_id = $1',
          [lesson],
        );
        expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
          'enrollments_last_visited_lesson_id_idx',
        );
        await client.query('ROLLBACK');
      } finally {
        client.release(true);
      }
    });
  });
});
