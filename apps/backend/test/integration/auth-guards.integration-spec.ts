// M8: the authentication and role guards against the real database (Decision 152, architecture sections 11 and 12).
import { createHmac, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createPool, resetData } from '../support/database.js';
import { createUser, createUserWithRoles } from '../support/factories.js';
import {
  TEST_JWT_SECRET,
  bearer,
  closeApp,
  createGuardedApp,
} from '../support/integration-app.js';

const pool = createPool();
let app: NestExpressApplication;

beforeAll(async () => {
  app = await createGuardedApp();
});
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
beforeEach(() => resetData(pool));

const get = (path: string, authorization?: string) => {
  const req = request(app.getHttpServer()).get(`/api/v1${path}`);
  return authorization ? req.set('Authorization', authorization) : req;
};
const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const forge = (
  header: unknown,
  claims: unknown,
  secret = TEST_JWT_SECRET,
  algorithm = 'sha256',
) => {
  const data = `${b64(header)}.${b64(claims)}`;
  return `Bearer ${data}.${createHmac(algorithm, secret).update(data).digest('base64url')}`;
};
const now = () => Math.floor(Date.now() / 1000);

describe('JwtAuthGuard (secure by default)', () => {
  it('a valid token authenticates and only the user id and ACTIVE roles are attached', async () => {
    const user = await createUserWithRoles(pool, [
      { role: 'STUDENT', status: 'ACTIVE' },
      { role: 'TEACHER', status: 'PENDING' }, // a pending application grants nothing
    ]);
    const res = await get('/probe-auth/me', bearer(user.id)).expect(200);
    expect(res.body).toEqual({ id: user.id, roles: ['STUDENT'] });
  });

  it('rejects a missing token, a wrong scheme and a malformed header with the same 401', async () => {
    const bodies = [
      (await get('/probe-auth/me').expect(401)).body,
      (await get('/probe-auth/me', 'Basic abc').expect(401)).body,
      (await get('/probe-auth/me', 'Bearer').expect(401)).body,
      (await get('/probe-auth/me', 'Bearer not.a.token').expect(401)).body,
    ];
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({
      statusCode: 401,
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects a tampered token (another sub with the old signature, and a flipped signature)', async () => {
    const [victim, attacker] = [await createUser(pool), await createUser(pool)];
    const [head, payload, signature] = bearer(attacker.id)
      .slice('Bearer '.length)
      .split('.');
    const swapped = `${head}.${b64({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: victim.id })}.${signature}`;
    await get('/probe-auth/me', `Bearer ${swapped}`).expect(401);
    await get(
      '/probe-auth/me',
      `Bearer ${head}.${payload}.${signature.slice(0, -2)}AA`,
    ).expect(401);
  });

  it('rejects an expired token', async () => {
    const user = await createUser(pool);
    await get(
      '/probe-auth/me',
      bearer(user.id, { nowSeconds: now() - 2000 }),
    ).expect(401); // exp = 15 minutes after iat, long past
    await get('/probe-auth/me', bearer(user.id, { ttlSeconds: -1 })).expect(
      401,
    );
  });

  it('rejects a token with a wrong algorithm, however it is signed', async () => {
    const user = await createUser(pool);
    const claims = { sub: user.id, iat: now(), exp: now() + 900 };
    await get(
      '/probe-auth/me',
      forge({ alg: 'none', typ: 'JWT' }, claims, ''),
    ).expect(401);
    await get(
      '/probe-auth/me',
      `Bearer ${b64({ alg: 'none' })}.${b64(claims)}.`,
    ).expect(401);
    await get(
      '/probe-auth/me',
      forge({ alg: 'HS384', typ: 'JWT' }, claims, TEST_JWT_SECRET, 'sha384'),
    ).expect(401);
    await get(
      '/probe-auth/me',
      forge({ alg: 'RS256', typ: 'JWT' }, claims),
    ).expect(401);
    await get(
      '/probe-auth/me',
      forge({ alg: 'HS256', typ: 'JWT' }, claims),
    ).expect(200); // control: same claims, right algorithm
  });

  it('rejects a token signed with another secret', async () => {
    const user = await createUser(pool);
    const claims = { sub: user.id, iat: now(), exp: now() + 900 };
    await get(
      '/probe-auth/me',
      forge(
        { alg: 'HS256', typ: 'JWT' },
        claims,
        'some-other-secret-some-other-secret-xx',
      ),
    ).expect(401);
  });

  it('a valid token of a user that does not exist is 401 (not 404, not 500)', async () => {
    await get('/probe-auth/me', bearer(randomUUID())).expect(401);
  });

  it('a suspended user is 403 ACCOUNT_SUSPENDED on every non-public route, even with a valid token', async () => {
    const user = await createUser(pool, { status: 'SUSPENDED' });
    for (const path of [
      '/probe-auth/me',
      '/probe-auth/optional',
      '/probe-auth/teacher',
    ]) {
      const res = await get(path, bearer(user.id)).expect(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        code: 'ACCOUNT_SUSPENDED',
      });
    }
  });

  describe('tokens_valid_after (Decision 152: whole-second comparison)', () => {
    it('a token issued before it is 401, issued in the same second is accepted, issued after is accepted', async () => {
      const user = await createUser(pool);
      // 0.75 s into a second that is well in the past, so the minted tokens' exp is still in the future
      const second = now() - 100;
      await pool.query(
        'UPDATE users SET tokens_valid_after = $1 WHERE id = $2',
        [new Date(second * 1000 + 750), user.id],
      );
      const token = (iat: number) =>
        bearer(user.id, { nowSeconds: iat, ttlSeconds: 1000 });
      await get('/probe-auth/me', token(second - 1)).expect(401);
      await get('/probe-auth/me', token(second)).expect(200); // equal second accepted
      await get('/probe-auth/me', token(second + 1)).expect(200);
    });

    it('revoking later invalidates tokens that were valid a moment ago', async () => {
      const user = await createUser(pool);
      const old = bearer(user.id, { nowSeconds: now() - 5, ttlSeconds: 900 });
      await get('/probe-auth/me', old).expect(200);
      await pool.query(
        'UPDATE users SET tokens_valid_after = now() WHERE id = $1',
        [user.id],
      );
      await get('/probe-auth/me', old).expect(401);
      await get('/probe-auth/me', bearer(user.id)).expect(200); // a fresh token is fine
    });
  });

  it('suspending a user takes effect on the very next request (Decision 108: roles and status come from the database each time)', async () => {
    const user = await createUser(pool);
    const auth = bearer(user.id);
    await get('/probe-auth/me', auth).expect(200);
    await pool.query(
      "UPDATE users SET status = 'SUSPENDED', suspended_at = now() WHERE id = $1",
      [user.id],
    );
    await get('/probe-auth/me', auth).expect(403);
  });
});

describe('@Public and @OptionalAuth', () => {
  it('a public route ignores the Authorization header entirely, even a broken one', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/probe/items/018f0000-0000-7000-8000-000000000001')
      .set('Authorization', 'Bearer garbage')
      .expect(200);
  });

  it('optional auth: no token is anonymous, a valid token identifies the caller', async () => {
    const user = await createUser(pool);
    expect((await get('/probe-auth/optional').expect(200)).body).toEqual({
      id: null,
    });
    expect(
      (await get('/probe-auth/optional', bearer(user.id)).expect(200)).body,
    ).toEqual({ id: user.id });
  });

  it('optional auth: an INVALID or EXPIRED token is 401, never silently anonymous (Decision 152)', async () => {
    const user = await createUser(pool);
    await get('/probe-auth/optional', 'Bearer garbage').expect(401);
    await get(
      '/probe-auth/optional',
      bearer(user.id, { nowSeconds: now() - 2000 }),
    ).expect(401);
    await get('/probe-auth/optional', bearer(randomUUID())).expect(401); // unknown user
    await get('/probe-auth/optional', 'Basic abc').expect(401);
  });
});

