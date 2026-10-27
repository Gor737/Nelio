// M13 conformance: the error registry (docs/architecture.md section 13, Decisions 137 and 140). Every code in `ERROR_CODES` has a reproducer
// below (a `Record<ErrorCode, ...>` makes TypeScript refuse to compile when a code is added without one), every reproducer is run through
// real HTTP, and the answer must carry exactly that code with a status the registry allows for it. The last tests check the registry itself.
import { jest } from '@jest/globals';
import request from 'supertest';
import {
  ERROR_CODES,
  type ErrorCode,
} from '../../src/common/constants/error-codes.js';
import { UsersService } from '../../src/modules/users/services/users.service.js';
import { PasswordService } from '../../src/modules/auth/index.js';
import { createPool, resetData } from '../support/database.js';
import {
  createAdmin,
  createTeacher,
  createUser,
} from '../support/factories.js';
import { createGroup } from '../support/factories-chat.js';
import { createSection } from '../support/factories-content.js';
import {
  addCourseTeacher,
  createCourse,
  createPublishedCourse,
} from '../support/factories-courses.js';
import { createEnrollment } from '../support/factories-learning.js';
import { SAMPLE } from '../support/in-memory-storage.js';
import { createFullApp, type FullApp } from '../support/full-app.js';
import { bearer } from '../support/integration-app.js';
import { holdTx } from '../support/parallel-tx.js';

const pool = createPool(10);
let t: FullApp;
let passwords: PasswordService;

beforeAll(async () => {
  t = await createFullApp();
  passwords = t.app.get(PasswordService, { strict: false });
});
afterAll(async () => {
  await t.app.close();
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  jest.restoreAllMocks();
  t.storage.failPut = false;
});

const UNKNOWN = '018f0000-0000-7000-8000-0000000000aa';
const PASSWORD = 'a perfectly fine passphrase';

type Reproducer = () => Promise<request.Response>;

/** A user with a real password hash, so login-dependent endpoints work. */
async function userWithPassword() {
  const user = await createUser(pool);
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
    user.id,
    await passwords.hash(PASSWORD),
  ]);
  return user;
}
async function owned(status: 'PUBLISHED' | 'ARCHIVED' | 'DRAFT' = 'PUBLISHED') {
  const owner = await createTeacher(pool);
  const courseId =
    status === 'DRAFT'
      ? await createCourse(pool)
      : await createPublishedCourse(pool, {
          status,
          archivedAt: status === 'ARCHIVED' ? new Date() : null,
        });
  await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
  return { owner, courseId };
}
async function locked() {
  const w = await owned('ARCHIVED');
  await pool.query(
    'UPDATE courses SET locked_by_admin_at = now() WHERE id = $1',
    [w.courseId],
  );
  return w;
}

