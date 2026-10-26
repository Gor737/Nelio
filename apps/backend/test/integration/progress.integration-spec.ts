// M9d: Progress against the real database: lesson completion, the permanent course-completion snapshot, rechecks and the
// single-statement progress reads (Decisions 12, 126; docs/architecture.md section 15, "Completion architecture").
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import {
  DatabaseModule,
  PrismaService,
  TransactionService,
  lockRow,
} from '../../src/infrastructure/database/index.js';
import { EventsModule } from '../../src/infrastructure/events/index.js';
import {
  CompletionService,
  ProgressModule,
  ProgressQueries,
} from '../../src/modules/progress/index.js';
import { createPool, resetData } from '../support/database.js';
import { createTeacher, createUser } from '../support/factories.js';
import { createLesson, createSection } from '../support/factories-content.js';
import {
  addCourseTeacher,
  createPublishedCourse,
} from '../support/factories-courses.js';
import {
  type EnrollmentStatusName,
  createCompletion,
  createEnrollment,
} from '../support/factories-learning.js';
import { bearer, closeApp, testEnv } from '../support/integration-app.js';
import {
  awaitBlockedBy,
  holdTx,
  releaseAll,
  settlesWithin,
} from '../support/parallel-tx.js';

const pool = createPool(20);
let app: NestExpressApplication;
let completion: CompletionService;
let queries: ProgressQueries;
let transactions: TransactionService;
let prisma: PrismaService;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      ProgressModule,
    ],
    providers: GLOBAL_PROVIDERS,
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  completion = app.get(CompletionService);
  queries = app.get(ProgressQueries);
  transactions = app.get(TransactionService);
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
beforeEach(() => resetData(pool));
afterEach(() => releaseAll());

let clientCounter = 0;
const nextClientIp = () =>
  `10.2.${(clientCounter >> 8) & 255}.${clientCounter++ & 255}`;
const putCompletion = (userId: string, courseId: string, lessonId: string) =>
  request(app.getHttpServer())
    .put(`/api/v1/courses/${courseId}/lessons/${lessonId}/completion`)
    .set('Authorization', bearer(userId))
    .set('X-Forwarded-For', nextClientIp());

interface Setup {
  courseId: string;
  ownerId: string;
  studentId: string;
  enrollmentId: string;
  lessons: string[];
}

/** A PUBLISHED course with an Owner, `lessons` PUBLISHED lessons and one ACTIVE student. */
async function setup(lessonCount = 2): Promise<Setup> {
  const courseId = await createPublishedCourse(pool);
  const owner = await createTeacher(pool);
  await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
  const sectionId = await createSection(pool, courseId);
  const lessons: string[] = [];
  for (let i = 0; i < lessonCount; i++)
    lessons.push(
      await createLesson(pool, courseId, sectionId, {
        position: i,
        status: 'PUBLISHED',
      }),
    );
  const student = await createUser(pool);
  const enrollmentId = await createEnrollment(pool, courseId, student.id);
  return {
    courseId,
    ownerId: owner.id,
    studentId: student.id,
    enrollmentId,
    lessons,
  };
}

const enrollmentOf = async (id: string) =>
  (
    await pool.query<{ completed_at: Date | null }>(
      'SELECT completed_at FROM enrollments WHERE id = $1',
      [id],
    )
  ).rows[0];
const completionCount = async (enrollmentId: string) =>
  (
    await pool.query(
      'SELECT 1 FROM lesson_completions WHERE enrollment_id = $1',
      [enrollmentId],
    )
  ).rowCount;
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; status: number };
  }
  throw new Error('expected a rejection');
};
const unpublish = (
  tx: Parameters<Parameters<TransactionService['run']>[0]>[0],
  lessonId: string,
) =>
  tx.$executeRaw`UPDATE lessons SET status = 'DRAFT', updated_at = now() WHERE id = ${lessonId}::uuid`;