describe('RolesGuard', () => {
  const asRoles = (roles: Parameters<typeof createUserWithRoles>[1]) =>
    createUserWithRoles(pool, roles);

  it('an ACTIVE Teacher passes a Teacher route', async () => {
    const teacher = await asRoles([
      { role: 'STUDENT', status: 'ACTIVE' },
      { role: 'TEACHER', status: 'ACTIVE' },
    ]);
    await get('/probe-auth/teacher', bearer(teacher.id)).expect(200);
  });

  it.each(['PENDING', 'REJECTED', 'REVOKED'] as const)(
    'a %s Teacher on a Teacher route is 403 TEACHER_NOT_APPROVED',
    async (status) => {
      const user = await asRoles([
        { role: 'STUDENT', status: 'ACTIVE' },
        { role: 'TEACHER', status },
      ]);
      const res = await get('/probe-auth/teacher', bearer(user.id)).expect(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        code: 'TEACHER_NOT_APPROVED',
      });
    },
  );

  it('a plain student, and an Admin without the Teacher role, get TEACHER_NOT_APPROVED on a Teacher route', async () => {
    const student = await asRoles([{ role: 'STUDENT', status: 'ACTIVE' }]);
    const admin = await asRoles([
      { role: 'STUDENT', status: 'ACTIVE' },
      { role: 'ADMIN', status: 'ACTIVE' },
    ]);
    for (const user of [student, admin])
      expect(
        (await get('/probe-auth/teacher', bearer(user.id)).expect(403)).body
          .code,
      ).toBe('TEACHER_NOT_APPROVED');
  });

  it('an Admin route is FORBIDDEN (not TEACHER_NOT_APPROVED) for a student or a Teacher, and open to an ACTIVE Admin', async () => {
    const teacher = await asRoles([
      { role: 'STUDENT', status: 'ACTIVE' },
      { role: 'TEACHER', status: 'ACTIVE' },
    ]);
    const admin = await asRoles([
      { role: 'STUDENT', status: 'ACTIVE' },
      { role: 'ADMIN', status: 'ACTIVE' },
    ]);
    const revokedAdmin = await asRoles([
      { role: 'STUDENT', status: 'ACTIVE' },
      { role: 'ADMIN', status: 'REVOKED' },
    ]);
    expect(
      (await get('/probe-auth/admin', bearer(teacher.id)).expect(403)).body
        .code,
    ).toBe('FORBIDDEN');
    expect(
      (await get('/probe-auth/admin', bearer(revokedAdmin.id)).expect(403)).body
        .code,
    ).toBe('FORBIDDEN');
    await get('/probe-auth/admin', bearer(admin.id)).expect(200);
  });

  it('a role change takes effect immediately (roles are read from the database, not the token)', async () => {
    const user = await asRoles([
      { role: 'STUDENT', status: 'ACTIVE' },
      { role: 'TEACHER', status: 'PENDING' },
    ]);
    const auth = bearer(user.id);
    await get('/probe-auth/teacher', auth).expect(403);
    await pool.query(
      "UPDATE user_roles SET status = 'ACTIVE' WHERE user_id = $1 AND role = 'TEACHER'",
      [user.id],
    );
    await get('/probe-auth/teacher', auth).expect(200);
    await pool.query(
      "UPDATE user_roles SET status = 'REVOKED' WHERE user_id = $1 AND role = 'TEACHER'",
      [user.id],
    );
    await get('/probe-auth/teacher', auth).expect(403);
  });
});