const REPRODUCERS: Record<ErrorCode, Reproducer> = {
  VALIDATION_FAILED: () => t.call('post', '/auth/login', { body: {} }),
  UNAUTHENTICATED: () => t.call('get', '/me'),
  ACCOUNT_SUSPENDED: async () => {
    const user = await createUser(pool, { status: 'SUSPENDED' });
    return t.call('get', '/me', { userId: user.id });
  },
  FORBIDDEN: async () => {
    const user = await createUser(pool);
    return t.call('get', '/admin/stats', { userId: user.id });
  },
  TEACHER_NOT_APPROVED: async () => {
    const user = await createUser(pool);
    return t.call('post', '/courses', {
      userId: user.id,
      body: { title: 'A course', enrollmentPolicy: 'OPEN' },
    });
  },
  NOT_FOUND: () => t.call('get', `/courses/${UNKNOWN}`),
  TOO_MANY_REQUESTS: async () => {
    const ip = '10.77.0.1';
    let last!: request.Response;
    for (let i = 0; i < 6; i++)
      last = await t.call('post', '/auth/login', {
        ip,
        body: { email: 'nobody@example.test', password: PASSWORD },
      });
    return last;
  },
  INTERNAL_ERROR: async () => {
    const user = await createUser(pool);
    jest
      .spyOn(t.app.get(UsersService, { strict: false }), 'getMe')
      .mockRejectedValueOnce(new Error('unexpected'));
    return t.call('get', '/me', { userId: user.id });
  },
  RESOURCE_CONFLICT: async () => {
    const admin = await createAdmin(pool);
    await t.call('post', '/admin/categories', {
      userId: admin.id,
      body: { name: 'Design' },
    });
    return t.call('post', '/admin/categories', {
      userId: admin.id,
      body: { name: 'design' },
    });
  },
  INVALID_CURRENT_PASSWORD: async () => {
    const user = await userWithPassword();
    return t.call('post', '/auth/change-password', {
      userId: user.id,
      body: {
        currentPassword: 'not the password at all',
        newPassword: 'another fine passphrase',
      },
    });
  },
  TOKEN_INVALID: () =>
    t.call('post', '/auth/verify-email', { body: { token: 'x'.repeat(43) } }),
  NO_LOGIN_METHOD_REMAINING: async () => {
    const user = await createUser(pool);
    await pool.query('UPDATE users SET password_hash = NULL WHERE id = $1', [
      user.id,
    ]);
    await pool.query(
      "INSERT INTO auth_identities (user_id, provider, provider_account_id) VALUES ($1, 'GOOGLE', 'sub-1')",
      [user.id],
    );
    return t.call('delete', '/auth/google', { userId: user.id });
  },
  COURSE_ARCHIVED: async () => {
    const { owner, courseId } = await owned('ARCHIVED');
    return t.call('patch', `/courses/${courseId}`, {
      userId: owner.id,
      body: { title: 'New title here' },
    });
  },
  COURSE_ADMIN_LOCKED: async () => {
    const { courseId } = await locked();
    const student = await createUser(pool);
    await createEnrollment(pool, courseId, student.id);
    return t.call('get', `/courses/${courseId}`, { userId: student.id }); // 403; the 409 form is checked separately below
  },
  COURSE_ALREADY_LOCKED: async () => {
    const admin = await createAdmin(pool);
    const { courseId } = await locked();
    return t.call('post', `/admin/courses/${courseId}/lock`, {
      userId: admin.id,
      body: { reason: 'Terms violation' },
    });
  },
  COURSE_NOT_LOCKED: async () => {
    const admin = await createAdmin(pool);
    const { courseId } = await owned();
    return t.call('post', `/admin/courses/${courseId}/unlock`, {
      userId: admin.id,
    });
  },
  INVALID_STATE_TRANSITION: async () => {
    const { owner, courseId } = await owned();
    return t.call('post', `/courses/${courseId}/publish`, { userId: owner.id });
  },
  ORDER_MISMATCH: async () => {
    const { owner, courseId } = await owned();
    await createSection(pool, courseId);
    return t.call('post', `/courses/${courseId}/sections/reorder`, {
      userId: owner.id,
      body: { ids: [UNKNOWN] },
    });
  },
  INVITATION_REQUIRED: async () => {
    const owner = await createTeacher(pool);
    const courseId = await createPublishedCourse(pool, {
      enrollmentPolicy: 'INVITATION_ONLY',
    });
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    const student = await createUser(pool);
    // an INVITATION_ONLY course is hidden (404) from strangers: a LEFT student sees it and is told an invitation is needed
    await createEnrollment(pool, courseId, student.id, {
      status: 'LEFT',
      leftAt: new Date(),
    });
    return t.call('post', `/courses/${courseId}/enrollments`, {
      userId: student.id,
    });
  },
  INVITATION_PENDING: async () => {
    const owner = await createTeacher(pool);
    const courseId = await createPublishedCourse(pool, {
      enrollmentPolicy: 'INVITATION_ONLY',
    });
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    const invitee = await createUser(pool);
    await t.call('post', `/courses/${courseId}/invitations`, {
      userId: owner.id,
      body: { userId: invitee.id },
    });
    return t.call('post', `/courses/${courseId}/invitations`, {
      userId: owner.id,
      body: { userId: invitee.id },
    });
  },
  ALREADY_ENROLLED: async () => {
    const { courseId } = await owned();
    const student = await createUser(pool);
    await createEnrollment(pool, courseId, student.id);
    return t.call('post', `/courses/${courseId}/enrollments`, {
      userId: student.id,
    });
  },
  APPLICATION_PENDING: async () => {
    const user = await createUser(pool);
    await pool.query(
      "INSERT INTO user_roles (user_id, role, status, application_message) VALUES ($1, 'TEACHER', 'PENDING', 'I would like to teach')",
      [user.id],
    );
    return t.call('post', '/me/teacher-application', {
      userId: user.id,
      body: { message: 'I would like to teach maths' },
    });
  },
  ALREADY_TEACHER: async () => {
    const teacher = await createTeacher(pool);
    return t.call('post', '/me/teacher-application', {
      userId: teacher.id,
      body: { message: 'I would like to teach maths' },
    });
  },
  LAST_PLATFORM_ADMIN: async () => {
    const admin = await createAdmin(pool);
    return t.call('delete', `/admin/users/${admin.id}/admin-role`, {
      userId: admin.id,
    });
  },
  CANNOT_SUSPEND_SELF: async () => {
    const admin = await createAdmin(pool);
    return t.call('post', `/admin/users/${admin.id}/suspend`, {
      userId: admin.id,
      body: {},
    });
  },
  CANNOT_BLOCK_SELF: async () => {
    const user = await createUser(pool);
    return t.call('put', `/me/blocks/${user.id}`, { userId: user.id });
  },
  CANNOT_BLOCK_ADMIN: async () => {
    const admin = await createAdmin(pool);
    const user = await createUser(pool);
    return t.call('put', `/me/blocks/${admin.id}`, { userId: user.id });
  },
  LAST_GROUP_ADMIN: async () => {
    const creator = await createUser(pool);
    const member = await createUser(pool);
    const group = await createGroup(pool, creator.id, [member.id]);
    return t.call('patch', `/conversations/${group}/members/${creator.id}`, {
      userId: creator.id,
      body: { role: 'MEMBER' },
    });
  },
  MEMBERS_UNAVAILABLE: async () => {
    const creator = await createUser(pool);
    const other = await createUser(pool);
    const group = await createGroup(pool, creator.id, []);
    await pool.query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)',
      [other.id, creator.id],
    );
    return t.call('post', `/conversations/${group}/members`, {
      userId: creator.id,
      body: { userIds: [other.id] },
    });
  },
  CANNOT_MESSAGE_USER: async () => {
    const a = await createUser(pool);
    const b = await createUser(pool);
    await pool.query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)',
      [b.id, a.id],
    );
    return t.call('post', '/conversations/direct', {
      userId: a.id,
      body: { userId: b.id },
    });
  },
  CLIENT_ID_REUSED: async () => {
    const creator = await createUser(pool);
    const group = await createGroup(pool, creator.id, []);
    const clientId = '0191a000-0000-7000-8000-000000000001';
    await t.call('post', `/conversations/${group}/messages`, {
      userId: creator.id,
      body: { body: 'first', clientId },
    });
    return t.call('post', `/conversations/${group}/messages`, {
      userId: creator.id,
      body: { body: 'different', clientId },
    });
  },
  REPORT_ALREADY_RESOLVED: async () => {
    const admin = await createAdmin(pool);
    const reporter = await createUser(pool);
    const target = await createUser(pool);
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO reports (reporter_id, target_type, target_user_id, reason) VALUES ($1, 'USER', $2, 'SPAM') RETURNING id",
      [reporter.id, target.id],
    );
    await t.call('post', `/admin/reports/${rows[0].id}/dismiss`, {
      userId: admin.id,
      body: {},
    });
    return t.call('post', `/admin/reports/${rows[0].id}/dismiss`, {
      userId: admin.id,
      body: {},
    });
  },
  FILE_TOO_LARGE: async () => {
    const user = await createUser(pool);
    return request(t.app.getHttpServer())
      .post('/api/v1/files')
      .set('X-Forwarded-For', '10.78.0.1')
      .set('Authorization', bearer(user.id))
      .field('kind', 'AVATAR')
      .attach('file', SAMPLE.png(3 * 1024 * 1024), { filename: 'a.png' });
  },
  FILE_TYPE_NOT_ALLOWED: async () => {
    const user = await createUser(pool);
    return request(t.app.getHttpServer())
      .post('/api/v1/files')
      .set('X-Forwarded-For', '10.78.0.2')
      .set('Authorization', bearer(user.id))
      .field('kind', 'AVATAR')
      .attach('file', Buffer.from('just some text, not an image'), {
        filename: 'a.png',
      });
  },
  FILE_IN_USE: async () => {
    const user = await createUser(pool);
    const upload = await request(t.app.getHttpServer())
      .post('/api/v1/files')
      .set('X-Forwarded-For', '10.78.0.3')
      .set('Authorization', bearer(user.id))
      .field('kind', 'AVATAR')
      .attach('file', SAMPLE.png(), { filename: 'a.png' })
      .expect(201);
    await pool.query('UPDATE users SET avatar_file_id = $2 WHERE id = $1', [
      user.id,
      upload.body.id,
    ]);
    return t.call('delete', `/files/${upload.body.id}`, { userId: user.id });
  },
  SERVICE_UNAVAILABLE: async () => {
    const user = await createUser(pool);
    t.storage.failPut = true;
    return request(t.app.getHttpServer())
      .post('/api/v1/files')
      .set('X-Forwarded-For', '10.78.0.4')
      .set('Authorization', bearer(user.id))
      .field('kind', 'AVATAR')
      .attach('file', SAMPLE.png(), { filename: 'a.png' });
  },
};

