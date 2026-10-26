// M9e: Notifications against the real database and a real Socket.IO client: the 12 event types, chunked fan-out, the user's own list,
// idempotent read, live push, and retention (docs/architecture.md section 17; Decisions 33, 75, 137, 139).
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { jest } from '@jest/globals';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { COUNT_LIMITS } from '../../src/common/constants/limits.js';
import {
  NOTIFICATION_TYPE_NAMES,
  type NotificationType,
} from '../../src/common/constants/notification-types.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import {
  DatabaseModule,
  PrismaService,
} from '../../src/infrastructure/database/index.js';
import {
  EventBus,
  type EventContracts,
  type EventName,
  EventsModule,
  NOTIFICATION_EVENTS,
} from '../../src/infrastructure/events/index.js';
import { RealtimeService } from '../../src/infrastructure/realtime/index.js';
import { NotificationsModule } from '../../src/modules/notifications/index.js';
import { NotificationWriter } from '../../src/modules/notifications/services/notification-writer.service.js';
import { NotificationRetention } from '../../src/modules/notifications/services/notification-retention.service.js';
import { NotificationsListener } from '../../src/modules/notifications/services/notifications.listener.js';
import { createPool, resetData } from '../support/database.js';
import {
  createAdmin,
  createTeacher,
  createUser,
} from '../support/factories.js';
import { createLesson, createSection } from '../support/factories-content.js';
import {
  addCourseTeacher,
  createCourse,
  createNotification,
  createPublishedCourse,
} from '../support/factories-courses.js';
import { createEnrollment } from '../support/factories-learning.js';
import {
  TEST_JWT_SECRET,
  bearer,
  testEnv,
} from '../support/integration-app.js';
import { mintAccessToken } from '../support/token-minter.js';

const pool = createPool();
let app: NestExpressApplication;
let port: number;
let bus: EventBus;
let realtime: RealtimeService;
let prisma: PrismaService;
let listener: NotificationsListener;
let writer: NotificationWriter;
let retention: NotificationRetention;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      NotificationsModule,
    ],
    providers: GLOBAL_PROVIDERS,
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.listen(0);
  port = (app.getHttpServer().address() as AddressInfo).port;
  bus = app.get(EventBus);
  realtime = app.get(RealtimeService);
  prisma = app.get(PrismaService);
  listener = app.get(NotificationsListener, { strict: false });
  writer = app.get(NotificationWriter, { strict: false });
  retention = app.get(NotificationRetention, { strict: false });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => resetData(pool));
const opened: Socket[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const socket of opened.splice(0)) socket.close();
});

let clientCounter = 0;
const nextClientIp = () =>
  `10.3.${(clientCounter >> 8) & 255}.${clientCounter++ & 255}`;
const as = (userId: string) => ({
  get: (path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', nextClientIp()),
  put: (path: string) =>
    request(app.getHttpServer())
      .put(`/api/v1${path}`)
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', nextClientIp()),
});

interface Row {
  user_id: string;
  type: NotificationType;
  course_id: string | null;
  actor_id: string | null;
  data: Record<string, unknown>;
  read_at: Date | null;
}
const rows = async (type?: NotificationType) =>
  (
    await pool.query<Row>(
      `SELECT user_id, type, course_id, actor_id, data, read_at FROM notifications
        ${type ? 'WHERE type = $1' : ''} ORDER BY user_id`,
      type ? [type] : [],
    )
  ).rows;
const recipientsOf = (list: Row[]) => list.map((r) => r.user_id).sort();
const sorted = (ids: string[]) => [...ids].sort();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForRows(
  type: NotificationType,
  count: number,
  timeoutMs = 4000,
): Promise<Row[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await rows(type);
    if (list.length >= count) return list;
    if (Date.now() > deadline)
      throw new Error(`expected ${count} ${type} rows, found ${list.length}`);
    await sleep(25);
  }
}
/** Nothing arrives: waits a moment, then reports the number of rows. */
async function settleCount(): Promise<number> {
  await sleep(300);
  return (await rows()).length;
}
const emit = <N extends EventName>(name: N, payload: EventContracts[N]) =>
  bus.emit(name, payload);