describe('PUT /courses/:courseId/lessons/:lessonId/completion', () => {
  it('marks the lesson complete: 200, the completion time, no course completion yet, and the live progress', async () => {
    const s = await setup(3);
    const res = await putCompletion(
      s.studentId,
      s.courseId,
      s.lessons[0],
    ).expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'completedAt',
      'courseCompleted',
      'lessonId',
      'progress',
    ]);
    expect(res.body).toMatchObject({
      lessonId: s.lessons[0],
      courseCompleted: false,
      progress: { completedLessons: 1, totalLessons: 3, percent: 33 },
    });
    expect(await completionCount(s.enrollmentId)).toBe(1);
    expect((await enrollmentOf(s.enrollmentId)).completed_at).toBeNull();
  });

  it('is idempotent: repeating returns the same completedAt, adds no row, and never reports courseCompleted again', async () => {
    const s = await setup(1);
    const first = await putCompletion(
      s.studentId,
      s.courseId,
      s.lessons[0],
    ).expect(200);
    expect(first.body.courseCompleted).toBe(true);
    const completedAt = (await enrollmentOf(s.enrollmentId)).completed_at;
    const second = await putCompletion(
      s.studentId,
      s.courseId,
      s.lessons[0],
    ).expect(200);
    expect(second.body.completedAt).toBe(first.body.completedAt);
    expect(second.body.courseCompleted).toBe(false);
    expect(await completionCount(s.enrollmentId)).toBe(1);
    expect((await enrollmentOf(s.enrollmentId)).completed_at).toEqual(
      completedAt,
    );
  });

  it('the request that finishes the last published lesson completes the course permanently', async () => {
    const s = await setup(2);
    await putCompletion(s.studentId, s.courseId, s.lessons[0]).expect(200);
    expect((await enrollmentOf(s.enrollmentId)).completed_at).toBeNull();
    const last = await putCompletion(
      s.studentId,
      s.courseId,
      s.lessons[1],
    ).expect(200);
    expect(last.body.courseCompleted).toBe(true);
    expect(last.body.progress).toEqual({
      completedLessons: 2,
      totalLessons: 2,
      percent: 100,
    });
    expect((await enrollmentOf(s.enrollmentId)).completed_at).not.toBeNull();
  });

  it('parallel marks of the same lesson all succeed with one row', async () => {
    const s = await setup(2);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        putCompletion(s.studentId, s.courseId, s.lessons[0]),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(new Set(results.map((r) => r.body.completedAt)).size).toBe(1);
    expect(await completionCount(s.enrollmentId)).toBe(1);
  });

  it('parallel marks of the last lesson: exactly one response says courseCompleted', async () => {
    const s = await setup(1);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        putCompletion(s.studentId, s.courseId, s.lessons[0]),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(results.filter((r) => r.body.courseCompleted === true)).toHaveLength(
      1,
    );
    expect((await enrollmentOf(s.enrollmentId)).completed_at).not.toBeNull();
  });

  it('the student marking the last TWO lessons at the same moment still completes the course (neither request may miss the other)', async () => {
    for (let round = 0; round < 15; round++) {
      const s = await setup(2);
      const results = await Promise.all([
        putCompletion(s.studentId, s.courseId, s.lessons[0]),
        putCompletion(s.studentId, s.courseId, s.lessons[1]),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect((await enrollmentOf(s.enrollmentId)).completed_at).not.toBeNull();
      expect(
        results.filter((r) => r.body.courseCompleted === true),
      ).toHaveLength(1);
    }
  }, 60_000);

  it('only an ACTIVE student may mark: nobody else, whatever their relationship to the course', async () => {
    const s = await setup(1);
    const outsider = await createUser(pool);
    await putCompletion(outsider.id, s.courseId, s.lessons[0]).expect(403); // published course: visible, not a student
    await putCompletion(s.ownerId, s.courseId, s.lessons[0]).expect(403);
    for (const status of [
      'PENDING',
      'LEFT',
      'REMOVED',
      'REJECTED',
    ] as EnrollmentStatusName[]) {
      const user = await createUser(pool);
      await createEnrollment(pool, s.courseId, user.id, { status });
      const res = await putCompletion(user.id, s.courseId, s.lessons[0]);
      expect([403, 404]).toContain(res.status);
    }
    await request(app.getHttpServer())
      .put(`/api/v1/courses/${s.courseId}/lessons/${s.lessons[0]}/completion`)
      .expect(401);
    expect(
      (await pool.query('SELECT 1 FROM lesson_completions')).rowCount,
    ).toBe(0);
  });

  it('the lesson must exist in THIS course and be PUBLISHED: a draft, archived, foreign or missing lesson is 404 and stores nothing', async () => {
    const s = await setup(1);
    const section = (
      await pool.query<{ id: string }>(
        'SELECT id FROM sections WHERE course_id = $1',
        [s.courseId],
      )
    ).rows[0].id;
    const draft = await createLesson(pool, s.courseId, section, {
      position: 5,
      status: 'DRAFT',
    });
    const archived = await createLesson(pool, s.courseId, section, {
      position: 6,
      status: 'ARCHIVED',
    });
    const other = await setup(1);
    for (const lessonId of [
      draft,
      archived,
      other.lessons[0],
      '019d0000-0000-7000-8000-000000000000',
    ])
      await putCompletion(s.studentId, s.courseId, lessonId).expect(404);
    await putCompletion(s.studentId, s.courseId, 'nope').expect(400);
    await putCompletion(s.studentId, 'nope', s.lessons[0]).expect(400);
    expect(await completionCount(s.enrollmentId)).toBe(0);
  });

  it('an unknown course is 404', async () => {
    const s = await setup(1);
    await putCompletion(
      s.studentId,
      '019d0000-0000-7000-8000-000000000000',
      s.lessons[0],
    ).expect(404);
  });

  it('works on an archived course (an ACTIVE student keeps their learning), and is refused while an Admin has locked it', async () => {
    const s = await setup(2);
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now() WHERE id = $1",
      [s.courseId],
    );
    await putCompletion(s.studentId, s.courseId, s.lessons[0]).expect(200);
    await pool.query(
      'UPDATE courses SET locked_by_admin_at = now() WHERE id = $1',
      [s.courseId],
    );
    const res = await putCompletion(
      s.studentId,
      s.courseId,
      s.lessons[1],
    ).expect(403);
    expect(res.body.code).toBe('COURSE_ADMIN_LOCKED');
    expect(await completionCount(s.enrollmentId)).toBe(1);
  });
});