const allowedStatuses = (code: ErrorCode): readonly number[] => {
  const status = ERROR_CODES[code].status;
  return Array.isArray(status) ? status : [status as number];
};

describe('every code in the registry can be produced, with its registered status', () => {
  it('has a reproducer for exactly the registered codes', () => {
    expect(Object.keys(REPRODUCERS).sort()).toEqual(
      Object.keys(ERROR_CODES).sort(),
    );
  });

  it.each(Object.keys(ERROR_CODES) as ErrorCode[])('%s', async (code) => {
    const res = await REPRODUCERS[code]();
    expect([code, res.body.code]).toEqual([code, code]);
    expect(allowedStatuses(code)).toContain(res.status);
    expect(res.body.statusCode).toBe(res.status);
    expect(typeof res.body.message).toBe('string');
  });

  it('COURSE_ADMIN_LOCKED is 409 when a teacher mutation is refused, and takes precedence over COURSE_ARCHIVED', async () => {
    const { owner, courseId } = await locked(); // archived AND locked
    const res = await t.call('patch', `/courses/${courseId}`, {
      userId: owner.id,
      body: { title: 'New title here' },
    });
    expect([res.status, res.body.code]).toEqual([409, 'COURSE_ADMIN_LOCKED']);
    const restore = await t.call('post', `/courses/${courseId}/restore`, {
      userId: owner.id,
    });
    expect([restore.status, restore.body.code]).toEqual([
      409,
      'COURSE_ADMIN_LOCKED',
    ]);
  });

  it('a database lock timeout is a 503 SERVICE_UNAVAILABLE, never a 500', async () => {
    const owner = await createTeacher(pool);
    const courseId = await createPublishedCourse(pool);
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    // hold the course row, so the Owner's archive (Course-X) waits until the lock timeout
    const held = await holdTx(
      pool,
      'course',
      'SELECT 1 FROM courses WHERE id = $1 FOR NO KEY UPDATE',
      [courseId],
    );
    try {
      const res = await t.call('post', `/courses/${courseId}/archive`, {
        userId: owner.id,
      });
      expect([res.status, res.body.code]).toEqual([503, 'SERVICE_UNAVAILABLE']);
    } finally {
      await held.release('rollback');
    }
  }, 30000);
});

describe('the registry itself', () => {
  it('every status is one the status test allows, and only COURSE_ADMIN_LOCKED has two', () => {
    const allowed = new Set([400, 401, 403, 404, 409, 413, 415, 429, 500, 503]);
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      const statuses = Array.isArray(spec.status) ? spec.status : [spec.status];
      for (const status of statuses)
        expect([code, allowed.has(status)]).toEqual([code, true]);
      if (statuses.length === 2) expect(code).toBe('COURSE_ADMIN_LOCKED');
    }
  });

  it('codes are SCREAMING_SNAKE_CASE with a description', () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(spec.description.length).toBeGreaterThan(10);
    }
  });
});