async function course(owner?: { id: string }) {
  const id = await createPublishedCourse(pool, {
    title: 'Intro to Armenian 🇦🇲',
  });
  const teacher = owner ?? (await createTeacher(pool));
  await addCourseTeacher(pool, id, teacher.id, 'OWNER');
  const assistant = await createTeacher(pool);
  await addCourseTeacher(pool, id, assistant.id, 'ASSISTANT', teacher.id);
  return { id, owner: teacher, assistant };
}

describe('the 12 notification types: the right rows, recipients, actor, course and data', () => {
  it('every type has an event and the listener subscribes to every one of them', () => {
    expect(Object.keys(NOTIFICATION_EVENTS).sort()).toEqual(
      [...NOTIFICATION_TYPE_NAMES].sort(),
    );
    expect(listener.subscribedEvents().sort()).toEqual(
      Object.values(NOTIFICATION_EVENTS).sort(),
    );
    expect(NOTIFICATION_TYPE_NAMES).toHaveLength(12);
  });

  it('TEACHER_APPLICATION_RECEIVED: every ACTIVE Admin, not suspended or revoked ones, not the applicant', async () => {
    const [a1, a2] = [await createAdmin(pool), await createAdmin(pool)];
    const suspended = await createAdmin(pool);
    await pool.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [
      suspended.id,
    ]);
    const revoked = await createAdmin(pool);
    await pool.query(
      "UPDATE user_roles SET status = 'REVOKED' WHERE user_id = $1 AND role = 'ADMIN'",
      [revoked.id],
    );
    const applicant = await createUser(pool);
    emit('teacher-application.received', { applicantId: applicant.id });
    const list = await waitForRows('TEACHER_APPLICATION_RECEIVED', 2);
    expect(recipientsOf(list)).toEqual(sorted([a1.id, a2.id]));
    expect(
      list.every((r) => r.actor_id === applicant.id && r.course_id === null),
    ).toBe(true);
    expect(await settleCount()).toBe(2);
  });

  it.each([
    ['teacher-application.approved', 'TEACHER_APPLICATION_APPROVED'],
    ['teacher-application.rejected', 'TEACHER_APPLICATION_REJECTED'],
  ] as const)(
    '%s -> %s: the applicant, caused by the deciding Admin',
    async (event, type) => {
      const [admin, applicant] = [
        await createAdmin(pool),
        await createUser(pool),
      ];
      emit(event, { applicantId: applicant.id, decidedBy: admin.id });
      const list = await waitForRows(type, 1);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        user_id: applicant.id,
        actor_id: admin.id,
        course_id: null,
        read_at: null,
      });
    },
  );

  it('TEACHER_ROLE_REVOKED: the revoked Teacher, caused by the Admin', async () => {
    const [admin, teacher] = [
      await createAdmin(pool),
      await createTeacher(pool),
    ];
    emit('teacher-role.revoked', { userId: teacher.id, revokedBy: admin.id });
    const list = await waitForRows('TEACHER_ROLE_REVOKED', 1);
    expect(list[0]).toMatchObject({ user_id: teacher.id, actor_id: admin.id });
  });

  it('ENROLLMENT_REQUESTED: the Owner and the Assistants of the course, caused by the student, with the course title', async () => {
    const c = await course();
    const student = await createUser(pool);
    const otherCourse = await course();
    emit('enrollment.requested', { courseId: c.id, studentId: student.id });
    const list = await waitForRows('ENROLLMENT_REQUESTED', 2);
    expect(recipientsOf(list)).toEqual(sorted([c.owner.id, c.assistant.id]));
    for (const r of list) {
      expect(r).toMatchObject({
        course_id: c.id,
        actor_id: student.id,
        data: { courseTitle: 'Intro to Armenian 🇦🇲' },
      });
    }
    expect(recipientsOf(list)).not.toContain(otherCourse.owner.id);
  });

  it.each([
    [true, 'reinstated'],
    [false, 'approved'],
  ])(
    'ENROLLMENT_APPROVED (reinstated=%s): the student, with the flag in data (one type for %s)',
    async (reinstated) => {
      const c = await course();
      const student = await createUser(pool);
      emit('enrollment.approved', {
        courseId: c.id,
        studentId: student.id,
        decidedBy: c.owner.id,
        reinstated,
      });
      const list = await waitForRows('ENROLLMENT_APPROVED', 1);
      expect(list[0]).toMatchObject({
        user_id: student.id,
        actor_id: c.owner.id,
        course_id: c.id,
        data: { courseTitle: 'Intro to Armenian 🇦🇲', reinstated },
      });
    },
  );

  it('ENROLLMENT_REJECTED, REMOVED_FROM_COURSE and INVITATION_RECEIVED: the one student, caused by the teacher or Admin', async () => {
    const c = await course();
    const student = await createUser(pool);
    emit('enrollment.rejected', {
      courseId: c.id,
      studentId: student.id,
      decidedBy: c.owner.id,
    });
    emit('enrollment.removed', {
      courseId: c.id,
      studentId: student.id,
      removedBy: c.assistant.id,
    });
    emit('invitation.created', {
      courseId: c.id,
      inviteeId: student.id,
      invitedBy: c.owner.id,
    });
    expect((await waitForRows('ENROLLMENT_REJECTED', 1))[0]).toMatchObject({
      user_id: student.id,
      actor_id: c.owner.id,
      course_id: c.id,
    });
    expect((await waitForRows('REMOVED_FROM_COURSE', 1))[0]).toMatchObject({
      user_id: student.id,
      actor_id: c.assistant.id,
      course_id: c.id,
    });
    expect((await waitForRows('INVITATION_RECEIVED', 1))[0]).toMatchObject({
      user_id: student.id,
      actor_id: c.owner.id,
      course_id: c.id,
    });
  });

  it('LESSON_PUBLISHED: only the ACTIVE students, no teachers, no left/pending/removed students, no actor', async () => {
    const c = await course();
    const sectionId = await createSection(pool, c.id);
    const lessonId = await createLesson(pool, c.id, sectionId, {
      title: 'Alphabet',
      status: 'PUBLISHED',
    });
    const active = [await createUser(pool), await createUser(pool)];
    for (const u of active) await createEnrollment(pool, c.id, u.id);
    for (const status of ['LEFT', 'PENDING', 'REMOVED', 'REJECTED'] as const)
      await createEnrollment(pool, c.id, (await createUser(pool)).id, {
        status,
      });
    emit('lesson.first-published', { courseId: c.id, lessonId });
    const list = await waitForRows('LESSON_PUBLISHED', 2);
    expect(recipientsOf(list)).toEqual(sorted(active.map((u) => u.id)));
    for (const r of list) {
      expect(r).toMatchObject({
        course_id: c.id,
        actor_id: null,
        data: {
          courseTitle: 'Intro to Armenian 🇦🇲',
          lessonId,
          lessonTitle: 'Alphabet',
        },
      });
    }
    expect(await settleCount()).toBe(2);
  });

  it('OWNERSHIP_TRANSFERRED: the new Owner, caused by the previous Owner', async () => {
    const c = await course();
    emit('course.ownership-transferred', {
      courseId: c.id,
      previousOwnerId: c.owner.id,
      newOwnerId: c.assistant.id,
    });
    const list = await waitForRows('OWNERSHIP_TRANSFERRED', 1);
    expect(list[0]).toMatchObject({
      user_id: c.assistant.id,
      actor_id: c.owner.id,
      course_id: c.id,
    });
  });

  it('COURSE_ADMIN_LOCKED: the Owner and the Assistants, the reason in data, caused by the Admin', async () => {
    const c = await course();
    const admin = await createAdmin(pool);
    emit('course.admin-locked', {
      courseId: c.id,
      lockedBy: admin.id,
      reason: 'Copyright complaint',
    });
    const list = await waitForRows('COURSE_ADMIN_LOCKED', 2);
    expect(recipientsOf(list)).toEqual(sorted([c.owner.id, c.assistant.id]));
    for (const r of list)
      expect(r).toMatchObject({
        actor_id: admin.id,
        course_id: c.id,
        data: {
          courseTitle: 'Intro to Armenian 🇦🇲',
          reason: 'Copyright complaint',
        },
      });
  });

  it('whoever caused an event is never notified about their own action (an Admin who is also a teacher locking their own course)', async () => {
    const c = await course();
    emit('course.admin-locked', {
      courseId: c.id,
      lockedBy: c.owner.id,
      reason: 'x',
    });
    const list = await waitForRows('COURSE_ADMIN_LOCKED', 1);
    expect(recipientsOf(list)).toEqual([c.assistant.id]);
    expect(await settleCount()).toBe(1);
  });

  it('an event about a course that no longer exists writes nothing and fails nothing', async () => {
    const student = await createUser(pool);
    emit('enrollment.approved', {
      courseId: randomUUID(),
      studentId: student.id,
      decidedBy: student.id,
      reinstated: false,
    });
    emit('lesson.first-published', {
      courseId: randomUUID(),
      lessonId: randomUUID(),
    });
    expect(await settleCount()).toBe(0);
  });

  it('chat messages never produce notifications', async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    const conversationId = randomUUID();
    emit('message.created', {
      conversationId,
      messageId: randomUUID(),
      senderId: a.id,
      seq: 1,
    });
    emit('message.edited', { conversationId, messageId: randomUUID() });
    emit('message.deleted', { conversationId, messageId: randomUUID() });
    emit('membership.ended', { userId: b.id, courseId: null, conversationId });
    expect(await settleCount()).toBe(0);
  });
});