describe('completion is a permanent snapshot, separate from the live percent', () => {
  it('a lesson published after completion lowers the percent but never un-completes; a later mark does not move completed_at', async () => {
    const s = await setup(2);
    for (const lesson of s.lessons)
      await putCompletion(s.studentId, s.courseId, lesson).expect(200);
    const snapshot = (await enrollmentOf(s.enrollmentId)).completed_at;
    expect(snapshot).not.toBeNull();
    const section = (
      await pool.query<{ id: string }>(
        'SELECT id FROM sections WHERE course_id = $1',
        [s.courseId],
      )
    ).rows[0].id;
    const added = await createLesson(pool, s.courseId, section, {
      position: 9,
      status: 'PUBLISHED',
    });
    expect((await queries.summary(s.enrollmentId))?.percent).toBe(66);
    expect((await enrollmentOf(s.enrollmentId)).completed_at).toEqual(snapshot);
    const res = await putCompletion(s.studentId, s.courseId, added).expect(200);
    expect(res.body.courseCompleted).toBe(false); // already completed: not this request
    expect(res.body.progress.percent).toBe(100);
    expect((await enrollmentOf(s.enrollmentId)).completed_at).toEqual(snapshot);
    await pool.query(
      "UPDATE lessons SET status = 'DRAFT' WHERE id = ANY($1::uuid[])",
      [s.lessons],
    );
    await transactions.run(async (tx) => {
      await lockRow(tx, 'course', s.courseId, 'NO_KEY_UPDATE');
      await completion.recheckCourse(tx, s.courseId);
    });
    expect((await enrollmentOf(s.enrollmentId)).completed_at).toEqual(snapshot);
  });
});

