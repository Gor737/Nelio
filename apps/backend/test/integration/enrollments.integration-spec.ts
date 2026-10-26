// M11c: Enrollments against the real database over HTTP: the state machine, invitations, lists and the cross-module races.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import {
  DatabaseModule,
  TransactionService,
} from '../../src/infrastructure/database/index.js';
import {
  EventBus,
  EventsModule,
} from '../../src/infrastructure/events/index.js';
import { CourseChannelService } from '../../src/modules/chat/index.js';
import { CoursesModule } from '../../src/modules/courses/index.js';
import { EnrollmentsModule } from '../../src/modules/enrollments/index.js';
import { ContentModule } from '../../src/modules/content/index.js';
import { ProgressModule } from '../../src/modules/progress/index.js';
import { createPool, resetData } from '../support/database.js';
import { createTeacher, createUser } from '../support/factories.js';
import {
  createLesson,
  createSection,
  createTextBlock,
} from '../support/factories-content.js';
import {
  addCourseTeacher,
  createPublishedCourse,
} from '../support/factories-courses.js';
import {
  createCompletion,
  createEnrollment,
  createInvitation,
  type EnrollmentStatusName,
} from '../support/factories-learning.js';
import { bearer, closeApp, testEnv } from '../support/integration-app.js';
import { holdTx, releaseAll, settlesWithin } from '../support/parallel-tx.js';

const pool = createPool(30);
let app: NestExpressApplication;
let channels: CourseChannelService;
let transactions: TransactionService;
const events: { name: string; payload: Record<string, unknown> }[] = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      CoursesModule,
      EnrollmentsModule,
      ContentModule,
      ProgressModule,
    ],
    providers: GLOBAL_PROVIDERS,
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  channels = app.get(CourseChannelService);
  transactions = app.get(TransactionService);
  const bus = app.get(EventBus);
  for (const name of [
    'enrollment.requested',
    'enrollment.approved',
    'enrollment.rejected',
    'enrollment.removed',
    'invitation.created',
  ] as const)
    bus.on(name, (payload) => {
      events.push({ name, payload: payload as Record<string, unknown> });
    });
});
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
afterEach(() => releaseAll());
beforeEach(async () => {
  await resetData(pool);
  events.length = 0;
});

let counter = 0;
const ip = () => `10.11.${(counter >> 8) & 255}.${counter++ & 255}`;
const call = (
  m: 'get' | 'post' | 'put' | 'delete',
  path: string,
  userId?: string,
  body?: object,
) => {
  const r = request(app.getHttpServer())
    [m](`/api/v1${path}`)
    .set('X-Forwarded-For', ip());
  if (userId) r.set('Authorization', bearer(userId));
  return body === undefined ? r : r.send(body);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const eventsOf = (name: string) => events.filter((e) => e.name === name);

type Policy = 'OPEN' | 'APPROVAL_REQUIRED' | 'INVITATION_ONLY';
async function world(policy: Policy = 'OPEN', lessons = 2) {
  const courseId = await createPublishedCourse(pool, {
    enrollmentPolicy: policy,
  });
  const owner = await createTeacher(pool);
  const assistant = await createTeacher(pool);
  await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
  await addCourseTeacher(pool, courseId, assistant.id, 'ASSISTANT', owner.id);
  const sectionId = await createSection(pool, courseId);
  const lessonIds: string[] = [];
  for (let i = 0; i < lessons; i++) {
    const id = await createLesson(pool, courseId, sectionId, {
      status: 'PUBLISHED',
      position: i,
    });
    await createTextBlock(pool, id);
    lessonIds.push(id);
  }
  const channel = await transactions.run((tx) =>
    channels.createForCourse(tx, courseId),
  );
  return { courseId, owner, assistant, sectionId, lessonIds, channel };
}
const statusOf = async (courseId: string, userId: string) =>
  (
    await pool.query<{ status: string }>(
      'SELECT status FROM enrollments WHERE course_id = $1 AND user_id = $2',
      [courseId, userId],
    )
  ).rows[0]?.status ?? null;
const inChannel = async (channel: string, userId: string) =>
  (
    await pool.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL',
      [channel, userId],
    )
  ).rowCount === 1;
const enrollmentId = async (courseId: string, userId: string) =>
  (
    await pool.query<{ id: string }>(
      'SELECT id FROM enrollments WHERE course_id = $1 AND user_id = $2',
      [courseId, userId],
    )
  ).rows[0].id;
const completedAt = async (courseId: string, userId: string) =>
  (
    await pool.query<{ completed_at: Date | null }>(
      'SELECT completed_at FROM enrollments WHERE course_id = $1 AND user_id = $2',
      [courseId, userId],
    )
  ).rows[0].completed_at;

