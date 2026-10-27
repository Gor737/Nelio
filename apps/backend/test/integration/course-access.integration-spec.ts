// M8: CourseAccessService and CourseRoleGuard against the real database (architecture section 12, Decisions 119, 121, 136).
// The exhaustive relationship x status x policy x lock grid is in test/common/course-access.spec.ts; here the relationships are
// built from real rows, and the 404 / 403 answers are checked over HTTP.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { CourseAccessService } from '../../src/common/access/course-access.service.js';
import { PrismaService } from '../../src/infrastructure/database/index.js';
import { createPool, resetData } from '../support/database.js';
import { createTeacher, createUser } from '../support/factories.js';
import {
  type CourseOverrides,
  addCourseTeacher,
  createCategory,
  createCourse,
} from '../support/factories-courses.js';
import {
  createEnrollment,
  createInvitation,
} from '../support/factories-learning.js';
import {
  bearer,
  closeApp,
  createGuardedApp,
} from '../support/integration-app.js';

const pool = createPool();
let app: NestExpressApplication;
let access: CourseAccessService;

beforeAll(async () => {
  app = await createGuardedApp();
  access = app.get(CourseAccessService);
  expect(app.get(PrismaService)).toBeDefined();
});
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
beforeEach(() => resetData(pool));

/** A published OPEN course (the common case) with an owner. */
async function publishedCourse(overrides: CourseOverrides = {}) {
  const owner = await createTeacher(pool);
  const courseId = await createCourse(pool, {
    status: 'PUBLISHED',
    summary: 'A summary that is long enough',
    categoryId: await createCategory(pool),
    firstPublishedAt: new Date(),
    enrollmentPolicy: 'OPEN',
    ...overrides,
  });
  await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
  return { owner, courseId };
}
const archived = (extra: CourseOverrides = {}) => ({
  status: 'ARCHIVED' as const,
  archivedAt: new Date(),
  ...extra,
});
const locked = () => archived({ lockedByAdminAt: new Date() });

describe('CourseAccessService.resolve (real rows)', () => {
  it('resolves every relationship', async () => {
    const { owner, courseId } = await publishedCourse();
    const [
      assistant,
      active,
      pending,
      left,
      removed,
      rejected,
      invitee,
      stranger,
    ] = await Promise.all(Array.from({ length: 8 }, () => createUser(pool)));
    await addCourseTeacher(pool, courseId, assistant.id, 'ASSISTANT', owner.id);
    await createEnrollment(pool, courseId, active.id, { status: 'ACTIVE' });
    await createEnrollment(pool, courseId, pending.id, { status: 'PENDING' });
    await createEnrollment(pool, courseId, left.id, {
      status: 'LEFT',
      firstActivatedAt: new Date(),
      leftAt: new Date(),
    });
    await createEnrollment(pool, courseId, removed.id, {
      status: 'REMOVED',
      firstActivatedAt: new Date(),
    });
    await createEnrollment(pool, courseId, rejected.id, { status: 'REJECTED' });
    await createInvitation(pool, courseId, invitee.id, owner.id);

    const relationship = async (userId: string | null) =>
      (await access.resolve(userId, courseId))?.relationship;
    expect(await relationship(owner.id)).toBe('OWNER');
    expect(await relationship(assistant.id)).toBe('ASSISTANT');
    expect(await relationship(active.id)).toBe('STUDENT_ACTIVE');
    expect(await relationship(pending.id)).toBe('STUDENT_PENDING');
    expect(await relationship(left.id)).toBe('STUDENT_LEFT');
    expect(await relationship(removed.id)).toBe('REMOVED');
    expect(await relationship(rejected.id)).toBe('REJECTED');
    expect(await relationship(invitee.id)).toBe('INVITEE');
    expect(await relationship(stranger.id)).toBe('NONE');
    expect(await relationship(null)).toBe('NONE'); // anonymous
  });

  it('returns the course state that visibility depends on', async () => {
    const { courseId } = await publishedCourse({
      enrollmentPolicy: 'INVITATION_ONLY',
    });
    const result = await access.resolve(null, courseId);
    expect(result?.course).toMatchObject({
      id: courseId,
      status: 'PUBLISHED',
      enrollmentPolicy: 'INVITATION_ONLY',
      lockedByAdminAt: null,
    });
  });

  it('a missing course, and a value that is not a UUID, resolve to null (and never reach PostgreSQL as an invalid uuid)', async () => {
    expect(await access.resolve(null, randomUUID())).toBeNull();
    expect(await access.resolve(null, 'not-a-uuid')).toBeNull();
    expect(await access.resolve(null, "x'; DROP TABLE courses;--")).toBeNull();
  });

  describe('invitations', () => {
    const inviteeOf = async (
      status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED',
      expiresAt?: Date,
    ) => {
      const { owner, courseId } = await publishedCourse({
        enrollmentPolicy: 'INVITATION_ONLY',
      });
      const user = await createUser(pool);
      await createInvitation(pool, courseId, user.id, owner.id, {
        status,
        expiresAt,
      });
      return (await access.resolve(user.id, courseId))?.relationship;
    };

    it('only a PENDING invitation that has not expired makes an INVITEE', async () => {
      expect(await inviteeOf('PENDING')).toBe('INVITEE');
      expect(await inviteeOf('PENDING', new Date(Date.now() + 1000))).toBe(
        'INVITEE',
      );
      expect(await inviteeOf('PENDING', new Date(Date.now() - 1000))).toBe(
        'NONE',
      ); // expired
      expect(await inviteeOf('ACCEPTED')).toBe('NONE');
      expect(await inviteeOf('DECLINED')).toBe('NONE');
      expect(await inviteeOf('REVOKED')).toBe('NONE');
    });

    it('a REMOVED or REJECTED student with a valid invitation is an INVITEE; with an expired one they stay REMOVED / REJECTED', async () => {
      for (const status of ['REMOVED', 'REJECTED'] as const) {
        const { owner, courseId } = await publishedCourse();
        const user = await createUser(pool);
        await createEnrollment(pool, courseId, user.id, {
          status,
          firstActivatedAt: status === 'REMOVED' ? new Date() : null,
        });
        await createInvitation(pool, courseId, user.id, owner.id);
        expect((await access.resolve(user.id, courseId))?.relationship).toBe(
          'INVITEE',
        );
        await pool.query(
          "UPDATE invitations SET expires_at = now() - interval '1 hour' WHERE course_id = $1",
          [courseId],
        );
        expect((await access.resolve(user.id, courseId))?.relationship).toBe(
          status,
        );
      }
    });

    it('an invitation never overrides an ACTIVE enrollment', async () => {
      const { owner, courseId } = await publishedCourse();
      const user = await createUser(pool);
      await createEnrollment(pool, courseId, user.id, { status: 'ACTIVE' });
      await createInvitation(pool, courseId, user.id, owner.id);
      expect((await access.resolve(user.id, courseId))?.relationship).toBe(
        'STUDENT_ACTIVE',
      );
    });
  });

  it('works inside a transaction client as well (a service resolves access in its own transaction)', async () => {
    const { courseId, owner } = await publishedCourse();
    const prisma = app.get(PrismaService);
    const result = await prisma.$transaction((tx) =>
      access.resolve(owner.id, courseId, tx),
    );
    expect(result?.relationship).toBe('OWNER');
  });
});