describe('recheckEnrollment and recheckCourse', () => {
  it('complete an ACTIVE enrollment that has finished every published lesson; the returned flag is the conditional update row count', async () => {
    const s = await setup(2);
    for (const lesson of s.lessons)
      await createCompletion(pool, s.enrollmentId, lesson, s.courseId);
    const flags = await transactions.run(async (tx) => {
      await lockRow(tx, 'course', s.courseId, 'SHARE');
      return [
        await completion.recheckEnrollment(tx, s.enrollmentId),
        await completion.recheckEnrollment(tx, s.enrollmentId),
      ];
    });
    expect(flags).toEqual([true, false]);
    expect((await enrollmentOf(s.enrollmentId)).completed_at).not.toBeNull();
  });

  it('never complete a course with no published lesson, even if the student has completed lessons that are no longer published', async () => {
    const s = await setup(2);
    for (const lesson of s.lessons)
      await createCompletion(pool, s.enrollmentId, lesson, s.courseId);
    await pool.query(
      "UPDATE lessons SET status = 'DRAFT' WHERE course_id = $1",
      [s.courseId],
    );
    const flag = await transactions.run(async (tx) => {
      await lockRow(tx, 'course', s.courseId, 'NO_KEY_UPDATE');
      const one = await completion.recheckEnrollment(tx, s.enrollmentId);
      const many = await completion.recheckCourse(tx, s.courseId);
      return { one, many };
    });
    expect(flag).toEqual({ one: false, many: [] });
    expect((await enrollmentOf(s.enrollmentId)).completed_at).toBeNull();
  });

  it('recheckCourse completes only ACTIVE, incomplete, eligible enrollments and leaves every other row alone', async () => {
    const s = await setup(2);
    const make = async (
      status: EnrollmentStatusName,
      done: boolean,
      completedAt: Date | null = null,
    ) => {
      const user = await createUser(pool);
      const id = await createEnrollment(pool, s.courseId, user.id, {
        status,
        completedAt,
        ...(status === 'LEFT' ? { leftAt: new Date() } : {}),
        ...(status === 'PENDING' ? { firstActivatedAt: null } : {}),
      });
      if (done)
        for (const lesson of s.lessons)
          await createCompletion(pool, id, lesson, s.courseId);
      return id;
    };
    // `createEnrollment` of an ACTIVE row is the student of `setup`: give it one lesson only (not eligible)
    await createCompletion(pool, s.enrollmentId, s.lessons[0], s.courseId);
    const eligible = await make('ACTIVE', true);
    const left = await make('LEFT', true);
    const removed = await make('REMOVED', true);
    const pending = await make('PENDING', true);
    const already = new Date('2026-01-02T03:04:05Z');
    const completedBefore = await make('ACTIVE', true, already);
    const completedIds = await transactions.run(async (tx) => {
      await lockRow(tx, 'course', s.courseId, 'NO_KEY_UPDATE');
      return completion.recheckCourse(tx, s.courseId);
    });
    expect(completedIds).toEqual([eligible]);
    expect((await enrollmentOf(eligible)).completed_at).not.toBeNull();
    for (const id of [s.enrollmentId, left, removed, pending])
      expect((await enrollmentOf(id)).completed_at).toBeNull();
    expect((await enrollmentOf(completedBefore)).completed_at).toEqual(already);
  });

  it('recheckAllCourses (the nightly sweep) completes the eligible ones in every course and reports the counts', async () => {
    const a = await setup(1);
    const b = await setup(1);
    const idle = await setup(1);
    await createCompletion(pool, a.enrollmentId, a.lessons[0], a.courseId);
    await createCompletion(pool, b.enrollmentId, b.lessons[0], b.courseId);
    const result = await completion.recheckAllCourses();
    expect(result.enrollmentsCompleted).toBe(2);
    expect(result.coursesChecked).toBe(3);
    expect((await enrollmentOf(a.enrollmentId)).completed_at).not.toBeNull();
    expect((await enrollmentOf(b.enrollmentId)).completed_at).not.toBeNull();
    expect((await enrollmentOf(idle.enrollmentId)).completed_at).toBeNull();
    expect(await completion.recheckAllCourses()).toEqual({
      coursesChecked: 1,
      enrollmentsCompleted: 0,
    });
  });
});