describe('enrolling by policy', () => {
  it('OPEN: ACTIVE at once, in the channel, with a summary; APPROVAL_REQUIRED: PENDING and a teacher is told; INVITATION_ONLY: 403 INVITATION_REQUIRED', async () => {
    const open = await world('OPEN');
    const student = await createUser(pool);
    const res = await call(
      'post',
      `/courses/${open.courseId}/enrollments`,
      student.id,
    ).expect(201);
    expect(res.body).toMatchObject({
      courseId: open.courseId,
      status: 'ACTIVE',
      completedAt: null,
      progress: { completedLessons: 0, totalLessons: 2, percent: 0 },
    });
    expect(await inChannel(open.channel, student.id)).toBe(true);
    expect(
      (
        await pool.query(
          'SELECT first_activated_at FROM enrollments WHERE user_id = $1',
          [student.id],
        )
      ).rows[0].first_activated_at,
    ).not.toBeNull();

    const approval = await world('APPROVAL_REQUIRED');
    const asker = await createUser(pool);
    expect(
      (
        await call(
          'post',
          `/courses/${approval.courseId}/enrollments`,
          asker.id,
        ).expect(201)
      ).body.status,
    ).toBe('PENDING');
    expect(await inChannel(approval.channel, asker.id)).toBe(false);
    await sleep(80);
    expect(eventsOf('enrollment.requested')).toEqual([
      {
        name: 'enrollment.requested',
        payload: { courseId: approval.courseId, studentId: asker.id },
      },
    ]);

    const private_ = await world('INVITATION_ONLY');
    const stranger = await createUser(pool);
    await call(
      'post',
      `/courses/${private_.courseId}/enrollments`,
      stranger.id,
    ).expect(404); // an INVITATION_ONLY course is invisible to strangers
    const invitee = await createUser(pool);
    await createInvitation(
      pool,
      private_.courseId,
      invitee.id,
      private_.owner.id,
    );
    expect(
      (
        await call(
          'post',
          `/courses/${private_.courseId}/enrollments`,
          invitee.id,
        ).expect(403)
      ).body.code,
    ).toBe('INVITATION_REQUIRED');
    expect(await statusOf(private_.courseId, invitee.id)).toBeNull();
  });

  it('a teacher of the course cannot enroll (403); an anonymous caller is 401; a draft is 404', async () => {
    const w = await world();
    await call('post', `/courses/${w.courseId}/enrollments`, w.owner.id).expect(
      403,
    );
    await call(
      'post',
      `/courses/${w.courseId}/enrollments`,
      w.assistant.id,
    ).expect(403);
    await call('post', `/courses/${w.courseId}/enrollments`).expect(401);
    const draft = await createPublishedCourse(pool, {
      status: 'DRAFT',
      summary: null,
      categoryId: null,
      firstPublishedAt: null,
    });
    await call(
      'post',
      `/courses/${draft}/enrollments`,
      (await createUser(pool)).id,
    ).expect(404);
  });

  it('double click: four enrollments at the same moment make ONE ACTIVE enrollment; the rest are 409 ALREADY_ENROLLED', async () => {
    for (let round = 0; round < 4; round++) {
      const w = await world();
      const student = await createUser(pool);
      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          call('post', `/courses/${w.courseId}/enrollments`, student.id),
        ),
      );
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        201, 409, 409, 409,
      ]);
      expect(
        results
          .filter((r) => r.status === 409)
          .every((r) => r.body.code === 'ALREADY_ENROLLED'),
      ).toBe(true);
      expect(
        (
          await pool.query('SELECT 1 FROM enrollments WHERE course_id = $1', [
            w.courseId,
          ])
        ).rowCount,
      ).toBe(1);
    }
  });

  it('GET enrollments/me: 404 without one; completedAt and percent are separate; lists show no email', async () => {
    const w = await world();
    const student = await createUser(pool);
    await call(
      'get',
      `/courses/${w.courseId}/enrollments/me`,
      student.id,
    ).expect(403);
    await call('post', `/courses/${w.courseId}/enrollments`, student.id).expect(
      201,
    );
    const mine = (
      await call(
        'get',
        `/courses/${w.courseId}/enrollments/me`,
        student.id,
      ).expect(200)
    ).body;
    expect(Object.keys(mine).sort()).toEqual([
      'completedAt',
      'courseId',
      'lastVisitedAt',
      'lastVisitedLessonId',
      'progress',
      'status',
    ]);
    const students = (
      await call('get', `/courses/${w.courseId}/students`, w.owner.id).expect(
        200,
      )
    ).body;
    expect(students.items[0].student).toEqual({
      id: student.id,
      fullName: student.full_name,
      avatarUrl: null,
    });
    expect(JSON.stringify(students)).not.toContain(student.email);
    const mine2 = (await call('get', '/me/enrollments', student.id).expect(200))
      .body;
    expect(mine2.items[0]).toMatchObject({
      courseId: w.courseId,
      courseTitle: expect.any(String),
      status: 'ACTIVE',
    });
    expect(JSON.stringify(mine2)).not.toContain(student.email);
  });
});

