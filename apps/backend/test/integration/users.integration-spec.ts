// M10a: Users against the real database: /me, name search, public profiles, the Teacher application and the primitives Auth and Admin compose.
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
  type EventContracts,
  EventsModule,
} from '../../src/infrastructure/events/index.js';
import {
  UserAccountService,
  UsersModule,
} from '../../src/modules/users/index.js';
import { createPool, resetData } from '../support/database.js';
import {
  createAdmin,
  createFile,
  createTeacher,
  createUser,
  createUserWithRoles,
} from '../support/factories.js';
import { bearer, closeApp, testEnv } from '../support/integration-app.js';
import { holdTx, releaseAll, settlesWithin } from '../support/parallel-tx.js';

const pool = createPool(20);
let app: NestExpressApplication;
let bus: EventBus;
let accounts: UserAccountService;
let transactions: TransactionService;
const events: { name: string; payload: unknown }[] = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      UsersModule,
    ],
    providers: GLOBAL_PROVIDERS,
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  bus = app.get(EventBus);
  accounts = app.get(UserAccountService, { strict: false });
  transactions = app.get(TransactionService);
  for (const name of [
    'teacher-application.received',
    'teacher-application.approved',
    'teacher-application.rejected',
    'teacher-role.revoked',
  ] as const)
    bus.on(name, (payload: EventContracts[typeof name]) => {
      events.push({ name, payload });
    });
});
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  events.length = 0;
});
afterEach(() => releaseAll());

let counter = 0;
const ip = () => `10.4.${(counter >> 8) & 255}.${counter++ & 255}`;
const as = (userId: string) => ({
  get: (path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', ip()),
  patch: (path: string, body: object) =>
    request(app.getHttpServer())
      .patch(`/api/v1${path}`)
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', ip())
      .send(body),
  post: (path: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', ip())
      .send(body),
});
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; status?: number; message: string };
  }
  throw new Error('expected a rejection');
};
const roleRow = async (userId: string, role = 'TEACHER') =>
  (
    await pool.query(
      'SELECT status, application_message, decision_note, decided_by, decided_at FROM user_roles WHERE user_id = $1 AND role = $2',
      [userId, role],
    )
  ).rows[0];
const audits = async (action: string) =>
  (
    await pool.query(
      'SELECT actor_id, target_id, metadata FROM audit_logs WHERE action = $1 ORDER BY created_at',
      [action],
    )
  ).rows;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GET /me', () => {
  it("returns my account with the email and every role row; nobody else's response contains an email", async () => {
    const me = await createUserWithRoles(
      pool,
      [
        { role: 'STUDENT', status: 'ACTIVE' },
        { role: 'TEACHER', status: 'PENDING' },
      ],
      { email: 'Me.Person@example.test', fullName: 'Աննա Մ' },
    );
    const res = await as(me.id).get('/me').expect(200);
    expect(res.body).toMatchObject({
      id: me.id,
      email: 'Me.Person@example.test',
      fullName: 'Աննա Մ',
      avatarUrl: null,
      emailVerified: true,
      roles: [
        { role: 'STUDENT', status: 'ACTIVE' },
        { role: 'TEACHER', status: 'PENDING' },
      ],
    });
    expect(Object.keys(res.body).sort()).toEqual([
      'avatarUrl',
      'createdAt',
      'email',
      'emailVerified',
      'fullName',
      'id',
      'roles',
    ]);
    const other = await createUser(pool, { fullName: 'Someone Else' });
    for (const path of ['/users?q=Someone', `/users/${other.id}`]) {
      const body = JSON.stringify((await as(me.id).get(path).expect(200)).body);
      expect(body).not.toContain(other.email);
      expect(body).not.toContain('@');
    }
  });

  it('needs a signed-in user', async () => {
    await request(app.getHttpServer()).get('/api/v1/me').expect(401);
    await request(app.getHttpServer()).get('/api/v1/users?q=ab').expect(401);
  });
});

