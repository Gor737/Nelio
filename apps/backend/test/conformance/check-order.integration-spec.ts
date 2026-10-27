// M13 conformance: the check order of docs/architecture.md section 13 and Decision 140, on real endpoints with the full guard stack:
//   429 -> 401 -> 403 ACCOUNT_SUSPENDED -> guards (404 visibility, 403 lock, 403 role) -> 400 input -> 409 state.
// Each test sends ONE request that is wrong in two ways at once and checks that the EARLIER check answers.
import { createPool, resetData } from '../support/database.js';
import {
  createAdmin,
  createTeacher,
  createUser,
} from '../support/factories.js';
import {
  addCourseTeacher,
  createPublishedCourse,
} from '../support/factories-courses.js';
import { createInvitation } from '../support/factories-learning.js';
import { createFullApp, type FullApp } from '../support/full-app.js';
import { TEST_JWT_SECRET } from '../support/integration-app.js';
import { mintAccessToken } from '../support/token-minter.js';

const pool = createPool(10);
let t: FullApp;

beforeAll(async () => {
  t = await createFullApp();
});
afterAll(async () => {
  await t.app.close();
  await pool.end();
});
beforeEach(() => resetData(pool));

const UNKNOWN = '018f0000-0000-7000-8000-0000000000aa';
const shape = (res: { status: number; body: { code?: string } }) => [
  res.status,
  res.body.code,
];