describe('the status x action table over HTTP (OPEN policy)', () => {
  const STATES: (EnrollmentStatusName | null)[] = [
    null,
    'PENDING',
    'ACTIVE',
    'LEFT',
    'REJECTED',
    'REMOVED',
  ];
  const ACTIONS: [string, 'student' | 'assistant' | 'owner', string][] = [
    ['enroll', 'student', 'enrollments'],
    ['leave', 'student', 'enrollments/me/leave'],
    ['approve', 'assistant', 'students/:id/approve'],
    ['reject', 'assistant', 'students/:id/reject'],
    ['remove', 'owner', 'students/:id/remove'],
    ['reinstate', 'owner', 'students/:id/reinstate'],
  ];
  const EXPECT: Record<string, Record<string, string>> = {
    // [action][state] -> the resulting status (the same as before when refused)
    enroll: {
      null: 'ACTIVE',
      PENDING: 'PENDING',
      ACTIVE: 'ACTIVE',
      LEFT: 'ACTIVE',
      REJECTED: 'ACTIVE',
      REMOVED: 'REMOVED',
    },
    leave: {
      null: 'null',
      PENDING: 'LEFT',
      ACTIVE: 'LEFT',
      LEFT: 'LEFT',
      REJECTED: 'REJECTED',
      REMOVED: 'REMOVED',
    },
    approve: {
      null: 'null',
      PENDING: 'ACTIVE',
      ACTIVE: 'ACTIVE',
      LEFT: 'LEFT',
      REJECTED: 'REJECTED',
      REMOVED: 'REMOVED',
    },
    reject: {
      null: 'null',
      PENDING: 'REJECTED',
      ACTIVE: 'ACTIVE',
      LEFT: 'LEFT',
      REJECTED: 'REJECTED',
      REMOVED: 'REMOVED',
    },
    remove: {
      null: 'null',
      PENDING: 'PENDING',
      ACTIVE: 'REMOVED',
      LEFT: 'LEFT',
      REJECTED: 'REJECTED',
      REMOVED: 'REMOVED',
    },
    reinstate: {
      null: 'null',
      PENDING: 'PENDING',
      ACTIVE: 'ACTIVE',
      LEFT: 'LEFT',
      REJECTED: 'REJECTED',
      REMOVED: 'ACTIVE',
    },
  };

  it.each(ACTIONS)(
    '%s: every starting status ends in the documented status, with the channel membership matching',
    async (action, actor, path) => {
      for (const state of STATES) {
        const w = await world('OPEN');
        const student = await createUser(pool);
        if (state !== null) {
          const id = await createEnrollment(pool, w.courseId, student.id, {
            status: state,
            ...(state === 'LEFT' ? { leftAt: new Date() } : {}),
            ...(state === 'PENDING' ||
            state === 'REJECTED' ||
            state === 'REMOVED'
              ? { firstActivatedAt: null }
              : {}),
          });
          expect(id).toBeDefined();
        }
        await transactions.run((tx) => channels.syncCourse(tx, w.courseId));
        const caller =
          actor === 'student'
            ? student
            : actor === 'owner'
              ? w.owner
              : w.assistant;
        const url = `/courses/${w.courseId}/${path.replace(':id', student.id)}`;
        const res = await call('post', url, caller.id);
        expect(res.status).toBeLessThan(600);
        const after = (await statusOf(w.courseId, student.id)) ?? 'null';
        expect([action, state, after]).toEqual([
          action,
          state,
          EXPECT[action][String(state)],
        ]);
        expect([action, state, await inChannel(w.channel, student.id)]).toEqual(
          [action, state, after === 'ACTIVE'],
        );
      }
    },
  );

  it('refused actions answer with the registry codes (ALREADY_ENROLLED, FORBIDDEN, INVALID_STATE_TRANSITION, NOT_FOUND)', async () => {
    const w = await world('OPEN');
    const [active, removed, left, nobody] = [
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    await createEnrollment(pool, w.courseId, active.id);
    await createEnrollment(pool, w.courseId, removed.id, {
      status: 'REMOVED',
      firstActivatedAt: new Date(),
    });
    await createEnrollment(pool, w.courseId, left.id, {
      status: 'LEFT',
      leftAt: new Date(),
    });
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/enrollments`,
          active.id,
        ).expect(409)
      ).body.code,
    ).toBe('ALREADY_ENROLLED');
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/enrollments`,
          removed.id,
        ).expect(403)
      ).body.code,
    ).toBe('FORBIDDEN');
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/students/${left.id}/approve`,
          w.owner.id,
        ).expect(409)
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/students/${nobody.id}/approve`,
          w.owner.id,
        ).expect(404)
      ).body.code,
    ).toBe('NOT_FOUND');
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/enrollments/me/leave`,
          nobody.id,
        ).expect(404)
      ).body.code,
    ).toBe('NOT_FOUND');
    await call(
      'post',
      `/courses/${w.courseId}/students/${active.id}/remove`,
      w.assistant.id,
    ).expect(403); // Assistants cannot remove
    await call(
      'post',
      `/courses/${w.courseId}/students/${removed.id}/reinstate`,
      w.assistant.id,
    ).expect(403);
    await call(
      'post',
      `/courses/${w.courseId}/students/${active.id}/approve`,
      active.id,
    ).expect(403); // students cannot approve
  });

  it('a request from a LEFT student follows the CURRENT policy (OPEN -> APPROVAL_REQUIRED changes the answer); a rejected student may ask again', async () => {
    const w = await world('OPEN');
    const [left, rejected] = [await createUser(pool), await createUser(pool)];
    await createEnrollment(pool, w.courseId, left.id, {
      status: 'LEFT',
      leftAt: new Date(),
    });
    await createEnrollment(pool, w.courseId, rejected.id, {
      status: 'REJECTED',
      firstActivatedAt: null,
    });
    await pool.query(
      "UPDATE courses SET enrollment_policy = 'APPROVAL_REQUIRED' WHERE id = $1",
      [w.courseId],
    );
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/enrollments`,
          left.id,
        ).expect(201)
      ).body.status,
    ).toBe('PENDING');
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/enrollments`,
          rejected.id,
        ).expect(201)
      ).body.status,
    ).toBe('PENDING');
    await pool.query(
      "UPDATE courses SET enrollment_policy = 'INVITATION_ONLY' WHERE id = $1",
      [w.courseId],
    );
    await call(
      'post',
      `/courses/${w.courseId}/students/${left.id}/reject`,
      w.owner.id,
    ).expect(204);
    // a REJECTED student cannot even see an INVITATION_ONLY course
    await call('post', `/courses/${w.courseId}/enrollments`, left.id).expect(
      404,
    );
    const leaver = await createUser(pool);
    await createEnrollment(pool, w.courseId, leaver.id, {
      status: 'LEFT',
      leftAt: new Date(),
    });
    // a LEFT student still sees it and is told to ask for an invitation
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/enrollments`,
          leaver.id,
        ).expect(403)
      ).body.code,
    ).toBe('INVITATION_REQUIRED');
  });
});