describe('PATCH /me', () => {
  it('changes the name (trimmed, Armenian and emoji fine) and returns the account', async () => {
    const me = await createUser(pool);
    const res = await as(me.id)
      .patch('/me', { fullName: '  Գոռ 😀  ' })
      .expect(200);
    expect(res.body.fullName).toBe('Գոռ 😀');
    expect(
      (await pool.query('SELECT full_name FROM users WHERE id = $1', [me.id]))
        .rows[0].full_name,
    ).toBe('Գոռ 😀');
  });

  it('mass assignment is rejected: role, roles, status, email, id, tokensValidAfter and anything else unknown are 400 and change nothing', async () => {
    const me = await createUser(pool, { fullName: 'Original' });
    await pool.query(
      "INSERT INTO user_roles (user_id, role, status) VALUES ($1, 'STUDENT', 'ACTIVE')",
      [me.id],
    );
    for (const body of [
      { role: 'ADMIN' },
      { roles: [{ role: 'ADMIN', status: 'ACTIVE' }] },
      { status: 'ACTIVE', fullName: 'Hacked' },
      { email: 'new@example.test' },
      { id: '019d0000-0000-7000-8000-000000000000' },
      { tokensValidAfter: '2000-01-01T00:00:00Z' },
      { emailVerifiedAt: '2000-01-01T00:00:00Z' },
    ]) {
      await as(me.id).patch('/me', body).expect(400);
    }
    const row = (
      await pool.query(
        'SELECT full_name, email, status FROM users WHERE id = $1',
        [me.id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      full_name: 'Original',
      email: me.email,
      status: 'ACTIVE',
    });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'ADMIN'",
          [me.id],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('validates the name: empty, blank and over 100 code points are 400; exactly 100 emoji are accepted by the API and the CHECK', async () => {
    const me = await createUser(pool);
    await as(me.id).patch('/me', { fullName: '' }).expect(400);
    await as(me.id).patch('/me', { fullName: '    ' }).expect(400);
    await as(me.id)
      .patch('/me', { fullName: 'x'.repeat(101) })
      .expect(400);
    await as(me.id).patch('/me', { fullName: 5 }).expect(400);
    await as(me.id)
      .patch('/me', { fullName: '😀'.repeat(100) })
      .expect(200);
  });

  it('an empty body changes nothing and is 200', async () => {
    const me = await createUser(pool, { fullName: 'Same' });
    expect((await as(me.id).patch('/me', {}).expect(200)).body.fullName).toBe(
      'Same',
    );
  });

  it('the avatar must be my own AVATAR upload; null removes it; the URL is public', async () => {
    const [me, other] = [await createUser(pool), await createUser(pool)];
    const mine = await createFile(pool, me.id, { kind: 'AVATAR' });
    const theirs = await createFile(pool, other.id, { kind: 'AVATAR' });
    const cover = await createFile(pool, me.id, { kind: 'COURSE_COVER' });
    await as(me.id).patch('/me', { avatarFileId: theirs }).expect(404);
    await as(me.id).patch('/me', { avatarFileId: cover }).expect(404);
    await as(me.id)
      .patch('/me', { avatarFileId: '019d0000-0000-7000-8000-000000000000' })
      .expect(404);
    await as(me.id).patch('/me', { avatarFileId: 'nope' }).expect(400);
    const set = await as(me.id)
      .patch('/me', { avatarFileId: mine })
      .expect(200);
    expect(set.body.avatarUrl).toMatch(/^https?:\/\//);
    expect(
      (await as(other.id).get(`/users/${me.id}`).expect(200)).body.avatarUrl,
    ).toBe(set.body.avatarUrl);
    expect(
      (await as(me.id).patch('/me', { avatarFileId: null }).expect(200)).body
        .avatarUrl,
    ).toBeNull();
  });
});

describe('user search and public profiles', () => {
  it('needs at least 2 characters (after trimming) and returns at most 20, only id, name and avatar', async () => {
    const me = await createUser(pool);
    for (let i = 0; i < 25; i++)
      await createUser(pool, {
        fullName: `Armen ${String(i).padStart(2, '0')}`,
      });
    await as(me.id).get('/users').expect(400);
    await as(me.id).get('/users?q=a').expect(400);
    await as(me.id).get('/users?q=%20a%20').expect(400);
    await as(me.id)
      .get(`/users?q=${'x'.repeat(101)}`)
      .expect(400);
    const res = await as(me.id).get('/users?q=armen').expect(200);
    expect(res.body).toHaveLength(20);
    for (const item of res.body)
      expect(Object.keys(item).sort()).toEqual(['avatarUrl', 'fullName', 'id']);
  });

  it('matches anywhere in the name, case-insensitive, Armenian included; names that start with the text come first', async () => {
    const me = await createUser(pool);
    await createUser(pool, { fullName: 'Mary Anna' });
    await createUser(pool, { fullName: 'Anna Petrosyan' });
    await createUser(pool, { fullName: 'Աննա Պետրոսյան' });
    const names = (await as(me.id).get('/users?q=ANNA').expect(200)).body.map(
      (u: { fullName: string }) => u.fullName,
    );
    expect(names).toEqual(['Anna Petrosyan', 'Mary Anna']);
    expect(
      (
        await as(me.id)
          .get(`/users?q=${encodeURIComponent('պետր')}`)
          .expect(200)
      ).body,
    ).toHaveLength(1);
  });

  it('LIKE wildcards in the query are literal text', async () => {
    const me = await createUser(pool);
    await createUser(pool, { fullName: 'Fifty 50% Off' });
    await createUser(pool, { fullName: 'Plain Person' });
    expect(
      (await as(me.id).get('/users?q=0%25').expect(200)).body,
    ).toHaveLength(1);
    expect((await as(me.id).get('/users?q=__').expect(200)).body).toHaveLength(
      0,
    );
    expect(
      (
        await as(me.id)
          .get(`/users?q=${encodeURIComponent('\\')}x`)
          .expect(200)
      ).body,
    ).toHaveLength(0);
  });

  it('suspended users are not found and have no profile; unknown ids are 404; a malformed id is 400', async () => {
    const me = await createUser(pool);
    const suspended = await createUser(pool, {
      fullName: 'Gone Person',
      status: 'SUSPENDED',
    });
    const active = await createUser(pool, { fullName: 'Here Person' });
    expect(
      (await as(me.id).get('/users?q=Person').expect(200)).body.map(
        (u: { id: string }) => u.id,
      ),
    ).toEqual([active.id]);
    await as(me.id).get(`/users/${suspended.id}`).expect(404);
    await as(me.id)
      .get('/users/019d0000-0000-7000-8000-000000000000')
      .expect(404);
    await as(me.id).get('/users/nope').expect(400);
    expect(
      (await as(me.id).get(`/users/${active.id}`).expect(200)).body,
    ).toEqual({ id: active.id, fullName: 'Here Person', avatarUrl: null });
  });

  it('the name search is served by the trigram index', async () => {
    await pool.query(
      `INSERT INTO users (email, full_name, status, password_hash)
       SELECT 'idx' || g || '@example.test', 'Person ' || md5(g::text), 'ACTIVE', 'x' FROM generate_series(1, 4000) g`,
    );
    await pool.query('ANALYZE users');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = (
        await client.query<{ 'QUERY PLAN': string }>(
          "EXPLAIN SELECT id FROM users WHERE status = 'ACTIVE' AND full_name ILIKE '%abc%' ESCAPE '\\'",
        )
      ).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      expect(plan).toContain('users_full_name_trgm_idx');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('Teacher application', () => {
  const message = 'I teach Armenian and want to publish courses.';

  it('GET says NONE before the first application', async () => {
    const me = await createUser(pool);
    expect(
      (await as(me.id).get('/me/teacher-application').expect(200)).body,
    ).toEqual({
      status: 'NONE',
      message: null,
      decisionNote: null,
      decidedAt: null,
    });
  });

  it('POST creates a PENDING application and tells the Admins after commit', async () => {
    const me = await createUser(pool);
    const res = await as(me.id)
      .post('/me/teacher-application', { message })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'PENDING', message });
    expect(await roleRow(me.id)).toMatchObject({
      status: 'PENDING',
      application_message: message,
    });
    expect(events).toEqual([
      { name: 'teacher-application.received', payload: { applicantId: me.id } },
    ]);
  });

  it('validates the message (10-1000 code points) and rejects other properties', async () => {
    const me = await createUser(pool);
    await as(me.id).post('/me/teacher-application', {}).expect(400);
    await as(me.id)
      .post('/me/teacher-application', { message: 'short' })
      .expect(400);
    await as(me.id)
      .post('/me/teacher-application', { message: 'x'.repeat(1001) })
      .expect(400);
    await as(me.id)
      .post('/me/teacher-application', { message, status: 'ACTIVE' })
      .expect(400);
    await as(me.id)
      .post('/me/teacher-application', { message: '😀'.repeat(1000) })
      .expect(201);
  });

  it('a second application while one is PENDING is 409 APPLICATION_PENDING and changes nothing', async () => {
    const me = await createUser(pool);
    await as(me.id).post('/me/teacher-application', { message }).expect(201);
    const res = await as(me.id)
      .post('/me/teacher-application', {
        message: 'A different message, long enough.',
      })
      .expect(409);
    expect(res.body.code).toBe('APPLICATION_PENDING');
    expect((await roleRow(me.id)).application_message).toBe(message);
    expect(events).toHaveLength(1);
  });

  it('an ACTIVE Teacher is 409 ALREADY_TEACHER, including an Admin who is also a Teacher; an Admin without the Teacher role may apply', async () => {
    const teacher = await createTeacher(pool);
    expect(
      (
        await as(teacher.id)
          .post('/me/teacher-application', { message })
          .expect(409)
      ).body.code,
    ).toBe('ALREADY_TEACHER');
    const adminTeacher = await createUserWithRoles(pool, [
      { role: 'STUDENT', status: 'ACTIVE' },
      { role: 'ADMIN', status: 'ACTIVE' },
      { role: 'TEACHER', status: 'ACTIVE' },
    ]);
    expect(
      (
        await as(adminTeacher.id)
          .post('/me/teacher-application', { message })
          .expect(409)
      ).body.code,
    ).toBe('ALREADY_TEACHER');
    const admin = await createAdmin(pool);
    await as(admin.id).post('/me/teacher-application', { message }).expect(201);
  });

  it.each(['REJECTED', 'REVOKED'] as const)(
    'applying again after %s goes back to PENDING, clears the decision, and keeps the old message in the audit log',
    async (status) => {
      const [me, admin] = [await createUser(pool), await createAdmin(pool)];
      await pool.query(
        `INSERT INTO user_roles (user_id, role, status, application_message, decision_note, decided_by, decided_at)
       VALUES ($1, 'TEACHER', $2, 'The first message, long enough.', 'Not enough detail', $3, now())`,
        [me.id, status, admin.id],
      );
      const res = await as(me.id)
        .post('/me/teacher-application', { message })
        .expect(201);
      expect(res.body).toEqual({
        status: 'PENDING',
        message,
        decisionNote: null,
        decidedAt: null,
      });
      expect(await roleRow(me.id)).toMatchObject({
        status: 'PENDING',
        application_message: message,
        decision_note: null,
        decided_by: null,
        decided_at: null,
      });
      const [entry] = await audits('TEACHER_REAPPLIED');
      expect(entry).toMatchObject({ actor_id: me.id, target_id: me.id });
      expect(entry.metadata).toEqual({
        previousStatus: status,
        previousMessage: 'The first message, long enough.',
        previousDecisionNote: 'Not enough detail',
      });
      expect(events.map((e) => e.name)).toEqual([
        'teacher-application.received',
      ]);
    },
  );

  it('two submissions at the same moment: one 201, one 409, one row, one event', async () => {
    const me = await createUser(pool);
    const results = await Promise.all([
      as(me.id).post('/me/teacher-application', { message }),
      as(me.id).post('/me/teacher-application', { message }),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'TEACHER'",
          [me.id],
        )
      ).rowCount,
    ).toBe(1);
    await sleep(50);
    expect(events).toHaveLength(1);
  });

  it('two re-applications at the same moment: one wins, one audit row', async () => {
    const [me, admin] = [await createUser(pool), await createAdmin(pool)];
    await pool.query(
      "INSERT INTO user_roles (user_id, role, status, application_message, decided_by, decided_at) VALUES ($1, 'TEACHER', 'REJECTED', 'The first message, long enough.', $2, now())",
      [me.id, admin.id],
    );
    const results = await Promise.all([
      as(me.id).post('/me/teacher-application', { message }),
      as(me.id).post('/me/teacher-application', { message }),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(await audits('TEACHER_REAPPLIED')).toHaveLength(1);
  });
});

describe('primitives for Auth and Admin', () => {
  it('createWithStudentRole creates the user and the ACTIVE STUDENT role together, lower-casing the email', async () => {
    const user = await transactions.run((tx) =>
      accounts.createWithStudentRole(tx, {
        email: '  New.User@Example.TEST ',
        fullName: 'New User',
        passwordHash: 'hash',
      }),
    );
    expect(user.email).toBe('new.user@example.test');
    expect(
      (
        await pool.query(
          'SELECT email, password_hash, email_verified_at FROM users WHERE id = $1',
          [user.id],
        )
      ).rows[0],
    ).toEqual({
      email: 'new.user@example.test',
      password_hash: 'hash',
      email_verified_at: null,
    });
    expect(await roleRow(user.id, 'STUDENT')).toMatchObject({
      status: 'ACTIVE',
    });
  });

  it('it is atomic: when the transaction fails afterwards, neither the user nor the role exists', async () => {
    const error = await rejection(
      transactions.run(async (tx) => {
        await accounts.createWithStudentRole(tx, {
          email: 'ghost@example.test',
          fullName: 'Ghost',
        });
        throw new Error('later step failed');
      }),
    );
    expect(error.message).toBe('later step failed');
    expect(
      (
        await pool.query(
          "SELECT 1 FROM users WHERE email = 'ghost@example.test'",
        )
      ).rowCount,
    ).toBe(0);
    expect((await pool.query('SELECT 1 FROM user_roles')).rowCount).toBe(0);
  });

  it('a duplicate email (any case) is a unique violation and leaves no half-created user', async () => {
    await createUser(pool, { email: 'taken@example.test' });
    const error = await rejection(
      transactions.run(
        (tx) =>
          accounts.createWithStudentRole(tx, {
            email: 'TAKEN@example.test',
            fullName: 'Second',
          }),
        { maxAttempts: 1 },
      ),
    );
    expect(error).toBeDefined();
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM user_roles')).rowCount).toBe(0);
  });

  it('setTokensValidAfter sets the time and never moves it backwards; an unknown user is 404', async () => {
    const user = await createUser(pool);
    const late = new Date('2030-01-01T00:00:00Z');
    const early = new Date('2029-01-01T00:00:00Z');
    expect(
      await transactions.run((tx) =>
        accounts.setTokensValidAfter(tx, user.id, late),
      ),
    ).toEqual(late);
    expect(
      await transactions.run((tx) =>
        accounts.setTokensValidAfter(tx, user.id, early),
      ),
    ).toEqual(late);
    expect(
      (
        await rejection(
          transactions.run((tx) =>
            accounts.setTokensValidAfter(
              tx,
              '019d0000-0000-7000-8000-000000000000',
            ),
          ),
        )
      ).code,
    ).toBe('NOT_FOUND');
  });

  it('approve / reject / revoke are conditional state changes with audit and an event after commit', async () => {
    const [admin, a, b, c] = [
      await createAdmin(pool),
      await createUser(pool),
      await createUser(pool),
      await createTeacher(pool),
    ];
    for (const user of [a, b])
      await pool.query(
        "INSERT INTO user_roles (user_id, role, status, application_message) VALUES ($1, 'TEACHER', 'PENDING', 'A message that is long enough')",
        [user.id],
      );
    await transactions.run((tx) =>
      accounts.approveApplication(tx, {
        userId: a.id,
        decidedBy: admin.id,
        note: 'Welcome',
      }),
    );
    await transactions.run((tx) =>
      accounts.rejectApplication(tx, {
        userId: b.id,
        decidedBy: admin.id,
        note: 'No',
      }),
    );
    await transactions.run((tx) =>
      accounts.revokeTeacher(tx, { userId: c.id, decidedBy: admin.id }),
    );
    expect(await roleRow(a.id)).toMatchObject({
      status: 'ACTIVE',
      decision_note: 'Welcome',
      decided_by: admin.id,
    });
    expect(await roleRow(b.id)).toMatchObject({
      status: 'REJECTED',
      decision_note: 'No',
    });
    expect(await roleRow(c.id)).toMatchObject({ status: 'REVOKED' });
    expect((await audits('TEACHER_APPROVED'))[0]).toMatchObject({
      actor_id: admin.id,
      target_id: a.id,
    });
    expect(await audits('TEACHER_REJECTED')).toHaveLength(1);
    expect(await audits('TEACHER_REVOKED')).toHaveLength(1);
    expect(events.map((e) => e.name).sort()).toEqual([
      'teacher-application.approved',
      'teacher-application.rejected',
      'teacher-role.revoked',
    ]);
  });

  it('a decision from the wrong state is 409 INVALID_STATE_TRANSITION and writes nothing (no audit, no event); no application is 404', async () => {
    const [admin, pending, teacher, nobody] = [
      await createAdmin(pool),
      await createUser(pool),
      await createTeacher(pool),
      await createUser(pool),
    ];
    await pool.query(
      "INSERT INTO user_roles (user_id, role, status, application_message) VALUES ($1, 'TEACHER', 'PENDING', 'A message that is long enough')",
      [pending.id],
    );
    const input = (userId: string) => ({ userId, decidedBy: admin.id });
    expect(
      (
        await rejection(
          transactions.run((tx) =>
            accounts.approveApplication(tx, input(teacher.id)),
          ),
        )
      ).code,
    ).toBe('INVALID_STATE_TRANSITION');
    expect(
      (
        await rejection(
          transactions.run((tx) =>
            accounts.revokeTeacher(tx, input(pending.id)),
          ),
        )
      ).code,
    ).toBe('INVALID_STATE_TRANSITION');
    expect(
      (
        await rejection(
          transactions.run((tx) =>
            accounts.rejectApplication(tx, input(nobody.id)),
          ),
        )
      ).code,
    ).toBe('NOT_FOUND');
    expect((await pool.query('SELECT 1 FROM audit_logs')).rowCount).toBe(0);
    await sleep(50);
    expect(events).toEqual([]);
  });

  it('two Admins deciding the same application: exactly one wins', async () => {
    const [admin, other, user] = [
      await createAdmin(pool),
      await createAdmin(pool),
      await createUser(pool),
    ];
    await pool.query(
      "INSERT INTO user_roles (user_id, role, status, application_message) VALUES ($1, 'TEACHER', 'PENDING', 'A message that is long enough')",
      [user.id],
    );
    const results = await Promise.allSettled([
      transactions.run((tx) =>
        accounts.approveApplication(tx, {
          userId: user.id,
          decidedBy: admin.id,
        }),
      ),
      transactions.run((tx) =>
        accounts.rejectApplication(tx, {
          userId: user.id,
          decidedBy: other.id,
        }),
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(await audits('TEACHER_APPROVED')).toHaveLength(
      results[0].status === 'fulfilled' ? 1 : 0,
    );
  });

  it('suspend sets the status and invalidates tokens; suspend twice and unsuspend of an active user are 409', async () => {
    const [admin, user] = [await createAdmin(pool), await createUser(pool)];
    await transactions.run((tx) =>
      accounts.suspend(tx, {
        userId: user.id,
        actorId: admin.id,
        reason: 'spam',
      }),
    );
    const row = (
      await pool.query(
        'SELECT status, suspended_at, tokens_valid_after FROM users WHERE id = $1',
        [user.id],
      )
    ).rows[0];
    expect(row.status).toBe('SUSPENDED');
    expect(row.suspended_at).not.toBeNull();
    expect(row.tokens_valid_after).not.toBeNull();
    expect((await audits('USER_SUSPENDED'))[0].metadata).toEqual({
      reason: 'spam',
    });
    expect(
      (
        await rejection(
          transactions.run((tx) =>
            accounts.suspend(tx, { userId: user.id, actorId: admin.id }),
          ),
        )
      ).code,
    ).toBe('INVALID_STATE_TRANSITION');
    await as(user.id).get('/me').expect(403); // ACCOUNT_SUSPENDED
    await transactions.run((tx) =>
      accounts.unsuspend(tx, { userId: user.id, actorId: admin.id }),
    );
    expect(
      (
        await pool.query(
          'SELECT status, suspended_at FROM users WHERE id = $1',
          [user.id],
        )
      ).rows[0],
    ).toEqual({ status: 'ACTIVE', suspended_at: null });
    expect(
      (
        await rejection(
          transactions.run((tx) =>
            accounts.unsuspend(tx, { userId: user.id, actorId: admin.id }),
          ),
        )
      ).code,
    ).toBe('INVALID_STATE_TRANSITION');
  });

  it('revocation takes the User row exclusively: it waits for a holder of User-S (the eligibility rule)', async () => {
    const [admin, teacher] = [
      await createAdmin(pool),
      await createTeacher(pool),
    ];
    const holder = await holdTx(
      pool,
      'user-s',
      'SELECT 1 FROM users WHERE id = $1 FOR SHARE',
      [teacher.id],
    );
    const revoke = transactions.run((tx) =>
      accounts.revokeTeacher(tx, { userId: teacher.id, decidedBy: admin.id }),
    );
    revoke.catch(() => undefined);
    expect(await settlesWithin(revoke, 400)).toBe(false);
    await holder.release('commit');
    await revoke;
    expect((await roleRow(teacher.id)).status).toBe('REVOKED');
  });
});