describe('chunked fan-out', () => {
  const insertStatements = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((call) => {
      const first = call[0];
      return (
        Array.isArray(first) &&
        first.join('').includes('INSERT INTO notifications')
      );
    }).length;

  it('writes 1250 recipients in 3 statements of at most 500 rows (one row each)', async () => {
    await pool.query(
      `INSERT INTO users (email, full_name, status, password_hash, email_verified_at)
       SELECT 'bulk' || g || '@example.test', 'Bulk ' || g, 'ACTIVE', 'x', now() FROM generate_series(1, 1250) g`,
    );
    const ids = (
      await pool.query<{ id: string }>(
        "SELECT id FROM users WHERE email LIKE 'bulk%'",
      )
    ).rows.map((r) => r.id);
    expect(COUNT_LIMITS.NOTIFICATION_FANOUT_CHUNK).toBe(500);
    const spy = jest.spyOn(prisma, '$queryRaw');
    const written = await writer.write({
      type: 'LESSON_PUBLISHED',
      recipientIds: ids,
      data: { courseTitle: 't' },
    });
    expect(written).toBe(1250);
    expect(insertStatements(spy)).toBe(3);
    expect((await rows('LESSON_PUBLISHED')).length).toBe(1250);
  });

  it('a recipient listed twice gets one row; an unknown recipient is skipped', async () => {
    const user = await createUser(pool);
    const written = await writer.write({
      type: 'TEACHER_ROLE_REVOKED',
      recipientIds: [user.id, user.id, randomUUID()],
    });
    expect(written).toBe(1);
    expect((await rows()).length).toBe(1);
  });

  it('a failing chunk is logged and does not stop the chunks after it', async () => {
    const real = await createUser(pool);
    const first = [
      'not-a-uuid',
      ...Array.from(
        { length: COUNT_LIMITS.NOTIFICATION_FANOUT_CHUNK - 1 },
        () => randomUUID(),
      ),
    ];
    const written = await writer.write({
      type: 'TEACHER_ROLE_REVOKED',
      recipientIds: [...first, real.id],
    });
    expect(written).toBe(1);
    expect(recipientsOf(await rows())).toEqual([real.id]);
  });

  it('no recipients: nothing is written and nothing is queried', async () => {
    const spy = jest.spyOn(prisma, '$queryRaw');
    expect(
      await writer.write({ type: 'TEACHER_ROLE_REVOKED', recipientIds: [] }),
    ).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('GET /me/notifications', () => {
  it('lists the newest first with exactly id, type, courseId, actor, data, readAt and createdAt', async () => {
    const [me, actor] = [
      await createUser(pool, { fullName: 'Աննա' }),
      await createUser(pool, { fullName: 'Actor Name' }),
    ];
    const c = await createCourse(pool);
    const old = await createNotification(pool, me.id, {
      type: 'ENROLLMENT_APPROVED',
      courseId: c,
      actorId: actor.id,
      data: { courseTitle: 'X' },
    });
    const fresh = await createNotification(pool, me.id, {
      type: 'TEACHER_ROLE_REVOKED',
    });
    await pool.query(
      "UPDATE notifications SET created_at = now() - interval '1 hour' WHERE id = $1",
      [old],
    );
    const res = await as(me.id).get('/me/notifications').expect(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([
      fresh,
      old,
    ]);
    expect(res.body.nextCursor).toBeNull();
    for (const item of res.body.items)
      expect(Object.keys(item).sort()).toEqual([
        'actor',
        'courseId',
        'createdAt',
        'data',
        'id',
        'readAt',
        'type',
      ]);
    expect(res.body.items[1]).toMatchObject({
      type: 'ENROLLMENT_APPROVED',
      courseId: c,
      actor: { id: actor.id, fullName: 'Actor Name' },
      data: { courseTitle: 'X' },
      readAt: null,
    });
    expect(res.body.items[0].actor).toBeNull();
  });

  it("pages by cursor without gaps or repeats, and only ever shows the caller's own", async () => {
    const [me, other] = [await createUser(pool), await createUser(pool)];
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await createNotification(pool, me.id));
      await createNotification(pool, other.id);
    }
    await pool.query(
      `UPDATE notifications SET created_at = now() - (rn || ' minutes')::interval
         FROM (SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY id DESC) AS rn FROM notifications) x WHERE notifications.id = x.id`,
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await as(me.id)
        .get(`/me/notifications?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
        .expect(200);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());
  });

  it('unread=true lists only the unread; limit and cursor are validated', async () => {
    const me = await createUser(pool);
    const unread = await createNotification(pool, me.id);
    await createNotification(pool, me.id, { readAt: new Date() });
    const res = await as(me.id)
      .get('/me/notifications?unread=true')
      .expect(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([unread]);
    await as(me.id).get('/me/notifications?limit=0').expect(400);
    await as(me.id)
      .get(`/me/notifications?limit=${COUNT_LIMITS.CURSOR_PAGE_SIZE_MAX + 1}`)
      .expect(400);
    await as(me.id).get('/me/notifications?cursor=nope').expect(400);
    await as(me.id).get('/me/notifications?unread=maybe').expect(400);
  });

  it('a cursor that belongs to somebody else reveals nothing: an empty page', async () => {
    const [me, other] = [await createUser(pool), await createUser(pool)];
    await createNotification(pool, me.id);
    const foreign = await createNotification(pool, other.id);
    const res = await as(me.id)
      .get(`/me/notifications?cursor=${foreign}`)
      .expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it('needs a signed-in user', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/me/notifications')
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/me/notifications/unread-count')
      .expect(401);
    await request(app.getHttpServer())
      .put('/api/v1/me/notifications/read-all')
      .expect(401);
  });
});

describe('unread count, read, read-all', () => {
  it("unread-count counts the caller's unread only and drops as they are read", async () => {
    const [me, other] = [await createUser(pool), await createUser(pool)];
    const a = await createNotification(pool, me.id);
    await createNotification(pool, me.id);
    await createNotification(pool, me.id, { readAt: new Date() });
    await createNotification(pool, other.id);
    expect(
      (await as(me.id).get('/me/notifications/unread-count').expect(200)).body,
    ).toEqual({ count: 2 });
    await as(me.id).put(`/me/notifications/${a}/read`).expect(204);
    expect(
      (await as(me.id).get('/me/notifications/unread-count').expect(200)).body,
    ).toEqual({ count: 1 });
  });

  it('the unread count and the unread list are served by the partial index of unread notifications', async () => {
    const [me, other] = [await createUser(pool), await createUser(pool)];
    await pool.query(
      `INSERT INTO notifications (user_id, type, read_at)
       SELECT CASE WHEN g % 10 = 0 THEN $1::uuid ELSE $2::uuid END, 'ENROLLMENT_REQUESTED', CASE WHEN g % 3 = 0 THEN now() END
         FROM generate_series(1, 5000) g`,
      [me.id, other.id],
    );
    await pool.query('ANALYZE notifications');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off'); // the plan question is "can it", not "is it cheaper on 5000 rows"
      const plan = (
        await client.query<{ 'QUERY PLAN': string }>(
          'EXPLAIN SELECT count(*)::int FROM notifications WHERE user_id = $1 AND read_at IS NULL',
          [me.id],
        )
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      expect(plan).toContain('notifications_user_unread_idx');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('PUT .../read is idempotent and keeps the first read time', async () => {
    const me = await createUser(pool);
    const id = await createNotification(pool, me.id);
    await as(me.id).put(`/me/notifications/${id}/read`).expect(204);
    const first = (
      await pool.query<{ read_at: Date }>(
        'SELECT read_at FROM notifications WHERE id = $1',
        [id],
      )
    ).rows[0].read_at;
    expect(first).not.toBeNull();
    await sleep(20);
    await as(me.id).put(`/me/notifications/${id}/read`).expect(204);
    const second = (
      await pool.query<{ read_at: Date }>(
        'SELECT read_at FROM notifications WHERE id = $1',
        [id],
      )
    ).rows[0].read_at;
    expect(second).toEqual(first);
  });

  it("somebody else's notification, and one that does not exist, are 404 and stay untouched", async () => {
    const [me, other] = [await createUser(pool), await createUser(pool)];
    const foreign = await createNotification(pool, other.id);
    const mineGone = await as(me.id)
      .put(`/me/notifications/${foreign}/read`)
      .expect(404);
    const missing = await as(me.id)
      .put(`/me/notifications/${randomUUID()}/read`)
      .expect(404);
    expect(mineGone.body.code).toBe('NOT_FOUND');
    expect(mineGone.body.message).toBe(missing.body.message);
    expect((await rows())[0].read_at).toBeNull();
    await as(me.id).put('/me/notifications/nope/read').expect(400);
  });

  it('read-all marks every unread of the caller, touches nobody else, and is idempotent', async () => {
    const [me, other] = [await createUser(pool), await createUser(pool)];
    for (let i = 0; i < 3; i++) await createNotification(pool, me.id);
    const readAlready = new Date('2026-01-01T00:00:00Z');
    await createNotification(pool, me.id, { readAt: readAlready });
    await createNotification(pool, other.id);
    await as(me.id).put('/me/notifications/read-all').expect(204);
    await as(me.id).put('/me/notifications/read-all').expect(204);
    const mine = (
      await pool.query<{ read_at: Date | null }>(
        'SELECT read_at FROM notifications WHERE user_id = $1',
        [me.id],
      )
    ).rows;
    expect(mine.every((r) => r.read_at !== null)).toBe(true);
    expect(
      mine.filter((r) => r.read_at?.getTime() === readAlready.getTime()),
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM notifications WHERE user_id = $1 AND read_at IS NULL',
          [other.id],
        )
      ).rowCount,
    ).toBe(1);
  });

  it('there is no way to create or delete a notification over HTTP', async () => {
    const me = await createUser(pool);
    const id = await createNotification(pool, me.id);
    const post = await request(app.getHttpServer())
      .post('/api/v1/me/notifications')
      .set('Authorization', bearer(me.id))
      .send({ type: 'ENROLLMENT_REQUESTED' });
    const del = await request(app.getHttpServer())
      .delete(`/api/v1/me/notifications/${id}`)
      .set('Authorization', bearer(me.id));
    expect([post.status, del.status]).toEqual([404, 404]);
    expect((await rows()).length).toBe(1);
  });
});

describe('live push (notification:new)', () => {
  const connect = (userId: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(`http://localhost:${port}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        auth: { token: mintAccessToken(userId, { secret: TEST_JWT_SECRET }) },
        extraHeaders: { Origin: 'http://localhost:3001' },
      });
      opened.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  const next = <T>(socket: Socket, event: string, ms = 3000) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event}`)), ms);
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  it("the recipient's sockets get the notification, in the same shape as the list; other users get nothing", async () => {
    const [admin, applicant, bystander] = [
      await createAdmin(pool),
      await createUser(pool, { fullName: 'Applicant Person' }),
      await createUser(pool),
    ];
    const [adminSocket, bystanderSocket] = [
      await connect(admin.id),
      await connect(bystander.id),
    ];
    let leaked = false;
    bystanderSocket.on('notification:new', () => (leaked = true));
    const pushed = next<Record<string, unknown>>(
      adminSocket,
      'notification:new',
    );
    emit('teacher-application.received', { applicantId: applicant.id });
    const payload = await pushed;
    const listed = (await as(admin.id).get('/me/notifications').expect(200))
      .body.items[0];
    expect(payload).toEqual(listed);
    expect(payload).toMatchObject({
      type: 'TEACHER_APPLICATION_RECEIVED',
      actor: { id: applicant.id, fullName: 'Applicant Person' },
      readAt: null,
    });
    await sleep(200);
    expect(leaked).toBe(false);
  });

  it('a push that throws never fails the write or the event', async () => {
    const user = await createUser(pool);
    const admin = await createAdmin(pool);
    jest.spyOn(realtime, 'emitToUser').mockImplementation(() => {
      throw new Error('socket server exploded');
    });
    emit('teacher-role.revoked', { userId: user.id, revokedBy: admin.id });
    const list = await waitForRows('TEACHER_ROLE_REVOKED', 1);
    expect(list).toHaveLength(1);
    expect(
      await writer.write({
        type: 'TEACHER_ROLE_REVOKED',
        recipientIds: [user.id],
      }),
    ).toBe(1);
  });

  it('a user who is offline simply has the row (the list shows it)', async () => {
    const user = await createUser(pool);
    const admin = await createAdmin(pool);
    emit('teacher-role.revoked', { userId: user.id, revokedBy: admin.id });
    await waitForRows('TEACHER_ROLE_REVOKED', 1);
    expect(
      (await as(user.id).get('/me/notifications').expect(200)).body.items,
    ).toHaveLength(1);
  });
});

describe('retention', () => {
  const seed = async (
    userId: string,
    readDaysAgo: number | null,
    createdDaysAgo = 200,
  ) => {
    const id = await createNotification(pool, userId);
    await pool.query(
      `UPDATE notifications SET created_at = now() - make_interval(days => $2::int),
              read_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END WHERE id = $1`,
      [id, createdDaysAgo, readDaysAgo],
    );
    return id;
  };
  const remaining = async () =>
    (await pool.query<{ id: string }>('SELECT id FROM notifications')).rows.map(
      (r) => r.id,
    );

  it('deletes only notifications read more than 90 days ago: never unread ones, never recently read ones, however old they are', async () => {
    const user = await createUser(pool);
    const oldRead = await seed(user.id, 91);
    const unreadOld = await seed(user.id, null);
    const readRecentlyButOld = await seed(user.id, 5);
    const readEightyNine = await seed(user.id, 89);
    const unreadNew = await seed(user.id, null, 0);
    expect(await retention.purgeOldRead()).toBe(1);
    expect(sorted(await remaining())).toEqual(
      sorted([unreadOld, readRecentlyButOld, readEightyNine, unreadNew]),
    );
    expect(await remaining()).not.toContain(oldRead);
    expect(await retention.purgeOldRead()).toBe(0);
  });

  it('works through more than one batch', async () => {
    const user = await createUser(pool);
    await pool.query(
      `INSERT INTO notifications (user_id, type, read_at, created_at)
       SELECT $1::uuid, 'ENROLLMENT_REQUESTED', now() - interval '120 days', now() - interval '150 days' FROM generate_series(1, 2300)`,
      [user.id],
    );
    const keep = await seed(user.id, null);
    expect(await retention.purgeOldRead()).toBe(2300);
    expect(await remaining()).toEqual([keep]);
  });
});