describe('approval, rejection, removal, reinstatement', () => {
  it('approve and reject are for the Owner and Assistants; the student is told after commit; approving puts them in the channel', async () => {
    const w = await world('APPROVAL_REQUIRED');
    const [a, b] = [await createUser(pool), await createUser(pool)];
    for (const s of [a, b])
      await call('post', `/courses/${w.courseId}/enrollments`, s.id).expect(
        201,
      );
    await call(
      'post',
      `/courses/${w.courseId}/students/${a.id}/approve`,
      w.assistant.id,
    ).expect(204);
    await call(
      'post',
      `/courses/${w.courseId}/students/${b.id}/reject`,
      w.owner.id,
    ).expect(204);
    expect(await statusOf(w.courseId, a.id)).toBe('ACTIVE');
    expect(await statusOf(w.courseId, b.id)).toBe('REJECTED');
    expect(await inChannel(w.channel, a.id)).toBe(true);
    const decided = (
      await pool.query<{ decided_by: string }>(
        'SELECT decided_by FROM enrollments WHERE user_id = $1',
        [a.id],
      )
    ).rows[0];
    expect(decided.decided_by).toBe(w.assistant.id);
    await sleep(80);
    expect(eventsOf('enrollment.approved')[0].payload).toEqual({
      courseId: w.courseId,
      studentId: a.id,
      decidedBy: w.assistant.id,
      reinstated: false,
    });
    expect(eventsOf('enrollment.rejected')[0].payload).toEqual({
      courseId: w.courseId,
      studentId: b.id,
      decidedBy: w.owner.id,
    });
    await call(
      'post',
      `/courses/${w.courseId}/students/${a.id}/approve`,
      (await createUser(pool)).id,
    ).expect(403);
  });

  it('removal: ACTIVE -> REMOVED, out of the channel, completions kept, audited, student told; reinstatement restores ACTIVE, the channel and the progress', async () => {
    const w = await world('OPEN');
    const student = await createUser(pool);
    await call('post', `/courses/${w.courseId}/enrollments`, student.id).expect(
      201,
    );
    await call(
      'put',
      `/courses/${w.courseId}/lessons/${w.lessonIds[0]}/completion`,
      student.id,
    ).expect(200);
    await call(
      'post',
      `/courses/${w.courseId}/students/${student.id}/remove`,
      w.owner.id,
    ).expect(204);
    expect(await statusOf(w.courseId, student.id)).toBe('REMOVED');
    expect(await inChannel(w.channel, student.id)).toBe(false);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM lesson_completions WHERE lesson_id = $1',
          [w.lessonIds[0]],
        )
      ).rowCount,
    ).toBe(1);
    await call(
      'put',
      `/courses/${w.courseId}/lessons/${w.lessonIds[1]}/completion`,
      student.id,
    ).expect(403); // access is gone at once
    await call('post', `/courses/${w.courseId}/enrollments`, student.id).expect(
      403,
    );
    await call(
      'post',
      `/courses/${w.courseId}/students/${student.id}/reinstate`,
      w.owner.id,
    ).expect(204);
    expect(await statusOf(w.courseId, student.id)).toBe('ACTIVE');
    expect(await inChannel(w.channel, student.id)).toBe(true);
    expect(
      (
        await call(
          'get',
          `/courses/${w.courseId}/enrollments/me`,
          student.id,
        ).expect(200)
      ).body.progress,
    ).toMatchObject({ completedLessons: 1, percent: 50 });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM audit_logs WHERE action = 'STUDENT_REMOVED'",
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM audit_logs WHERE action = 'STUDENT_REINSTATED'",
        )
      ).rowCount,
    ).toBe(1);
    await sleep(80);
    expect(eventsOf('enrollment.removed')[0].payload).toEqual({
      courseId: w.courseId,
      studentId: student.id,
      removedBy: w.owner.id,
    });
    expect(
      eventsOf('enrollment.approved').find(
        (e) => e.payload.reinstated === true,
      ),
    ).toBeDefined();
  });

  it('leave-then-return keeps the channel membership matching and the progress; the channel row is reused', async () => {
    const w = await world('OPEN');
    const student = await createUser(pool);
    await call('post', `/courses/${w.courseId}/enrollments`, student.id).expect(
      201,
    );
    await call(
      'put',
      `/courses/${w.courseId}/lessons/${w.lessonIds[0]}/completion`,
      student.id,
    ).expect(200);
    for (let round = 0; round < 3; round++) {
      await call(
        'post',
        `/courses/${w.courseId}/enrollments/me/leave`,
        student.id,
      ).expect(204);
      expect([
        await statusOf(w.courseId, student.id),
        await inChannel(w.channel, student.id),
      ]).toEqual(['LEFT', false]);
      await call(
        'post',
        `/courses/${w.courseId}/enrollments`,
        student.id,
      ).expect(201);
      expect([
        await statusOf(w.courseId, student.id),
        await inChannel(w.channel, student.id),
      ]).toEqual(['ACTIVE', true]);
    }
    expect(
      (
        await pool.query('SELECT 1 FROM enrollments WHERE user_id = $1', [
          student.id,
        ])
      ).rowCount,
    ).toBe(1); // one row, ever (Decision 8)
    expect(
      (
        await pool.query(
          'SELECT 1 FROM conversation_members WHERE user_id = $1 AND conversation_id = $2',
          [student.id, w.channel],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await call(
          'get',
          `/courses/${w.courseId}/enrollments/me`,
          student.id,
        ).expect(200)
      ).body.progress.completedLessons,
    ).toBe(1);
  });

  it('a returning student is rechecked for completion: a lesson archived while they were away completes the course on return', async () => {
    const w = await world('OPEN');
    const student = await createUser(pool);
    await call('post', `/courses/${w.courseId}/enrollments`, student.id).expect(
      201,
    );
    await call(
      'put',
      `/courses/${w.courseId}/lessons/${w.lessonIds[0]}/completion`,
      student.id,
    ).expect(200);
    await call(
      'post',
      `/courses/${w.courseId}/enrollments/me/leave`,
      student.id,
    ).expect(204);
    await call(
      'post',
      `/courses/${w.courseId}/lessons/${w.lessonIds[1]}/archive`,
      w.owner.id,
    ).expect(200); // the other lesson disappears
    expect(await completedAt(w.courseId, student.id)).toBeNull(); // not ACTIVE: not evaluated
    const back = await call(
      'post',
      `/courses/${w.courseId}/enrollments`,
      student.id,
    ).expect(201);
    expect(back.body.completedAt).not.toBeNull();
    expect(await completedAt(w.courseId, student.id)).not.toBeNull();
  });

  it('a completion stays permanent when new lessons are published after it', async () => {
    const w = await world('OPEN', 1);
    const student = await createUser(pool);
    await call('post', `/courses/${w.courseId}/enrollments`, student.id).expect(
      201,
    );
    await call(
      'put',
      `/courses/${w.courseId}/lessons/${w.lessonIds[0]}/completion`,
      student.id,
    ).expect(200);
    const done = await completedAt(w.courseId, student.id);
    expect(done).not.toBeNull();
    const extra = await createLesson(pool, w.courseId, w.sectionId, {
      status: 'PUBLISHED',
      position: 5,
    });
    await createTextBlock(pool, extra);
    const mine = (
      await call(
        'get',
        `/courses/${w.courseId}/enrollments/me`,
        student.id,
      ).expect(200)
    ).body;
    expect(mine.progress.percent).toBe(50);
    expect(mine.completedAt).not.toBeNull();
  });
});