describe('Bug 1: a student finishing while a teacher unpublishes the lesson they had not finished', () => {
  it('Course-S (mark) and Course-X (unpublish) exclude each other, so the course ends up completed (teacher commits first, student arrives mid-way)', async () => {
    const s = await setup(3);
    const [a, b, c] = s.lessons;
    await createCompletion(pool, s.enrollmentId, a, s.courseId);
    let release!: () => void;
    let teacherRechecked!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<void>((resolve) => (teacherRechecked = resolve));
    // the teacher unpublishes C and re-checks BEFORE the student's completion exists, then keeps the transaction open
    const teacher = transactions.run(async (tx) => {
      await lockRow(tx, 'course', s.courseId, 'NO_KEY_UPDATE');
      await unpublish(tx, c);
      await completion.recheckCourse(tx, s.courseId);
      teacherRechecked();
      await gate;
    });
    await ready;
    const student = completion.markComplete(s.studentId, s.courseId, b);
    // without the Course-S lock the student would finish right away, see C still published, and nobody would ever re-check
    expect(await settlesWithin(student, 400)).toBe(false);
    release();
    const [, result] = await Promise.all([teacher, student]);
    expect(result.courseCompleted).toBe(true);
    expect((await enrollmentOf(s.enrollmentId)).completed_at).not.toBeNull();
  });

  it('whichever of the two runs first, the course ends up completed (25 real races)', async () => {
    for (let round = 0; round < 25; round++) {
      const s = await setup(3);
      const [a, b, c] = s.lessons;
      await createCompletion(pool, s.enrollmentId, a, s.courseId);
      await Promise.all([
        completion.markComplete(s.studentId, s.courseId, b),
        transactions.run(async (tx) => {
          await lockRow(tx, 'course', s.courseId, 'NO_KEY_UPDATE');
          await unpublish(tx, c);
          await completion.recheckCourse(tx, s.courseId);
        }),
      ]);
      expect((await enrollmentOf(s.enrollmentId)).completed_at).not.toBeNull();
    }
  }, 60_000);
});

describe('a student removed at the moment they mark a lesson', () => {
  it('the removal holds the Enrollment row; the mark waits for it, then is refused (403) and stores nothing', async () => {
    const s = await setup(2);
    const removal = await holdTx(
      pool,
      'removal',
      'SELECT 1 FROM enrollments WHERE id = $1 FOR NO KEY UPDATE',
      [s.enrollmentId],
    );
    await removal.client.query(
      "UPDATE enrollments SET status = 'REMOVED', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = $1",
      [s.enrollmentId, s.ownerId],
    );
    const mark = completion.markComplete(s.studentId, s.courseId, s.lessons[0]);
    const outcome = rejection(mark);
    expect(await settlesWithin(mark, 400)).toBe(false);
    await removal.release('commit');
    expect((await outcome).code).toBe('FORBIDDEN');
    expect(await completionCount(s.enrollmentId)).toBe(0);
  });

  it('the mark that holds the Enrollment row first makes the removal wait for it (the lesson counts, then the removal proceeds)', async () => {
    const s = await setup(2);
    const marking = await holdTx(
      pool,
      'marking',
      'SELECT 1 FROM enrollments WHERE id = $1 FOR SHARE',
      [s.enrollmentId],
    );
    await marking.client.query(
      'INSERT INTO lesson_completions (enrollment_id, lesson_id, course_id) VALUES ($1, $2, $3)',
      [s.enrollmentId, s.lessons[0], s.courseId],
    );
    const removal = await holdTx(pool, 'removal-2', 'SELECT 1', []);
    const removalStatement = removal.client.query(
      "UPDATE enrollments SET status = 'REMOVED', decided_by = $2, decided_at = now(), updated_at = now() WHERE id = $1",
      [s.enrollmentId, s.ownerId],
    );
    removalStatement.catch(() => undefined);
    await awaitBlockedBy(pool, removal.pid, marking.pid);
    await marking.release('commit');
    await removalStatement;
    await removal.release('commit');
    expect(await completionCount(s.enrollmentId)).toBe(1);
  });
});

