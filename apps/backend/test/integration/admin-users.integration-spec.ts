// M12a: Admin and people against the real database over HTTP: access, users, Teacher applications, suspension, the Admin role, the
// last-Admin protection under parallel requests, revoking a Teacher against an ownership transfer, and the first-Admin seed.
import { jest } from '@jest/globals';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { TransactionService } from '../../src/infrastructure/database/index.js';
import { FirstAdminSeeder, SeedError } from '../../src/modules/admin/index.js';
import { SessionsService } from '../../src/modules/auth/index.js';
import { createAdminApp, type AdminTestApp } from '../support/admin-app.js';
import { createPool, resetData } from '../support/database.js';
import {
  createAdmin,
  createTeacher,
  createUser,
  createUserWithRoles,
} from '../support/factories.js';
import { createChannel, addMember } from '../support/factories-chat.js';
import {
  addCourseTeacher,
  createPublishedCourse,
} from '../support/factories-courses.js';
import { createEnrollment } from '../support/factories-learning.js';
import { holdTx, releaseAll, settlesWithin } from '../support/parallel-tx.js';

const pool = createPool(30);
let t: AdminTestApp;
let app: NestExpressApplication;
let transactions: TransactionService;
let sessions: SessionsService;

beforeAll(async () => {
  t = await createAdminApp();
  app = t.app;
  transactions = app.get(TransactionService);
  sessions = app.get(SessionsService, { strict: false });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
afterEach(() => releaseAll());
beforeEach(async () => {
  await resetData(pool);
  t.events.length = 0;
  jest.restoreAllMocks();
});

const auditRows = async (action: string) =>
  (
    await pool.query<{
      actor_id: string;
      target_id: string;
      metadata: Record<string, unknown>;
    }>(
      'SELECT actor_id, target_id, metadata FROM audit_logs WHERE action = $1 ORDER BY id',
      [action],
    )
  ).rows;
const activeAdmins = async () =>
  (
    await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_roles r JOIN users u ON u.id = r.user_id
        WHERE r.role = 'ADMIN' AND r.status = 'ACTIVE' AND u.status = 'ACTIVE'`,
    )
  ).rows[0].n;
const roleStatus = async (userId: string, role: string) =>
  (
    await pool.query<{ status: string }>(
      'SELECT status FROM user_roles WHERE user_id = $1 AND role = $2',
      [userId, role],
    )
  ).rows[0]?.status;

describe('access: every /admin endpoint is for Admins only', () => {
  const ID = '018f0000-0000-7000-8000-000000000001';
  const routes: ['get' | 'post' | 'put' | 'patch' | 'delete', string][] = [
    ['get', '/admin/users'],
    ['get', `/admin/users/${ID}`],
    ['post', `/admin/users/${ID}/suspend`],
    ['post', `/admin/users/${ID}/unsuspend`],
    ['post', `/admin/users/${ID}/revoke-teacher`],
    ['put', `/admin/users/${ID}/admin-role`],
    ['delete', `/admin/users/${ID}/admin-role`],
    ['get', '/admin/teacher-applications'],
    ['post', `/admin/teacher-applications/${ID}/approve`],
    ['post', `/admin/teacher-applications/${ID}/reject`],
    ['get', '/admin/courses'],
    ['get', `/admin/courses/${ID}`],
    ['get', `/admin/courses/${ID}/outline`],
    ['get', `/admin/courses/${ID}/lessons/${ID}`],
    ['post', `/admin/courses/${ID}/lock`],
    ['post', `/admin/courses/${ID}/unlock`],
    ['post', `/admin/courses/${ID}/restore`],
    ['post', `/admin/courses/${ID}/ownership-transfer`],
    ['post', `/admin/courses/${ID}/students/${ID}/remove`],
    ['post', `/admin/courses/${ID}/students/${ID}/reinstate`],
    ['get', '/admin/categories'],
    ['post', '/admin/categories'],
    ['patch', `/admin/categories/${ID}`],
    ['delete', `/admin/categories/${ID}`],
    ['get', '/admin/tags'],
    ['post', `/admin/tags/${ID}/merge`],
    ['get', '/admin/reports'],
    ['get', `/admin/reports/${ID}`],
    ['get', `/admin/reports/${ID}/context`],
    ['post', `/admin/reports/${ID}/dismiss`],
    ['post', `/admin/reports/${ID}/action`],
    ['get', '/admin/audit-logs'],
    ['get', '/admin/stats'],
  ];

  it('is 403 FORBIDDEN for a student, a Teacher and a revoked Admin, and 401 without a token (every route)', async () => {
    const student = await createUser(pool);
    const teacher = await createTeacher(pool);
    const revoked = await createUserWithRoles(pool, [
      { role: 'STUDENT', status: 'ACTIVE' },
      { role: 'ADMIN', status: 'REVOKED' },
    ]);
    for (const [method, path] of routes) {
      for (const user of [student, teacher, revoked]) {
        const res = await t.call(method, path, user.id, {});
        expect([method, path, res.status, res.body.code]).toEqual([
          method,
          path,
          403,
          'FORBIDDEN',
        ]);
      }
      expect((await t.call(method, path)).status).toBe(401);
    }
    expect(routes.length).toBe(33);
  });

  it('a suspended Admin is 403 ACCOUNT_SUSPENDED before any role check', async () => {
    const admin = await createAdmin(pool);
    await pool.query(
      "UPDATE users SET status = 'SUSPENDED', suspended_at = now() WHERE id = $1",
      [admin.id],
    );
    const res = await t.call('get', '/admin/stats', admin.id).expect(403);
    expect(res.body.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('users and Teacher applications', () => {
  it('lists users with their roles and the email, filtered by name, email start, role and status, and paged', async () => {
    const admin = await createAdmin(pool);
    const ani = await createUser(pool, {
      fullName: 'Ani Hakobyan',
      email: 'ani@example.test',
    });
    await createTeacher(pool);
    await createUser(pool, { status: 'SUSPENDED' });
    const all = await t.call('get', '/admin/users', admin.id).expect(200);
    expect(all.body.total).toBe(4);
    expect(all.body.items[0]).toEqual(
      expect.objectContaining({
        email: expect.any(String),
        emailVerified: true,
      }),
    );
    const byName = await t
      .call('get', '/admin/users?q=hakob', admin.id)
      .expect(200);
    expect(byName.body.items.map((u: { id: string }) => u.id)).toEqual([
      ani.id,
    ]);
    const byEmail = await t
      .call('get', '/admin/users?q=ani@', admin.id)
      .expect(200);
    expect(byEmail.body.total).toBe(1);
    expect(
      (await t.call('get', '/admin/users?q=%25%25', admin.id).expect(200)).body
        .total,
    ).toBe(0); // % is a literal, not a wildcard
    expect(
      (await t.call('get', '/admin/users?role=TEACHER', admin.id).expect(200))
        .body.total,
    ).toBe(1);
    expect(
      (await t.call('get', '/admin/users?role=ADMIN', admin.id).expect(200))
        .body.total,
    ).toBe(1);
    expect(
      (await t.call('get', '/admin/users?status=SUSPENDED', admin.id)).body
        .total,
    ).toBe(1);
    const page = await t
      .call('get', '/admin/users?page=2&pageSize=3', admin.id)
      .expect(200);
    expect(page.body).toMatchObject({ page: 2, pageSize: 3, total: 4 });
    expect(page.body.items).toHaveLength(1);
    await t.call('get', '/admin/users?q=a', admin.id).expect(400); // at least 2 characters
    await t.call('get', '/admin/users?pageSize=51', admin.id).expect(400);
  });

  it('shows one user with the counts that matter before suspending or revoking', async () => {
    const admin = await createAdmin(pool);
    const teacher = await createTeacher(pool);
    const other = await createTeacher(pool);
    const owned = await createPublishedCourse(pool);
    await addCourseTeacher(pool, owned, teacher.id, 'OWNER');
    const assisted = await createPublishedCourse(pool);
    await addCourseTeacher(pool, assisted, other.id, 'OWNER');
    await addCourseTeacher(pool, assisted, teacher.id, 'ASSISTANT', other.id);
    const res = await t
      .call('get', `/admin/users/${teacher.id}`, admin.id)
      .expect(200);
    expect(res.body).toMatchObject({
      id: teacher.id,
      ownedCourses: 1,
      assistedCourses: 1,
      enrollments: 0,
      hasPassword: true,
      hasGoogle: false,
    });
    await t
      .call(
        'get',
        '/admin/users/018f0000-0000-7000-8000-0000000000aa',
        admin.id,
      )
      .expect(404);
    await t.call('get', '/admin/users/not-a-uuid', admin.id).expect(400);
  });

  it('lists pending applications oldest first, approves and rejects them with audit rows, the note and the notification event', async () => {
    const admin = await createAdmin(pool);
    const first = await createUserWithRoles(pool, [
      { role: 'STUDENT', status: 'ACTIVE' },
      { role: 'TEACHER', status: 'PENDING' },
    ]);
    await pool.query(
      "UPDATE user_roles SET application_message = 'I teach maths' WHERE user_id = $1 AND role = 'TEACHER'",
      [first.id],
    );
    const second = await createUserWithRoles(pool, [
      { role: 'STUDENT', status: 'ACTIVE' },
      { role: 'TEACHER', status: 'PENDING' },
    ]);
    const list = await t
      .call('get', '/admin/teacher-applications', admin.id)
      .expect(200);
    expect(list.body.items.map((i: { userId: string }) => i.userId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(list.body.items[0]).toMatchObject({
      message: 'I teach maths',
      email: first.email,
    });

    await t
      .call(
        'post',
        `/admin/teacher-applications/${first.id}/approve`,
        admin.id,
        {
          note: 'welcome',
        },
      )
      .expect(204);
    await t
      .call(
        'post',
        `/admin/teacher-applications/${second.id}/reject`,
        admin.id,
        {},
      )
      .expect(204);
    expect(await roleStatus(first.id, 'TEACHER')).toBe('ACTIVE');
    expect(await roleStatus(second.id, 'TEACHER')).toBe('REJECTED');
    expect(await auditRows('TEACHER_APPROVED')).toEqual([
      expect.objectContaining({
        actor_id: admin.id,
        target_id: first.id,
        metadata: { note: 'welcome' },
      }),
    ]);
    expect(await auditRows('TEACHER_REJECTED')).toHaveLength(1);
    expect(t.eventsOf('teacher-application.approved')).toHaveLength(1);
    expect(t.eventsOf('teacher-application.rejected')).toHaveLength(1);
    // a decided application cannot be decided again
    await t
      .call(
        'post',
        `/admin/teacher-applications/${first.id}/approve`,
        admin.id,
        {},
      )
      .expect(409);
    const decided = await t
      .call('get', '/admin/teacher-applications?status=ACTIVE', admin.id)
      .expect(200);
    expect(decided.body.items).toHaveLength(1);
  });
});

describe('suspension', () => {
  async function assistantWorld() {
    const admin = await createAdmin(pool);
    const owner = await createTeacher(pool);
    const assistant = await createTeacher(pool);
    const courses: string[] = [];
    for (let i = 0; i < 2; i++) {
      const courseId = await createPublishedCourse(pool);
      await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
      await addCourseTeacher(
        pool,
        courseId,
        assistant.id,
        'ASSISTANT',
        owner.id,
      );
      const channel = await createChannel(pool, courseId);
      await addMember(pool, channel, owner.id);
      await addMember(pool, channel, assistant.id);
      courses.push(courseId);
    }
    return { admin, owner, assistant, courses };
  }

  it('is atomic: the status, the Assistant rows and channel memberships, every session, the audit rows and the event', async () => {
    const { admin, assistant, courses } = await assistantWorld();
    const raw = await transactions.run((tx) =>
      sessions.startFamily(tx, assistant.id),
    );
    await t.call('get', '/me', assistant.id).expect(200);

    await t
      .call('post', `/admin/users/${assistant.id}/suspend`, admin.id, {
        reason: 'spam',
      })
      .expect(204);

    const user = await pool.query(
      'SELECT status, suspended_at, tokens_valid_after FROM users WHERE id = $1',
      [assistant.id],
    );
    expect(user.rows[0].status).toBe('SUSPENDED');
    expect(user.rows[0].suspended_at).not.toBeNull();
    expect(user.rows[0].tokens_valid_after).not.toBeNull();
    const rows = await pool.query(
      "SELECT 1 FROM course_teachers WHERE user_id = $1 AND role = 'ASSISTANT'",
      [assistant.id],
    );
    expect(rows.rowCount).toBe(0);
    const members = await pool.query(
      `SELECT cm.left_at FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
        WHERE cm.user_id = $1 AND c.course_id = ANY($2::uuid[])`,
      [assistant.id, courses],
    );
    expect(members.rows.map((r) => r.left_at !== null)).toEqual([true, true]);
    const tokens = await pool.query(
      'SELECT revoked_at FROM refresh_tokens WHERE user_id = $1',
      [assistant.id],
    );
    expect(tokens.rows.every((r) => r.revoked_at !== null)).toBe(true);
    expect(raw.raw).toBeTruthy();
    expect(await auditRows('USER_SUSPENDED')).toEqual([
      expect.objectContaining({
        actor_id: admin.id,
        target_id: assistant.id,
        metadata: { reason: 'spam' },
      }),
    ]);
    expect(await auditRows('COURSE_ASSISTANT_REMOVED')).toHaveLength(2);
    expect(t.eventsOf('session.revoked')).toEqual([
      expect.objectContaining({ payload: { userId: assistant.id } }),
    ]);

    // the next request is 403, the refresh fails
    const next = await t.call('get', '/me', assistant.id).expect(403);
    expect(next.body.code).toBe('ACCOUNT_SUSPENDED');
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-For', '10.99.0.1')
      .set('Cookie', `nelio_refresh=${raw.raw}`)
      .expect(401);
  });

  it('rolls everything back when a step fails (nothing half-suspended)', async () => {
    const { admin, assistant } = await assistantWorld();
    jest
      .spyOn(sessions, 'revokeAllSessions')
      .mockRejectedValueOnce(new Error('boom'));
    await t
      .call('post', `/admin/users/${assistant.id}/suspend`, admin.id, {})
      .expect(500);
    const user = await pool.query(
      'SELECT status, tokens_valid_after FROM users WHERE id = $1',
      [assistant.id],
    );
    expect(user.rows[0]).toEqual({
      status: 'ACTIVE',
      tokens_valid_after: null,
    });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM course_teachers WHERE user_id = $1 AND role = 'ASSISTANT'",
          [assistant.id],
        )
      ).rowCount,
    ).toBe(2);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM conversation_members WHERE user_id = $1 AND left_at IS NOT NULL',
          [assistant.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(await auditRows('USER_SUSPENDED')).toHaveLength(0);
    expect(await auditRows('COURSE_ASSISTANT_REMOVED')).toHaveLength(0);
    expect(t.eventsOf('session.revoked')).toHaveLength(0);
  });

  it('unsuspending reactivates the account and does NOT restore the Assistant rows', async () => {
    const { admin, assistant } = await assistantWorld();
    await t
      .call('post', `/admin/users/${assistant.id}/suspend`, admin.id, {})
      .expect(204);
    await t
      .call('post', `/admin/users/${assistant.id}/unsuspend`, admin.id)
      .expect(204);
    await t.call('get', '/me', assistant.id).expect(200);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM course_teachers WHERE user_id = $1 AND role = 'ASSISTANT'",
          [assistant.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(await auditRows('USER_UNSUSPENDED')).toHaveLength(1);
    // an ACTIVE account cannot be unsuspended, a suspended one cannot be suspended twice
    await t
      .call('post', `/admin/users/${assistant.id}/unsuspend`, admin.id)
      .expect(409);
    await t
      .call('post', `/admin/users/${assistant.id}/suspend`, admin.id, {})
      .expect(204);
    await t
      .call('post', `/admin/users/${assistant.id}/suspend`, admin.id, {})
      .expect(409);
  });

  it('leaves the student data alone', async () => {
    const admin = await createAdmin(pool);
    const student = await createUser(pool);
    const courseId = await createPublishedCourse(pool);
    await createEnrollment(pool, courseId, student.id);
    await t
      .call('post', `/admin/users/${student.id}/suspend`, admin.id, {})
      .expect(204);
    const enrollment = await pool.query(
      'SELECT status FROM enrollments WHERE user_id = $1',
      [student.id],
    );
    expect(enrollment.rows[0].status).toBe('ACTIVE');
  });

  it('refuses suspending yourself (400 CANNOT_SUSPEND_SELF), an unknown user (404) and an Owner of any course in any status (409, transfer first)', async () => {
    const admin = await createAdmin(pool);
    const self = await t
      .call('post', `/admin/users/${admin.id}/suspend`, admin.id, {})
      .expect(400);
    expect(self.body.code).toBe('CANNOT_SUSPEND_SELF');
    await t
      .call(
        'post',
        '/admin/users/018f0000-0000-7000-8000-0000000000aa/suspend',
        admin.id,
        {},
      )
      .expect(404);
    for (const status of ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const) {
      const owner = await createTeacher(pool);
      const courseId = await createPublishedCourse(pool, {
        status,
        firstPublishedAt: status === 'DRAFT' ? null : new Date(),
        archivedAt: status === 'ARCHIVED' ? new Date() : null,
      });
      await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
      const res = await t
        .call('post', `/admin/users/${owner.id}/suspend`, admin.id, {})
        .expect(409);
      expect(res.body.code).toBe('RESOURCE_CONFLICT');
      expect(
        (await pool.query('SELECT status FROM users WHERE id = $1', [owner.id]))
          .rows[0].status,
      ).toBe('ACTIVE');
    }
  });

  it('an Admin can transfer on behalf of the Owner and then suspend them', async () => {
    const admin = await createAdmin(pool);
    const owner = await createTeacher(pool);
    const heir = await createTeacher(pool);
    const courseId = await createPublishedCourse(pool);
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    await t
      .call('post', `/admin/courses/${courseId}/ownership-transfer`, admin.id, {
        newOwnerId: heir.id,
      })
      .expect(200);
    await t
      .call('post', `/admin/users/${owner.id}/suspend`, admin.id, {})
      .expect(204); // now an Assistant: removed from the team
    expect(
      (
        await pool.query(
          'SELECT 1 FROM course_teachers WHERE course_id = $1 AND user_id = $2',
          [courseId, owner.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT user_id FROM course_teachers WHERE course_id = $1 AND role = 'OWNER'",
          [courseId],
        )
      ).rows,
    ).toEqual([{ user_id: heir.id }]);
  });
});

describe('the Admin role and the last-Admin protection', () => {
  it('grants and revokes the role with audit rows; both are idempotent; a suspended account cannot be made an Admin', async () => {
    const admin = await createAdmin(pool);
    const user = await createUser(pool);
    await t
      .call('put', `/admin/users/${user.id}/admin-role`, admin.id)
      .expect(204);
    await t
      .call('put', `/admin/users/${user.id}/admin-role`, admin.id)
      .expect(204);
    expect(await roleStatus(user.id, 'ADMIN')).toBe('ACTIVE');
    expect(await auditRows('ADMIN_ROLE_GRANTED')).toHaveLength(1); // the repeat wrote nothing
    // the new Admin can use /admin at once (roles come from the database)
    await t.call('get', '/admin/stats', user.id).expect(200);
    await t
      .call('delete', `/admin/users/${user.id}/admin-role`, admin.id)
      .expect(204);
    await t
      .call('delete', `/admin/users/${user.id}/admin-role`, admin.id)
      .expect(204);
    expect(await roleStatus(user.id, 'ADMIN')).toBe('REVOKED');
    expect(await auditRows('ADMIN_ROLE_REVOKED')).toHaveLength(1);
    await t.call('get', '/admin/stats', user.id).expect(403);
    // granting again after a revocation works
    await t
      .call('put', `/admin/users/${user.id}/admin-role`, admin.id)
      .expect(204);
    expect(await roleStatus(user.id, 'ADMIN')).toBe('ACTIVE');
    const suspended = await createUser(pool, { status: 'SUSPENDED' });
    await t
      .call('put', `/admin/users/${suspended.id}/admin-role`, admin.id)
      .expect(409);
    await t
      .call(
        'put',
        '/admin/users/018f0000-0000-7000-8000-0000000000aa/admin-role',
        admin.id,
      )
      .expect(404);
  });

  it('the last active Admin cannot demote themselves (409 LAST_PLATFORM_ADMIN); with another Admin they can', async () => {
    const only = await createAdmin(pool);
    const res = await t
      .call('delete', `/admin/users/${only.id}/admin-role`, only.id)
      .expect(409);
    expect(res.body.code).toBe('LAST_PLATFORM_ADMIN');
    expect(await activeAdmins()).toBe(1);
    const second = await createAdmin(pool);
    await t
      .call('delete', `/admin/users/${only.id}/admin-role`, only.id)
      .expect(204);
    expect(await activeAdmins()).toBe(1);
    expect(await roleStatus(second.id, 'ADMIN')).toBe('ACTIVE');
  });

  it('a suspended Admin does not count as an active Admin', async () => {
    const a = await createAdmin(pool);
    const b = await createAdmin(pool);
    await pool.query(
      "UPDATE users SET status = 'SUSPENDED', suspended_at = now() WHERE id = $1",
      [b.id],
    );
    const res = await t
      .call('delete', `/admin/users/${a.id}/admin-role`, a.id)
      .expect(409);
    expect(res.body.code).toBe('LAST_PLATFORM_ADMIN');
  });

  it('two Admins removing each other at the same moment: exactly one succeeds and an active Admin remains (12 rounds, four kinds of attack)', async () => {
    const kinds: ((a: string, b: string) => [request.Test, request.Test])[] = [
      (a, b) => [
        t.call('delete', `/admin/users/${b}/admin-role`, a),
        t.call('delete', `/admin/users/${a}/admin-role`, b),
      ],
      (a, b) => [
        t.call('post', `/admin/users/${b}/suspend`, a, {}),
        t.call('post', `/admin/users/${a}/suspend`, b, {}),
      ],
      (a, b) => [
        t.call('delete', `/admin/users/${b}/admin-role`, a),
        t.call('post', `/admin/users/${a}/suspend`, b, {}),
      ],
      (a, b) => [
        t.call('post', `/admin/users/${b}/suspend`, a, {}),
        t.call('delete', `/admin/users/${a}/admin-role`, b),
      ],
    ];
    for (let round = 0; round < 12; round++) {
      await resetData(pool);
      const a = await createAdmin(pool);
      const b = await createAdmin(pool);
      const [first, second] = kinds[round % kinds.length](a.id, b.id);
      const [r1, r2] = await Promise.all([first, second]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses[0]).toBe(204);
      expect([403, 409]).toContain(statuses[1]);
      expect(await activeAdmins()).toBe(1);
    }
  });

  it('takes the ADMIN-SET lock FIRST: two requests queue up behind it and then exactly one wins', async () => {
    const a = await createAdmin(pool);
    const b = await createAdmin(pool);
    const held = await holdTx(
      pool,
      'ADMIN-SET',
      "SELECT pg_advisory_xact_lock(hashtextextended('ADMIN-SET', 0))",
    );
    const p1 = t
      .call('delete', `/admin/users/${b.id}/admin-role`, a.id)
      .then((r) => r);
    const p2 = t
      .call('post', `/admin/users/${a.id}/suspend`, b.id, {})
      .then((r) => r);
    expect(await settlesWithin(Promise.all([p1, p2]), 400)).toBe(false);
    await held.release('commit');
    const results = await Promise.all([p1, p2]);
    expect(results.map((r) => r.status).sort()).toEqual([
      204,
      expect.any(Number),
    ]);
    expect(await activeAdmins()).toBe(1);
  });
});

describe('revoking the Teacher role', () => {
  it('removes the Assistant rows, sets REVOKED, writes the audit row, announces it, and leaves the sessions alone', async () => {
    const admin = await createAdmin(pool);
    const owner = await createTeacher(pool);
    const teacher = await createTeacher(pool);
    const courseId = await createPublishedCourse(pool);
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    await addCourseTeacher(pool, courseId, teacher.id, 'ASSISTANT', owner.id);
    await t
      .call('post', `/admin/users/${teacher.id}/revoke-teacher`, admin.id, {
        note: 'policy',
      })
      .expect(204);
    expect(await roleStatus(teacher.id, 'TEACHER')).toBe('REVOKED');
    expect(
      (
        await pool.query('SELECT 1 FROM course_teachers WHERE user_id = $1', [
          teacher.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await auditRows('TEACHER_REVOKED')).toEqual([
      expect.objectContaining({
        actor_id: admin.id,
        target_id: teacher.id,
        metadata: { note: 'policy' },
      }),
    ]);
    expect(t.eventsOf('teacher-role.revoked')).toHaveLength(1);
    expect(t.eventsOf('session.revoked')).toHaveLength(0);
    expect(
      (
        await pool.query('SELECT tokens_valid_after FROM users WHERE id = $1', [
          teacher.id,
        ])
      ).rows[0].tokens_valid_after,
    ).toBeNull();
    // the user is still logged in as a student, and the revoked teacher cannot teach
    await t.call('get', '/me', teacher.id).expect(200);
    await t.call('get', '/me/teaching/courses', teacher.id).expect(403);
    // not an ACTIVE Teacher any more: nothing to revoke
    await t
      .call('post', `/admin/users/${teacher.id}/revoke-teacher`, admin.id, {})
      .expect(409);
  });

  it('refuses while the person owns a course, in any status, until the ownership moves (409)', async () => {
    const admin = await createAdmin(pool);
    const owner = await createTeacher(pool);
    const heir = await createTeacher(pool);
    const courseId = await createPublishedCourse(pool, {
      status: 'ARCHIVED',
      archivedAt: new Date(),
    });
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    const refused = await t
      .call('post', `/admin/users/${owner.id}/revoke-teacher`, admin.id, {})
      .expect(409);
    expect(refused.body.code).toBe('RESOURCE_CONFLICT');
    expect(await roleStatus(owner.id, 'TEACHER')).toBe('ACTIVE');
    await t
      .call('post', `/admin/courses/${courseId}/ownership-transfer`, admin.id, {
        newOwnerId: heir.id,
      })
      .expect(200);
    await t
      .call('post', `/admin/users/${owner.id}/revoke-teacher`, admin.id, {})
      .expect(204);
    expect(await roleStatus(owner.id, 'TEACHER')).toBe('REVOKED');
  });

  const ownerRevoked = async () =>
    (
      await pool.query(
        `SELECT ct.course_id FROM course_teachers ct
          WHERE ct.role = 'OWNER' AND NOT EXISTS (
            SELECT 1 FROM user_roles r WHERE r.user_id = ct.user_id AND r.role = 'TEACHER' AND r.status = 'ACTIVE')`,
      )
    ).rowCount;

  async function transferWorld() {
    const admin = await createAdmin(pool);
    const owner = await createTeacher(pool);
    const heir = await createTeacher(pool);
    const courseId = await createPublishedCourse(pool);
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    await addCourseTeacher(pool, courseId, heir.id, 'ASSISTANT', owner.id);
    return { admin, owner, heir, courseId };
  }

  it('revoke vs ownership transfer, transfer first: the heir becomes Owner, so the revocation is refused', async () => {
    const { admin, heir, courseId } = await transferWorld();
    // the transfer holds the heir's User-S lock and promotes them; the revocation (User-X) waits and then sees an Owner
    const held = await holdTx(
      pool,
      'transfer',
      'SELECT 1 FROM users WHERE id = $1 FOR SHARE',
      [heir.id],
    );
    const revoke = t
      .call('post', `/admin/users/${heir.id}/revoke-teacher`, admin.id, {})
      .then((r) => r);
    expect(await settlesWithin(revoke, 300)).toBe(false);
    await held.client.query(
      "UPDATE course_teachers SET role = 'ASSISTANT' WHERE course_id = $1 AND role = 'OWNER'",
      [courseId],
    );
    await held.client.query(
      "UPDATE course_teachers SET role = 'OWNER' WHERE course_id = $1 AND user_id = $2",
      [courseId, heir.id],
    );
    await held.release('commit');
    expect((await revoke).status).toBe(409);
    expect(await roleStatus(heir.id, 'TEACHER')).toBe('ACTIVE');
    expect(await ownerRevoked()).toBe(0);
  });

  it('revoke vs ownership transfer, revoke first: the transfer finds a revoked Teacher and is refused', async () => {
    const { admin, owner, heir, courseId } = await transferWorld();
    const held = await holdTx(
      pool,
      'revoke',
      'SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE',
      [heir.id],
    );
    const transfer = t
      .call('post', `/admin/courses/${courseId}/ownership-transfer`, admin.id, {
        newOwnerId: heir.id,
      })
      .then((r) => r);
    expect(await settlesWithin(transfer, 300)).toBe(false);
    await held.client.query(
      "UPDATE user_roles SET status = 'REVOKED', decided_by = $2, decided_at = now() WHERE user_id = $1 AND role = 'TEACHER'",
      [heir.id, admin.id],
    );
    await held.release('commit');
    expect((await transfer).status).toBe(409);
    expect(
      (
        await pool.query(
          "SELECT user_id FROM course_teachers WHERE course_id = $1 AND role = 'OWNER'",
          [courseId],
        )
      ).rows,
    ).toEqual([{ user_id: owner.id }]);
    expect(await ownerRevoked()).toBe(0);
  });

  it('revoke vs transfer in parallel (10 rounds, both orders): there is never a revoked Owner', async () => {
    for (let round = 0; round < 10; round++) {
      await resetData(pool);
      const { admin, heir, courseId } = await transferWorld();
      const requests: request.Test[] = [
        t.call('post', `/admin/users/${heir.id}/revoke-teacher`, admin.id, {}),
        t.call(
          'post',
          `/admin/courses/${courseId}/ownership-transfer`,
          admin.id,
          {
            newOwnerId: heir.id,
          },
        ),
      ];
      if (round % 2 === 1) requests.reverse();
      const results = await Promise.all(requests);
      const ok = results.filter((r) => r.status < 300).length;
      expect(ok).toBe(1); // exactly one of them wins
      expect(await ownerRevoked()).toBe(0);
    }
  });
});

describe('the first-Admin seed', () => {
  let seeder: FirstAdminSeeder;
  beforeAll(() => {
    seeder = app.get(FirstAdminSeeder, { strict: false });
  });
  const input = {
    email: '  Root@Example.Test ',
    password: 'a perfectly fine passphrase',
    fullName: 'Root',
  };

  it('creates a verified Admin who can log in, and only when no Admin exists', async () => {
    const outcome = await seeder.run(input);
    expect(outcome.created).toBe(true);
    const user = await pool.query(
      'SELECT id, email, email_verified_at, status, password_hash FROM users',
    );
    expect(user.rows).toHaveLength(1);
    expect(user.rows[0].email).toBe('root@example.test');
    expect(user.rows[0].email_verified_at).not.toBeNull();
    expect(user.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    const roles = await pool.query(
      'SELECT role, status FROM user_roles WHERE user_id = $1 ORDER BY role',
      [user.rows[0].id],
    );
    expect(roles.rows).toEqual(
      expect.arrayContaining([
        { role: 'ADMIN', status: 'ACTIVE' },
        { role: 'STUDENT', status: 'ACTIVE' },
      ]),
    );
    expect(roles.rows).toHaveLength(2);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '10.98.0.1')
      .send({ email: 'root@example.test', password: input.password })
      .expect(200);
    const token = login.body.accessToken as string;
    await request(app.getHttpServer())
      .get('/api/v1/admin/stats')
      .set('X-Forwarded-For', '10.98.0.2')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(await auditRows('ADMIN_ROLE_GRANTED')).toHaveLength(1);
  });

  it('is idempotent: a second run, also with other settings, changes nothing', async () => {
    await seeder.run(input);
    const again = await seeder.run(input);
    expect(again).toEqual({ created: false, reason: 'ADMIN_EXISTS' });
    const other = await seeder.run({
      ...input,
      email: 'someone-else@example.test',
    });
    expect(other).toEqual({ created: false, reason: 'ADMIN_EXISTS' });
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(1);
  });

  it('does nothing when an Admin already exists (also one created some other way)', async () => {
    await createAdmin(pool);
    expect(await seeder.run(input)).toEqual({
      created: false,
      reason: 'ADMIN_EXISTS',
    });
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(1);
  });

  it('two parallel runs create one Admin', async () => {
    const results = await Promise.all([
      seeder.run(input),
      seeder.run(input),
      seeder.run(input),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await activeAdmins()).toBe(1);
  });

  it('refuses bad settings with a message that names the setting and never the value', async () => {
    await expect(
      seeder.run({ ...input, email: 'not-an-email' }),
    ).rejects.toThrow(SeedError);
    const weak = await seeder
      .run({ ...input, password: 'password1234' })
      .catch((e: unknown) => e as Error);
    expect(weak).toBeInstanceOf(SeedError);
    expect((weak as Error).message).toContain('SEED_ADMIN_PASSWORD');
    expect((weak as Error).message).not.toContain('password1234');
    await expect(seeder.run({ ...input, fullName: '  ' })).rejects.toThrow(
      SeedError,
    );
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(0);
  });

  it('refuses to take over an email that is already registered', async () => {
    await createUser(pool, { email: 'root@example.test' });
    await expect(seeder.run(input)).rejects.toThrow(/already registered/);
    expect(await activeAdmins()).toBe(0);
  });
});