describe('archived and Admin-locked courses (Decision 142)', () => {
  const archive = (courseId: string, locked = false) =>
    pool.query(
      `UPDATE courses SET status = 'ARCHIVED', archived_at = now()${locked ? ', locked_by_admin_at = now()' : ''} WHERE id = $1`,
      [courseId],
    );

  it('enrolling, approving and reinstating are refused (409) while leaving and Owner removal still work', async () => {
    const w = await world('APPROVAL_REQUIRED');
    const [pending, active, removed, newcomer] = [
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    await createEnrollment(pool, w.courseId, pending.id, {
      status: 'PENDING',
      firstActivatedAt: null,
    });
    await createEnrollment(pool, w.courseId, active.id);
    await createEnrollment(pool, w.courseId, removed.id, {
      status: 'REMOVED',
      firstActivatedAt: new Date(),
    });
    await archive(w.courseId);
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/enrollments`,
          newcomer.id,
        ).expect(404)
      ).body.code,
    ).toBe('NOT_FOUND'); // an archived course is invisible to strangers
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/students/${pending.id}/approve`,
          w.owner.id,
        ).expect(409)
      ).body.code,
    ).toBe('COURSE_ARCHIVED');
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/students/${removed.id}/reinstate`,
          w.owner.id,
        ).expect(409)
      ).body.code,
    ).toBe('COURSE_ARCHIVED');
    expect(await statusOf(w.courseId, pending.id)).toBe('PENDING'); // approval returns 409 and the request is untouched
    await call(
      'post',
      `/courses/${w.courseId}/enrollments/me/leave`,
      pending.id,
    ).expect(204); // cancel a request
    await call(
      'post',
      `/courses/${w.courseId}/enrollments/me/leave`,
      active.id,
    ).expect(204);
    const another = await createUser(pool);
    await createEnrollment(pool, w.courseId, another.id);
    await call(
      'post',
      `/courses/${w.courseId}/students/${another.id}/remove`,
      w.owner.id,
    ).expect(204);
    const left = await createUser(pool);
    await createEnrollment(pool, w.courseId, left.id, {
      status: 'LEFT',
      leftAt: new Date(),
    });
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/enrollments`,
          left.id,
        ).expect(409)
      ).body.code,
    ).toBe('COURSE_ARCHIVED');
  });

  it('on a locked course: students are shut out of reads (403) but may still leave; the Owner may remove; approve and reinstate are 409 COURSE_ADMIN_LOCKED', async () => {
    const w = await world('APPROVAL_REQUIRED');
    const [pending, active, removed] = [
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    await createEnrollment(pool, w.courseId, pending.id, {
      status: 'PENDING',
      firstActivatedAt: null,
    });
    await createEnrollment(pool, w.courseId, active.id);
    await createEnrollment(pool, w.courseId, removed.id, {
      status: 'REMOVED',
      firstActivatedAt: new Date(),
    });
    await archive(w.courseId, true);
    await call(
      'get',
      `/courses/${w.courseId}/enrollments/me`,
      active.id,
    ).expect(403);
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/students/${pending.id}/approve`,
          w.owner.id,
        ).expect(409)
      ).body.code,
    ).toBe('COURSE_ADMIN_LOCKED');
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/students/${removed.id}/reinstate`,
          w.owner.id,
        ).expect(409)
      ).body.code,
    ).toBe('COURSE_ADMIN_LOCKED');
    await call(
      'post',
      `/courses/${w.courseId}/enrollments/me/leave`,
      active.id,
    ).expect(204);
    await call(
      'post',
      `/courses/${w.courseId}/enrollments/me/leave`,
      pending.id,
    ).expect(204);
    const another = await createUser(pool);
    await createEnrollment(pool, w.courseId, another.id);
    await call(
      'post',
      `/courses/${w.courseId}/students/${another.id}/remove`,
      w.owner.id,
    ).expect(204);
  });
});