describe('ProgressQueries', () => {
  const countingDb = () => {
    const calls: number[] = [];
    const db = {
      $queryRaw: ((...args: Parameters<PrismaService['$queryRaw']>) => {
        calls.push(1);
        return prisma.$queryRaw(...args);
      }) as PrismaService['$queryRaw'],
    };
    return { db, calls };
  };

  it('the summary of MANY enrollments is ONE statement', async () => {
    const s = await setup(3);
    const ids = [s.enrollmentId];
    for (let i = 0; i < 11; i++)
      ids.push(
        await createEnrollment(pool, s.courseId, (await createUser(pool)).id),
      );
    const { db, calls } = countingDb();
    const result = await queries.summaries(ids, db);
    expect(calls).toHaveLength(1);
    expect(result.size).toBe(12);
    expect(
      await (async () => {
        const c = countingDb();
        await queries.summary(s.enrollmentId, c.db);
        return c.calls;
      })(),
    ).toHaveLength(1);
  });

  it('counts only lessons published now: a completed lesson that was unpublished stops counting, a new one raises the total', async () => {
    const s = await setup(3);
    await createCompletion(pool, s.enrollmentId, s.lessons[0], s.courseId);
    await createCompletion(pool, s.enrollmentId, s.lessons[1], s.courseId);
    expect(await queries.summary(s.enrollmentId)).toEqual({
      enrollmentId: s.enrollmentId,
      completedLessons: 2,
      totalLessons: 3,
      percent: 66,
    });
    await pool.query("UPDATE lessons SET status = 'DRAFT' WHERE id = $1", [
      s.lessons[0],
    ]);
    expect(await queries.summary(s.enrollmentId)).toEqual({
      enrollmentId: s.enrollmentId,
      completedLessons: 1,
      totalLessons: 2,
      percent: 50,
    });
  });

  it('percent is a whole number rounded down (never 100 while a lesson is open), 0 without published lessons, and unknown ids are absent', async () => {
    const s = await setup(3);
    await createCompletion(pool, s.enrollmentId, s.lessons[0], s.courseId);
    expect((await queries.summary(s.enrollmentId))?.percent).toBe(33);
    await pool.query(
      "UPDATE lessons SET status = 'DRAFT' WHERE course_id = $1",
      [s.courseId],
    );
    expect(await queries.summary(s.enrollmentId)).toMatchObject({
      completedLessons: 0,
      totalLessons: 0,
      percent: 0,
    });
    const map = await queries.summaries([
      '019d0000-0000-7000-8000-000000000000',
    ]);
    expect(map.size).toBe(0);
    expect((await queries.summaries([])).size).toBe(0);
  });

  it('completedLessonIds lists the finished lessons in one statement', async () => {
    const s = await setup(3);
    await createCompletion(pool, s.enrollmentId, s.lessons[2], s.courseId);
    await createCompletion(pool, s.enrollmentId, s.lessons[0], s.courseId);
    const { db, calls } = countingDb();
    expect(
      new Set(await queries.completedLessonIds(s.enrollmentId, db)),
    ).toEqual(new Set([s.lessons[0], s.lessons[2]]));
    expect(calls).toHaveLength(1);
  });
});