describe('429 comes before 401', () => {
  it('an anonymous caller over the TIGHT limit is throttled, not told to log in', async () => {
    const ip = '10.90.0.1';
    for (let i = 0; i < 20; i++)
      expect(shape(await t.call('get', '/users?q=ab', { ip }))).toEqual([
        401,
        'UNAUTHENTICATED',
      ]);
    expect(shape(await t.call('get', '/users?q=ab', { ip }))).toEqual([
      429,
      'TOO_MANY_REQUESTS',
    ]);
  });

  it('429 comes before 400: a malformed login over the STRICT limit is throttled, not validated', async () => {
    const ip = '10.90.0.2';
    for (let i = 0; i < 5; i++)
      expect(
        shape(await t.call('post', '/auth/login', { ip, body: {} })),
      ).toEqual([400, 'VALIDATION_FAILED']);
    expect(
      shape(await t.call('post', '/auth/login', { ip, body: {} })),
    ).toEqual([429, 'TOO_MANY_REQUESTS']);
  });

  it('the throttled answer carries Retry-After', async () => {
    const ip = '10.90.0.3';
    for (let i = 0; i < 5; i++)
      await t.call('post', '/auth/login', { ip, body: {} });
    const res = await t.call('post', '/auth/login', { ip, body: {} });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('401 comes before everything after it', () => {
  it('an invalid token on a route that would also be a 404 is a 401 (optional-login route)', async () => {
    const res = await t.call('get', `/courses/${UNKNOWN}`, {
      headers: { Authorization: 'Bearer garbage' },
    });
    expect(shape(res)).toEqual([401, 'UNAUTHENTICATED']);
  });

  it('a missing token on an Admin route with an invalid body is a 401, not a 403 or a 400', async () => {
    expect(
      shape(await t.call('post', '/admin/categories', { body: { nope: 1 } })),
    ).toEqual([401, 'UNAUTHENTICATED']);
  });

  it('an expired token of a suspended user is a 401, not ACCOUNT_SUSPENDED (the token is checked first)', async () => {
    const user = await createUser(pool, { status: 'SUSPENDED' });
    const old = mintAccessToken(user.id, {
      secret: TEST_JWT_SECRET,
      nowSeconds: Math.floor(Date.now() / 1000) - 3000,
    });
    expect(
      shape(
        await t.call('get', '/me', {
          headers: { Authorization: `Bearer ${old}` },
        }),
      ),
    ).toEqual([401, 'UNAUTHENTICATED']);
  });
});

describe('403 ACCOUNT_SUSPENDED comes before the guards, the validation and the state checks', () => {
  it('a suspended user gets ACCOUNT_SUSPENDED on a route that would be a 404, a 403 role error, and a 400', async () => {
    const user = await createUser(pool, { status: 'SUSPENDED' });
    for (const [method, path, body] of [
      ['get', `/courses/${UNKNOWN}`, undefined],
      ['post', '/courses', { nope: true }],
      ['post', '/admin/categories', { nope: true }],
      ['post', `/courses/${UNKNOWN}/publish`, undefined],
      ['patch', '/me', { role: 'ADMIN' }],
    ] as const) {
      expect([
        method,
        path,
        ...shape(await t.call(method, path, { userId: user.id, body })),
      ]).toEqual([method, path, 403, 'ACCOUNT_SUSPENDED']);
    }
  });
});

describe('the guards come before the validation', () => {
  it('a student sending a malformed body to a Teacher route gets TEACHER_NOT_APPROVED, to an Admin route FORBIDDEN', async () => {
    const student = await createUser(pool);
    expect(
      shape(
        await t.call('post', '/courses', {
          userId: student.id,
          body: { nope: 1 },
        }),
      ),
    ).toEqual([403, 'TEACHER_NOT_APPROVED']);
    expect(
      shape(
        await t.call('post', '/admin/users/not-a-uuid/suspend', {
          userId: student.id,
          body: { nope: 1 },
        }),
      ),
    ).toEqual([403, 'FORBIDDEN']);
  });

  it('a stranger sending a malformed body to an Owner route gets 403 FORBIDDEN; to a course they may not see, 404', async () => {
    const owner = await createTeacher(pool);
    const stranger = await createUser(pool);
    const open = await createPublishedCourse(pool);
    await addCourseTeacher(pool, open, owner.id, 'OWNER');
    expect(
      shape(
        await t.call('post', `/courses/${open}/assistants`, {
          userId: stranger.id,
          body: { userId: 'nope' },
        }),
      ),
    ).toEqual([403, 'FORBIDDEN']);
    const hidden = await createPublishedCourse(pool, {
      enrollmentPolicy: 'INVITATION_ONLY',
    });
    await addCourseTeacher(pool, hidden, owner.id, 'OWNER');
    expect(
      shape(
        await t.call('post', `/courses/${hidden}/assistants`, {
          userId: stranger.id,
          body: { userId: 'nope' },
        }),
      ),
    ).toEqual([404, 'NOT_FOUND']);
  });

  it('a malformed course id is a 400 from the guard, before any lookup', async () => {
    const user = await createUser(pool);
    expect(
      shape(await t.call('get', '/courses/not-a-uuid', { userId: user.id })),
    ).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('400 comes before 409', () => {
  it('a malformed body that would also conflict with the state is a 400', async () => {
    const owner = await createTeacher(pool);
    const course = await createPublishedCourse(pool, {
      enrollmentPolicy: 'INVITATION_ONLY',
    });
    await addCourseTeacher(pool, course, owner.id, 'OWNER');
    const invitee = await createUser(pool);
    await createInvitation(pool, course, invitee.id, owner.id); // a pending invitation exists: inviting again would be 409
    expect(
      shape(
        await t.call('post', `/courses/${course}/invitations`, {
          userId: owner.id,
          body: { userId: invitee.id, extra: 1 },
        }),
      ),
    ).toEqual([400, 'VALIDATION_FAILED']);
    expect(
      shape(
        await t.call('post', `/courses/${course}/invitations`, {
          userId: owner.id,
          body: { userId: invitee.id },
        }),
      ),
    ).toEqual([409, 'INVITATION_PENDING']);
  });

  it('the Admin routes follow the same order: guard, then 400, then 409', async () => {
    const admin = await createAdmin(pool);
    expect(
      shape(
        await t.call('delete', `/admin/users/${admin.id}/admin-role`, {
          userId: admin.id,
        }),
      ),
    ).toEqual([409, 'LAST_PLATFORM_ADMIN']);
    expect(
      shape(
        await t.call('post', `/admin/users/${admin.id}/suspend`, {
          userId: admin.id,
          body: { reason: 1 },
        }),
      ),
    ).toEqual([400, 'VALIDATION_FAILED']);
    expect(
      shape(
        await t.call('post', `/admin/users/${admin.id}/suspend`, {
          userId: admin.id,
          body: {},
        }),
      ),
    ).toEqual([400, 'CANNOT_SUSPEND_SELF']);
  });
});