describe('assertVisible / requireVisible (real rows)', () => {
  it('a student of a locked course gets 403 COURSE_ADMIN_LOCKED; a stranger gets 404', async () => {
    const { courseId } = await publishedCourse(locked());
    const [student, stranger] = [
      await createUser(pool),
      await createUser(pool),
    ];
    await createEnrollment(pool, courseId, student.id, { status: 'ACTIVE' });
    await expect(
      access.requireVisible(student.id, courseId),
    ).rejects.toMatchObject({ code: 'COURSE_ADMIN_LOCKED', status: 403 });
    await expect(
      access.requireVisible(stranger.id, courseId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('a missing course is NOT_FOUND, exactly like a hidden one (existence is not revealed)', async () => {
    const hidden = (
      await publishedCourse({
        status: 'DRAFT',
        summary: null,
        categoryId: null,
        firstPublishedAt: null,
      })
    ).courseId;
    const stranger = await createUser(pool);
    const error = async (id: string) =>
      access.requireVisible(stranger.id, id).catch((e: unknown) => e);
    expect(await error(hidden)).toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      message: ((await error(randomUUID())) as Error).message,
    });
  });
});

describe('CourseRoleGuard over HTTP', () => {
  const get = (path: string, userId?: string) => {
    const req = request(app.getHttpServer()).get(
      `/api/v1/probe-auth/courses/${path}`,
    );
    return userId ? req.set('Authorization', bearer(userId)) : req;
  };

  it('the Owner passes an Owner route; an Assistant sees the course but gets 403 FORBIDDEN on it', async () => {
    const { owner, courseId } = await publishedCourse();
    const assistant = await createTeacher(pool);
    await addCourseTeacher(pool, courseId, assistant.id, 'ASSISTANT', owner.id);
    expect((await get(`${courseId}/owner`, owner.id).expect(200)).body).toEqual(
      { relationship: 'OWNER' },
    );
    const res = await get(`${courseId}/owner`, assistant.id).expect(403);
    expect(res.body).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(
      (await get(`${courseId}/staff`, assistant.id).expect(200)).body,
    ).toEqual({ relationship: 'ASSISTANT' });
  });

  it('a stranger: 403 on a public course (they can see it, so not 404), 404 on a draft, an invitation-only course and an archived one', async () => {
    const stranger = await createUser(pool);
    const publicCourse = (await publishedCourse()).courseId;
    const draft = (
      await publishedCourse({
        status: 'DRAFT',
        summary: null,
        categoryId: null,
        firstPublishedAt: null,
      })
    ).courseId;
    const invitationOnly = (
      await publishedCourse({ enrollmentPolicy: 'INVITATION_ONLY' })
    ).courseId;
    const archivedCourse = (await publishedCourse(archived())).courseId;
    expect(
      (await get(`${publicCourse}/owner`, stranger.id).expect(403)).body.code,
    ).toBe('FORBIDDEN');
    for (const hidden of [draft, invitationOnly, archivedCourse])
      expect(
        (await get(`${hidden}/owner`, stranger.id).expect(404)).body.code,
      ).toBe('NOT_FOUND');
  });

  it('an unknown course is 404 and a malformed id is 400, before anything touches the database as a UUID', async () => {
    const user = await createUser(pool);
    expect(
      (await get(`${randomUUID()}/owner`, user.id).expect(404)).body.code,
    ).toBe('NOT_FOUND');
    const bad = await get('not-a-uuid/owner', user.id).expect(400);
    expect(bad.body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('Admin-locked course: its students get 403 COURSE_ADMIN_LOCKED, strangers and invitees 404, the Owner keeps access', async () => {
    const { owner, courseId } = await publishedCourse(locked());
    const [active, left, pending, removed, invitee, stranger] =
      await Promise.all(Array.from({ length: 6 }, () => createUser(pool)));
    await createEnrollment(pool, courseId, active.id, { status: 'ACTIVE' });
    await createEnrollment(pool, courseId, left.id, {
      status: 'LEFT',
      firstActivatedAt: new Date(),
      leftAt: new Date(),
    });
    await createEnrollment(pool, courseId, pending.id, { status: 'PENDING' });
    await createEnrollment(pool, courseId, removed.id, {
      status: 'REMOVED',
      firstActivatedAt: new Date(),
    });
    await createInvitation(pool, courseId, invitee.id, owner.id);
    for (const student of [active, left, pending]) {
      const res = await get(`${courseId}/any`, student.id).expect(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        code: 'COURSE_ADMIN_LOCKED',
      });
    }
    for (const outsider of [removed, invitee, stranger])
      expect(
        (await get(`${courseId}/any`, outsider.id).expect(404)).body.code,
      ).toBe('NOT_FOUND');
    await get(`${courseId}/any`).expect(404); // anonymous
    await get(`${courseId}/owner`, owner.id).expect(200);
  });

  it('anonymous callers (optional auth): a public course is visible as NONE, an invitation-only one is 404, a role route needs a login', async () => {
    const publicCourse = (await publishedCourse()).courseId;
    const invitationOnly = (
      await publishedCourse({ enrollmentPolicy: 'INVITATION_ONLY' })
    ).courseId;
    expect((await get(`${publicCourse}/any`).expect(200)).body).toEqual({
      relationship: 'NONE',
    });
    await get(`${invitationOnly}/any`).expect(404);
    await get(`${publicCourse}/owner`).expect(401);
  });

  it('students: ACTIVE and LEFT keep an archived course; PENDING does not; a LEFT student still sees an invitation-only course', async () => {
    const { courseId } = await publishedCourse(archived());
    const [active, left, pending] = await Promise.all(
      Array.from({ length: 3 }, () => createUser(pool)),
    );
    await createEnrollment(pool, courseId, active.id, { status: 'ACTIVE' });
    await createEnrollment(pool, courseId, left.id, {
      status: 'LEFT',
      firstActivatedAt: new Date(),
      leftAt: new Date(),
    });
    await createEnrollment(pool, courseId, pending.id, { status: 'PENDING' });
    expect(
      (await get(`${courseId}/any`, active.id).expect(200)).body.relationship,
    ).toBe('STUDENT_ACTIVE');
    expect(
      (await get(`${courseId}/any`, left.id).expect(200)).body.relationship,
    ).toBe('STUDENT_LEFT');
    await get(`${courseId}/any`, pending.id).expect(404);

    const invitationOnly = (
      await publishedCourse({ enrollmentPolicy: 'INVITATION_ONLY' })
    ).courseId;
    await createEnrollment(pool, invitationOnly, left.id, {
      status: 'LEFT',
      firstActivatedAt: new Date(),
      leftAt: new Date(),
    });
    expect(
      (await get(`${invitationOnly}/any`, left.id).expect(200)).body
        .relationship,
    ).toBe('STUDENT_LEFT');
  });

  it('check order on a course route: 401 before 404, ACCOUNT_SUSPENDED before 404', async () => {
    const { courseId } = await publishedCourse({
      status: 'DRAFT',
      summary: null,
      categoryId: null,
      firstPublishedAt: null,
    });
    await get(`${courseId}/owner`).expect(401);
    const suspended = await createUser(pool, { status: 'SUSPENDED' });
    expect(
      (await get(`${courseId}/owner`, suspended.id).expect(403)).body.code,
    ).toBe('ACCOUNT_SUSPENDED');
  });
});