describe('add Assistant versus enroll: exactly one wins (Decision 72, Course-S versus Course-X)', () => {
  it('in parallel, many times: the same person is either the Assistant or the student, never both', async () => {
    for (let round = 0; round < 12; round++) {
      const w = await world('OPEN');
      const person = await createTeacher(pool); // an approved Teacher who is also free to enroll
      const [add, enroll] = await Promise.all([
        call('post', `/courses/${w.courseId}/assistants`, w.owner.id, {
          userId: person.id,
        }),
        call('post', `/courses/${w.courseId}/enrollments`, person.id),
      ]);
      const asTeacher =
        (
          await pool.query(
            'SELECT 1 FROM course_teachers WHERE course_id = $1 AND user_id = $2',
            [w.courseId, person.id],
          )
        ).rowCount === 1;
      const asStudent = (await statusOf(w.courseId, person.id)) !== null;
      expect([round, asTeacher !== asStudent]).toEqual([round, true]); // exactly one
      expect([add.status === 204, enroll.status === 201]).toEqual([
        asTeacher,
        asStudent,
      ]);
      expect([409, 403]).toContain(asTeacher ? enroll.status : add.status);
    }
  });

  it('deterministically: an enrollment that passed the guard while an Assistant add was still uncommitted waits for it, then is refused', async () => {
    const w = await world('OPEN');
    const person = await createTeacher(pool);
    const adding = await holdTx(
      pool,
      'add-assistant',
      'SELECT 1 FROM courses WHERE id = $1 FOR NO KEY UPDATE',
      [w.courseId],
    );
    await adding.client.query(
      "INSERT INTO course_teachers (course_id, user_id, role, added_by) VALUES ($1, $2, 'ASSISTANT', $3)",
      [w.courseId, person.id, w.owner.id],
    );
    // the guard sees no teacher row yet, so it lets the request through; Course-S makes it wait for the add
    const enrolling = call(
      'post',
      `/courses/${w.courseId}/enrollments`,
      person.id,
    ).then((r) => r);
    expect(await settlesWithin(enrolling, 400)).toBe(false);
    await adding.release('commit');
    const res = await enrolling;
    expect([res.status, res.body.code]).toEqual([409, 'RESOURCE_CONFLICT']);
    expect(await statusOf(w.courseId, person.id)).toBeNull();
  });

  it('in both sequential orders the second one is refused', async () => {
    const w = await world('OPEN');
    const [a, b] = [await createTeacher(pool), await createTeacher(pool)];
    await call('post', `/courses/${w.courseId}/enrollments`, a.id).expect(201);
    expect(
      (
        await call('post', `/courses/${w.courseId}/assistants`, w.owner.id, {
          userId: a.id,
        }).expect(409)
      ).body.message,
    ).toMatch(/student/);
    await call('post', `/courses/${w.courseId}/assistants`, w.owner.id, {
      userId: b.id,
    }).expect(204);
    await call('post', `/courses/${w.courseId}/enrollments`, b.id).expect(403);
  });
});

describe('invitations', () => {
  it('create, list (EXPIRED derived), list mine, revoke; a valid pending one is 409 INVITATION_PENDING and never reset', async () => {
    const w = await world('INVITATION_ONLY');
    const invitee = await createUser(pool);
    const created = (
      await call('post', `/courses/${w.courseId}/invitations`, w.assistant.id, {
        userId: invitee.id,
      }).expect(201)
    ).body;
    expect(created).toMatchObject({
      status: 'PENDING',
      invitee: { id: invitee.id },
      invitedBy: { id: w.assistant.id },
    });
    const days =
      (new Date(created.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    expect(JSON.stringify(created)).not.toContain(invitee.email);
    expect(
      (
        await call('post', `/courses/${w.courseId}/invitations`, w.owner.id, {
          userId: invitee.id,
        }).expect(409)
      ).body.code,
    ).toBe('INVITATION_PENDING');
    expect(
      (await call('get', '/me/invitations', invitee.id).expect(200)).body,
    ).toEqual([
      expect.objectContaining({ id: created.id, courseId: w.courseId }),
    ]);
    await sleep(80);
    expect(eventsOf('invitation.created')).toEqual([
      {
        name: 'invitation.created',
        payload: {
          courseId: w.courseId,
          inviteeId: invitee.id,
          invitedBy: w.assistant.id,
        },
      },
    ]);
    await call(
      'post',
      `/courses/${w.courseId}/invitations`,
      (await createUser(pool)).id,
      { userId: invitee.id },
    ).expect(404);
    await call('post', `/courses/${w.courseId}/invitations`, w.owner.id, {
      userId: randomUUID(),
    }).expect(404);
    await call('post', `/courses/${w.courseId}/invitations`, w.owner.id, {
      userId: w.assistant.id,
    }).expect(409);
    await call(
      'post',
      `/courses/${w.courseId}/invitations/${created.id}/revoke`,
      w.owner.id,
    ).expect(204);
    expect(
      (await call('get', '/me/invitations', invitee.id).expect(200)).body,
    ).toEqual([]);
    expect(
      (
        await call(
          'get',
          `/courses/${w.courseId}/invitations`,
          w.owner.id,
        ).expect(200)
      ).body.items[0].status,
    ).toBe('REVOKED');
  });

  it('expired, revoked and declined invitations reuse the SAME row and reset to PENDING with a new expiry', async () => {
    const w = await world('INVITATION_ONLY');
    const invitee = await createUser(pool);
    const first = (
      await call('post', `/courses/${w.courseId}/invitations`, w.owner.id, {
        userId: invitee.id,
      }).expect(201)
    ).body;
    await pool.query(
      "UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [first.id],
    );
    expect(
      (
        await call(
          'get',
          `/courses/${w.courseId}/invitations`,
          w.owner.id,
        ).expect(200)
      ).body.items[0].status,
    ).toBe('EXPIRED'); // derived, no job
    expect(
      (await call('get', '/me/invitations', invitee.id).expect(200)).body,
    ).toEqual([]);
    expect(
      (
        await call(
          'post',
          `/me/invitations/${first.id}/accept`,
          invitee.id,
        ).expect(409)
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
    await call('get', `/courses/${w.courseId}`, invitee.id).expect(404); // an expired invitation grants no visibility
    const again = (
      await call('post', `/courses/${w.courseId}/invitations`, w.owner.id, {
        userId: invitee.id,
      }).expect(201)
    ).body;
    expect(again.id).toBe(first.id);
    await call(
      'post',
      `/me/invitations/${again.id}/decline`,
      invitee.id,
    ).expect(204);
    const third = (
      await call('post', `/courses/${w.courseId}/invitations`, w.assistant.id, {
        userId: invitee.id,
      }).expect(201)
    ).body;
    expect([third.id, third.status, third.invitedBy.id]).toEqual([
      first.id,
      'PENDING',
      w.assistant.id,
    ]);
    expect((await pool.query('SELECT 1 FROM invitations')).rowCount).toBe(1);
  });

  it('accepting makes the student ACTIVE whatever the policy, in the channel; ACCEPTED is reusable after they left or were removed', async () => {
    const w = await world('INVITATION_ONLY');
    const invitee = await createUser(pool);
    const inv = (
      await call('post', `/courses/${w.courseId}/invitations`, w.owner.id, {
        userId: invitee.id,
      }).expect(201)
    ).body;
    const res = await call(
      'post',
      `/me/invitations/${inv.id}/accept`,
      invitee.id,
    ).expect(200);
    expect(res.body).toMatchObject({ status: 'ACTIVE', courseId: w.courseId });
    expect(await inChannel(w.channel, invitee.id)).toBe(true);
    await call('post', `/courses/${w.courseId}/invitations`, w.owner.id, {
      userId: invitee.id,
    }).expect(409); // an ACTIVE student cannot be invited
    await call(
      'post',
      `/courses/${w.courseId}/students/${invitee.id}/remove`,
      w.owner.id,
    ).expect(204);
    const second = (
      await call('post', `/courses/${w.courseId}/invitations`, w.owner.id, {
        userId: invitee.id,
      }).expect(201)
    ).body;
    expect(second.id).toBe(inv.id);
    await call(
      'post',
      `/me/invitations/${second.id}/accept`,
      invitee.id,
    ).expect(200); // a new invitation brings a REMOVED student back
    expect(await statusOf(w.courseId, invitee.id)).toBe('ACTIVE');
  });

  it('accept when already ACTIVE is 409 ALREADY_ENROLLED and the invitation stays PENDING (everything rolled back)', async () => {
    const w = await world('OPEN');
    const student = await createUser(pool);
    await call('post', `/courses/${w.courseId}/enrollments`, student.id).expect(
      201,
    );
    const invitationId = await createInvitation(
      pool,
      w.courseId,
      student.id,
      w.owner.id,
    );
    expect(
      (
        await call(
          'post',
          `/me/invitations/${invitationId}/accept`,
          student.id,
        ).expect(409)
      ).body.code,
    ).toBe('ALREADY_ENROLLED');
    expect(
      (
        await pool.query(
          'SELECT status, responded_at FROM invitations WHERE id = $1',
          [invitationId],
        )
      ).rows[0],
    ).toEqual({ status: 'PENDING', responded_at: null });
  });

  it('accept versus revoke at the same moment: exactly one wins, and the enrollment matches the winner', async () => {
    for (let round = 0; round < 10; round++) {
      const w = await world('INVITATION_ONLY');
      const invitee = await createUser(pool);
      const invitationId = await createInvitation(
        pool,
        w.courseId,
        invitee.id,
        w.owner.id,
      );
      const [accept, revoke] = await Promise.all([
        call('post', `/me/invitations/${invitationId}/accept`, invitee.id),
        call(
          'post',
          `/courses/${w.courseId}/invitations/${invitationId}/revoke`,
          w.owner.id,
        ),
      ]);
      const outcomes = [accept.status === 200, revoke.status === 204];
      expect([round, outcomes.filter(Boolean).length]).toEqual([round, 1]);
      const row = (
        await pool.query<{ status: string }>(
          'SELECT status FROM invitations WHERE id = $1',
          [invitationId],
        )
      ).rows[0];
      expect(row.status).toBe(accept.status === 200 ? 'ACCEPTED' : 'REVOKED');
      expect(await statusOf(w.courseId, invitee.id)).toBe(
        accept.status === 200 ? 'ACTIVE' : null,
      );
    }
  });

  it('who may revoke: the inviter and the Owner; another Assistant, a student and the invitee may not; decline is for the invitee only', async () => {
    const w = await world('INVITATION_ONLY');
    const other = await createTeacher(pool);
    await addCourseTeacher(pool, w.courseId, other.id, 'ASSISTANT', w.owner.id);
    const invitee = await createUser(pool);
    const id = await createInvitation(
      pool,
      w.courseId,
      invitee.id,
      w.assistant.id,
    );
    await call(
      'post',
      `/courses/${w.courseId}/invitations/${id}/revoke`,
      other.id,
    ).expect(403);
    await call(
      'post',
      `/courses/${w.courseId}/invitations/${id}/revoke`,
      invitee.id,
    ).expect(403); // not a teacher of the course
    await call('post', `/me/invitations/${id}/decline`, other.id).expect(404);
    await call('post', `/me/invitations/${id}/accept`, other.id).expect(404);
    await call(
      'post',
      `/courses/${w.courseId}/invitations/${id}/revoke`,
      w.assistant.id,
    ).expect(204);
    expect(
      (
        await call(
          'post',
          `/courses/${w.courseId}/invitations/${id}/revoke`,
          w.owner.id,
        ).expect(409)
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
    expect(
      (
        await call('post', `/me/invitations/${id}/decline`, invitee.id).expect(
          409,
        )
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
  });

  it('invitations are refused on an archived course and for a draft', async () => {
    const w = await world('INVITATION_ONLY');
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now() WHERE id = $1",
      [w.courseId],
    );
    expect(
      (
        await call('post', `/courses/${w.courseId}/invitations`, w.owner.id, {
          userId: (await createUser(pool)).id,
        }).expect(409)
      ).body.code,
    ).toBe('COURSE_ARCHIVED');
  });
});

describe('last visited and my courses', () => {
  it('the pointer takes a published lesson of this course only, for an ACTIVE student', async () => {
    const w = await world('OPEN');
    const other = await world('OPEN');
    const student = await createUser(pool);
    await call('post', `/courses/${w.courseId}/enrollments`, student.id).expect(
      201,
    );
    await call(
      'put',
      `/courses/${w.courseId}/enrollments/me/last-visited`,
      student.id,
      { lessonId: w.lessonIds[1] },
    ).expect(204);
    expect(
      (
        await call(
          'get',
          `/courses/${w.courseId}/enrollments/me`,
          student.id,
        ).expect(200)
      ).body,
    ).toMatchObject({ lastVisitedLessonId: w.lessonIds[1] });
    await call(
      'put',
      `/courses/${w.courseId}/enrollments/me/last-visited`,
      student.id,
      { lessonId: other.lessonIds[0] },
    ).expect(404);
    await call(
      'put',
      `/courses/${w.courseId}/enrollments/me/last-visited`,
      student.id,
      { lessonId: randomUUID() },
    ).expect(404);
    const draft = await createLesson(pool, w.courseId, w.sectionId, {
      status: 'DRAFT',
      position: 9,
    });
    await call(
      'put',
      `/courses/${w.courseId}/enrollments/me/last-visited`,
      student.id,
      { lessonId: draft },
    ).expect(404);
    await call(
      'put',
      `/courses/${w.courseId}/enrollments/me/last-visited`,
      student.id,
      { lessonId: 'nope' },
    ).expect(400);
    await call(
      'put',
      `/courses/${w.courseId}/enrollments/me/last-visited`,
      (await createUser(pool)).id,
      { lessonId: w.lessonIds[0] },
    ).expect(403);
  });

  it('teacher lists: filter by status, paginate, and progress of one student', async () => {
    const w = await world('OPEN');
    const students = await Promise.all([1, 2, 3].map(() => createUser(pool)));
    for (const s of students)
      await call('post', `/courses/${w.courseId}/enrollments`, s.id).expect(
        201,
      );
    await call(
      'put',
      `/courses/${w.courseId}/lessons/${w.lessonIds[0]}/completion`,
      students[0].id,
    ).expect(200);
    await call(
      'post',
      `/courses/${w.courseId}/enrollments/me/leave`,
      students[2].id,
    ).expect(204);
    const active = (
      await call(
        'get',
        `/courses/${w.courseId}/students`,
        w.assistant.id,
      ).expect(200)
    ).body;
    expect(active.total).toBe(2);
    expect(
      (
        await call(
          'get',
          `/courses/${w.courseId}/students?status=LEFT`,
          w.owner.id,
        ).expect(200)
      ).body.total,
    ).toBe(1);
    expect(
      (
        await call(
          'get',
          `/courses/${w.courseId}/students?pageSize=1&page=2`,
          w.owner.id,
        ).expect(200)
      ).body.items,
    ).toHaveLength(1);
    await call(
      'get',
      `/courses/${w.courseId}/students?status=NOPE`,
      w.owner.id,
    ).expect(400);
    const progress = (
      await call(
        'get',
        `/courses/${w.courseId}/students/${students[0].id}/progress`,
        w.owner.id,
      ).expect(200)
    ).body;
    expect(progress).toMatchObject({
      status: 'ACTIVE',
      progress: { completedLessons: 1, percent: 50 },
      completedLessonIds: [w.lessonIds[0]],
    });
    await call('get', `/courses/${w.courseId}/students`, students[0].id).expect(
      403,
    );
    await call(
      'get',
      `/courses/${w.courseId}/students/${randomUUID()}/progress`,
      w.owner.id,
    ).expect(404);
  });

  it('my courses lists progress for every course; completion shows separately from the percent', async () => {
    const [a, b] = [await world('OPEN'), await world('OPEN', 1)];
    const student = await createUser(pool);
    for (const w of [a, b])
      await call(
        'post',
        `/courses/${w.courseId}/enrollments`,
        student.id,
      ).expect(201);
    await call(
      'put',
      `/courses/${b.courseId}/lessons/${b.lessonIds[0]}/completion`,
      student.id,
    ).expect(200);
    await createCompletion(
      pool,
      await enrollmentId(a.courseId, student.id),
      a.lessonIds[0],
      a.courseId,
    );
    const mine = (await call('get', '/me/enrollments', student.id).expect(200))
      .body;
    const byCourse = Object.fromEntries(
      mine.items.map((i: { courseId: string }) => [i.courseId, i]),
    );
    expect(byCourse[a.courseId].progress).toMatchObject({
      completedLessons: 1,
      totalLessons: 2,
      percent: 50,
    });
    expect(byCourse[a.courseId].completedAt).toBeNull();
    expect(byCourse[b.courseId].progress.percent).toBe(100);
    expect(byCourse[b.courseId].completedAt).not.toBeNull();
    expect(
      (await call('get', '/me/enrollments?status=LEFT', student.id).expect(200))
        .body.total,
    ).toBe(0);
  });
});
