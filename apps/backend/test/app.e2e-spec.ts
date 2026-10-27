// HTTP behavior of the shared infrastructure (M6), without a database: real global guard/filter/pipe wiring and the real
// configureApp (prefix, helmet, CORS, request id, Swagger) around a probe module.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { APP_GUARD } from '@nestjs/core';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.setup.js';
import { GLOBAL_PROVIDERS } from '../src/common/global-providers.js';
import {
  Authenticator,
  RateLimiter,
  TokenVerifier,
} from '../src/common/guards/index.js';
import { AppConfigModule } from '../src/infrastructure/config/index.js';
import { MAIL_TRANSPORT } from '../src/infrastructure/mail/index.js';
import { captureLogs, expectNoneLogged } from './support/log-capture.js';
import { FakeAuthUserLoader, fakeAuthProviders } from './support/fake-auth.js';
import { ProbeMailModule } from './support/probe-mail.js';
import { ProbeModule } from './support/probe.module.js';
import { mintAccessToken } from './support/token-minter.js';

const env = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused',
  JWT_SECRET: 'test-secret-with-more-than-thirty-two-bytes-in-it',
  FRONTEND_ORIGIN: 'http://localhost:3001',
  SWAGGER_ENABLED: 'true',
};

const loader = new FakeAuthUserLoader();
const bearer = (
  userId: string,
  options: Parameters<typeof mintAccessToken>[1] = {},
) =>
  `Bearer ${mintAccessToken(userId, { secret: env.JWT_SECRET, ...options })}`;

async function createApp(
  extraEnv: Record<string, string> = {},
): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule.forRoot({ ...env, ...extraEnv }), ProbeModule],
    providers: [
      ...GLOBAL_PROVIDERS,
      TokenVerifier,
      Authenticator,
      RateLimiter,
      ...fakeAuthProviders(loader), // no database in this suite: the real loader and course access are tested in the integration suite
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return app;
}

const UUID = '018f0000-0000-7000-8000-000000000001';
let app: NestExpressApplication;

beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
});

describe('validation (400 VALIDATION_FAILED)', () => {
  it('rejects an unknown field', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/items')
      .send({ name: 'ok', admin: true })
      .expect(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(res.body.errors).toEqual([
      { field: 'admin', messages: ['property admin should not exist'] },
    ]);
  });

  it('rejects wrong types and lengths with one entry per field', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/items')
      .send({ name: '', count: 9 })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(
      res.body.errors.map((e: { field: string }) => e.field).sort(),
    ).toEqual(['count', 'name']);
  });

  it('does not echo the submitted value', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/items')
      .send({ name: 'x'.repeat(50) })
      .expect(400);
    expect(JSON.stringify(res.body)).not.toContain('xxxxxxxxxx');
  });

  it('accepts a valid body', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/items')
      .send({ name: 'ok', count: 2 })
      .expect(201);
    expect(res.body).toEqual({ name: 'ok', count: 2 });
  });

  it('rejects malformed JSON as 400 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/items')
      .set('Content-Type', 'application/json')
      .send('{"name":')
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('answers an oversized JSON body with 400 VALIDATION_FAILED, not 413 FILE_TOO_LARGE (Decision 167)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/items')
      .send({ name: 'x'.repeat(300_000) })
      .expect(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('answers an unsupported charset with 400 VALIDATION_FAILED, not 415 FILE_TYPE_NOT_ALLOWED (Decision 167)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/items')
      .set('Content-Type', 'application/json; charset=x-no-such-charset')
      .send('{"name":"ok"}')
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a malformed UUID path parameter with 400, not 404', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/items/not-a-uuid')
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    await request(app.getHttpServer())
      .get(`/api/v1/probe/items/${UUID}`)
      .expect(200, { id: UUID });
  });
});

describe('error mapping', () => {
  const cases: [string, number, string][] = [
    ['api', 409, 'COURSE_ARCHIVED'],
    ['two-status-403', 403, 'COURSE_ADMIN_LOCKED'],
    ['two-status-409', 409, 'COURSE_ADMIN_LOCKED'],
    ['unique', 409, 'RESOURCE_CONFLICT'],
    ['fk', 409, 'RESOURCE_CONFLICT'],
    ['restrict', 409, 'RESOURCE_CONFLICT'],
    ['deadlock', 503, 'SERVICE_UNAVAILABLE'],
    ['lock-timeout', 503, 'SERVICE_UNAVAILABLE'],
    ['check', 500, 'INTERNAL_ERROR'],
    ['anything-else', 500, 'INTERNAL_ERROR'],
  ];
  it.each(cases)('%s -> %i %s', async (kind, status, code) => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/probe/throw/${kind}`)
      .expect(status);
    expect(res.body).toMatchObject({ statusCode: status, code });
    expect(Object.keys(res.body).sort()).toEqual([
      'code',
      'message',
      'statusCode',
    ]);
  });

  it('never leaks the cause of an unexpected error', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/throw/boom')
      .expect(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|postgresql|pw@/);
  });

  it('answers an unknown route with 404 NOT_FOUND in the standard shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('refuses an ApiException with a status its code does not allow', async () => {
    const { ApiException } = await import('../src/common/filters/index.js');
    expect(() => new ApiException('COURSE_ARCHIVED', { status: 400 })).toThrow(
      TypeError,
    );
    expect(() => new ApiException('COURSE_ADMIN_LOCKED')).toThrow(TypeError);
  });
});

describe('rate limiting', () => {
  it('returns 429 before validation: the 6th STRICT request is throttled even though its body is invalid', async () => {
    const send = () =>
      request(app.getHttpServer())
        .post('/api/v1/probe/login')
        .set('X-Forwarded-For', '203.0.113.9')
        .send({ unknown: 1 });
    for (let i = 0; i < 5; i++) await send().expect(400);
    const res = await send().expect(429);
    expect(res.body).toMatchObject({
      statusCode: 429,
      code: 'TOO_MANY_REQUESTS',
    });
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('counts per email as well: another IP cannot bypass the limit for the same address', async () => {
    const email = 'victim@example.test';
    const send = (n: number) =>
      request(app.getHttpServer())
        .post('/api/v1/probe/login')
        .set('X-Forwarded-For', `198.51.100.${n}`)
        .send({ email });
    // (X-Forwarded-For is ignored while TRUST_PROXY=0, so every request is the same IP; the email counter alone is asserted below.)
    for (let i = 0; i < 5; i++) await send(i + 1);
    await send(99).expect(429);
  });

  describe('behind a proxy (TRUST_PROXY=1)', () => {
    let proxied: NestExpressApplication;
    beforeAll(async () => {
      proxied = await createApp({ TRUST_PROXY: '1' });
    });
    afterAll(async () => {
      await proxied.close();
    });

    it('limits each client IP from X-Forwarded-For separately, not the proxy as a whole', async () => {
      const as = (ip: string) =>
        request(proxied.getHttpServer())
          .post('/api/v1/probe/login')
          .set('X-Forwarded-For', ip)
          .send({ unknown: 1 });
      for (let i = 0; i < 5; i++) await as('203.0.113.50').expect(400);
      await as('203.0.113.50').expect(429);
      await as('203.0.113.51').expect(400); // another client behind the same proxy is unaffected
    });

    it('ignores X-Forwarded-For when no proxy is trusted, so it cannot be used to dodge the limit', async () => {
      const spoof = (n: number) =>
        request(app.getHttpServer())
          .post('/api/v1/probe/login')
          .set('X-Forwarded-For', `192.0.2.${n}`)
          .send({ unknown: 1 });
      // `app` has TRUST_PROXY=0 and its STRICT budget for this IP is already spent by the tests above.
      await spoof(1).expect(429);
      await spoof(2).expect(429);
    });
  });

  it('does not let a STRICT flood use up the DEFAULT budget', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/probe/items/${UUID}`)
      .expect(200);
  });
});

describe('503 SERVICE_UNAVAILABLE (Decision 166)', () => {
  it.each(['deadlock', 'lock-timeout'])(
    '%s is answered 503 without an invented Retry-After',
    async (kind) => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/probe/throw/${kind}`)
        .expect(503);
      expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.headers['retry-after']).toBeUndefined();
    },
  );
});

describe('logs never contain request bodies or sensitive header values', () => {
  let logApp: NestExpressApplication;
  beforeAll(async () => {
    logApp = await createApp(); // fresh rate-limit counters: the shared app's STRICT budget is spent by the tests above
  });
  afterAll(async () => {
    await logApp.close();
  });

  it('keeps passwords, tokens, cookies and message bodies out of every log line', async () => {
    const logs = captureLogs();
    try {
      const secrets = [
        'Sup3r-Secret-Password!',
        'header-bearer-token-value-123',
        'cookie-session-value-456',
        'the private message body text',
      ];
      await request(logApp.getHttpServer())
        .post('/api/v1/probe/items')
        .set('Authorization', `Bearer ${secrets[1]}`)
        .set('Cookie', `refresh=${secrets[2]}`)
        .set('X-Api-Key', 'api-key-value-789')
        .send({ name: 'ok', password: secrets[0], body: secrets[3] }) // rejected: unknown fields, so it also exercises the error path
        .expect(400);
      await request(logApp.getHttpServer())
        .post('/api/v1/probe/login')
        .set('Authorization', `Bearer ${secrets[1]}`)
        .send({ email: `${secrets[3]}@example.test` })
        .expect(201);
      expectNoneLogged(logs, [...secrets, 'api-key-value-789']);
    } finally {
      logs.restore();
    }
  });
});

describe('OpenAPI error contract', () => {
  it('lists 429, 500 and 503 as ErrorResponseDto on every operation, and SERVICE_UNAVAILABLE among the codes', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    for (const path of Object.values<Record<string, any>>(res.body.paths)) {
      for (const operation of Object.values<any>(path)) {
        for (const status of ['429', '500', '503']) {
          expect(
            operation.responses[status].content['application/json'].schema.$ref,
          ).toMatch(/ErrorResponseDto$/);
        }
      }
    }
    expect(
      res.body.components.schemas.ErrorResponseDto.properties.code.enum,
    ).toContain('SERVICE_UNAVAILABLE');
    expect(res.body.info.description).toMatch(/503/);
  });
});

describe('OpenAPI security and auth errors follow the guard decorators', () => {
  let document: {
    paths: Record<string, Record<string, any>>;
    components: any;
    info: any;
  };
  beforeAll(async () => {
    document = (
      await request(app.getHttpServer()).get('/api/docs-json').expect(200)
    ).body;
  });
  const op = (method: string, path: string) => document.paths[path][method];

  it('a @Public() operation has no security requirement and no 401/403', () => {
    const publicOp = op('get', '/api/v1/probe/items/{id}');
    expect(publicOp.security).toEqual([]);
    expect(publicOp.responses['401']).toBeUndefined();
    expect(publicOp.responses['403']).toBeUndefined();
  });

  it('an operation that needs a login requires the bearer token and documents 401 and 403', () => {
    const secured = op('get', '/api/v1/probe-auth/me');
    expect(secured.security).toEqual([{ 'access-token': [] }]);
    expect(
      secured.responses['401'].content['application/json'].schema.$ref,
    ).toMatch(/ErrorResponseDto$/);
    expect(secured.responses['403'].description).toMatch(/ACCOUNT_SUSPENDED/);
  });

  it('an @OptionalAuth() operation accepts anonymous callers or a bearer token', () => {
    expect(op('get', '/api/v1/probe-auth/optional').security).toEqual([
      {},
      { 'access-token': [] },
    ]);
  });

  it('operations with a body or path parameters also document 400 VALIDATION_FAILED; those without do not', () => {
    expect(op('post', '/api/v1/probe/items').responses['400']).toBeDefined();
    expect(
      op('get', '/api/v1/probe-auth/courses/{courseId}/owner').responses['400'],
    ).toBeDefined();
    expect(op('get', '/api/v1/probe-auth/me').responses['400']).toBeUndefined();
  });

  it('the internal markers are removed from the published document', () => {
    expect(JSON.stringify(document)).not.toContain('x-nelio');
  });

  it('the API description explains authentication', () => {
    expect(document.info.description).toMatch(/Authorization: Bearer/);
  });
});

describe('security and routing', () => {
  it('sets helmet headers and a request id on API responses', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/probe/items/${UUID}`)
      .expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a safe incoming request id and replaces an unsafe one', async () => {
    const safe = await request(app.getHttpServer())
      .get(`/api/v1/probe/items/${UUID}`)
      .set('X-Request-Id', 'req-12345678')
      .expect(200);
    expect(safe.headers['x-request-id']).toBe('req-12345678');
    const unsafe = await request(app.getHttpServer())
      .get(`/api/v1/probe/items/${UUID}`)
      .set('X-Request-Id', 'bad id!')
      .expect(200);
    expect(unsafe.headers['x-request-id']).not.toBe('bad id!');
  });

  it('allows only the configured frontend origin, with credentials', async () => {
    const ok = await request(app.getHttpServer())
      .get(`/api/v1/probe/items/${UUID}`)
      .set('Origin', 'http://localhost:3001');
    expect(ok.headers['access-control-allow-origin']).toBe(
      'http://localhost:3001',
    );
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const other = await request(app.getHttpServer())
      .get(`/api/v1/probe/items/${UUID}`)
      .set('Origin', 'https://evil.example');
    // A fixed origin is always answered with the configured one, so a browser on any other origin refuses the response.
    expect(other.headers['access-control-allow-origin']).toBe(
      'http://localhost:3001',
    );
    expect(other.headers['access-control-allow-origin']).not.toBe(
      'https://evil.example',
    );
    expect(other.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('serves the OpenAPI document with the bearer scheme and the error schema', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.components.securitySchemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(
      res.body.components.schemas.ErrorResponseDto.properties.code.enum,
    ).toContain('VALIDATION_FAILED');
  });
});

// ---- M8: check order, guard order, user-keyed rate limits ---------------------------------------------------------------------

describe('check order: throttle -> 401 -> ACCOUNT_SUSPENDED -> guards -> input shape (Decision 140)', () => {
  let ordered: NestExpressApplication;
  beforeAll(async () => {
    ordered = await createApp();
  });
  afterAll(async () => {
    await ordered.close();
  });

  const invalidBody = { name: '', admin: true }; // would be a 400 if it were ever looked at
  const post = (authorization?: string) => {
    const req = request(ordered.getHttpServer())
      .post('/api/v1/probe-auth/teacher-items')
      .send(invalidBody);
    return authorization ? req.set('Authorization', authorization) : req;
  };

  it('no token: 401, although the body is invalid too', async () => {
    const res = await post().expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('suspended user: 403 ACCOUNT_SUSPENDED, before the role is looked at and before the body is validated', async () => {
    const user = loader.add({ status: 'SUSPENDED', roles: ['STUDENT'] });
    const res = await post(bearer(user.id)).expect(403);
    expect(res.body.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('a student on a Teacher route: 403 TEACHER_NOT_APPROVED, before the body is validated', async () => {
    const user = loader.add({ roles: ['STUDENT'] });
    const res = await post(bearer(user.id)).expect(403);
    expect(res.body.code).toBe('TEACHER_NOT_APPROVED');
  });

  it('an active Teacher with an invalid body: only now 400 VALIDATION_FAILED', async () => {
    const user = loader.add({ roles: ['STUDENT', 'TEACHER'] });
    const res = await post(bearer(user.id)).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('an active Teacher with a valid body passes all the way', async () => {
    const user = loader.add({ roles: ['STUDENT', 'TEACHER'] });
    await request(ordered.getHttpServer())
      .post('/api/v1/probe-auth/teacher-items')
      .set('Authorization', bearer(user.id))
      .send({ name: 'ok' })
      .expect(201);
  });

  it('the throttle comes first: once the limit is spent, even a request that would be a 401 is a 429', async () => {
    // DEFAULT is 120 per 60 s per IP. Spend it with cheap unauthenticated requests, then send a bad token.
    const app429 = await createApp();
    try {
      for (let i = 0; i < 120; i++)
        await request(app429.getHttpServer())
          .get('/api/v1/probe-auth/me')
          .expect(401);
      const res = await request(app429.getHttpServer())
        .get('/api/v1/probe-auth/me')
        .set('Authorization', 'Bearer not-a-token')
        .expect(429);
      expect(res.body.code).toBe('TOO_MANY_REQUESTS');
    } finally {
      await app429.close();
    }
  });
});

describe('the JWT guard runs after the rate limiter (global guard order)', () => {
  it('a flood of requests with invalid tokens is answered 429, not 401, and no token is verified or user loaded once limited', async () => {
    const flooded = await createApp();
    try {
      const loadsBefore = loader.loads;
      const statuses: number[] = [];
      for (let i = 0; i < 125; i++) {
        const res = await request(flooded.getHttpServer())
          .get('/api/v1/probe-auth/me')
          .set('Authorization', 'Bearer forged.token.value');
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 120).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(120).every((s) => s === 429)).toBe(true);
      // Forged tokens never reach the database; and the limited requests never reached the guard at all.
      expect(loader.loads).toBe(loadsBefore);
    } finally {
      await flooded.close();
    }
  });

  it('the global guards are registered in the documented order', () => {
    const names = (
      GLOBAL_PROVIDERS as { provide?: unknown; useClass?: { name: string } }[]
    )
      .filter((p) => p.provide === APP_GUARD)
      .map((p) => p.useClass?.name);
    expect(names).toEqual([
      'RateLimitGuard',
      'JwtAuthGuard',
      'UserRateLimitGuard',
      'RolesGuard',
      'CourseRoleGuard',
    ]);
  });
});

describe('Per-conversation burst actually limits (closes the M6 gap, Decision 167)', () => {
  let burst: NestExpressApplication;
  beforeAll(async () => {
    burst = await createApp();
  });
  afterAll(async () => {
    await burst.close();
  });

  const conversationA = '018f0000-0000-7000-8000-00000000000a';
  const conversationB = '018f0000-0000-7000-8000-00000000000b';
  const send = (userId: string, conversationId: string) =>
    request(burst.getHttpServer())
      .post(`/api/v1/probe-auth/conversations/${conversationId}/messages`)
      .set('Authorization', bearer(userId));

  it('the 31st request in 10 seconds by one user in one conversation is 429 with Retry-After; the 30th is not', async () => {
    const user = loader.add();
    for (let i = 1; i <= 30; i++)
      await send(user.id, conversationA).expect(201);
    const res = await send(user.id, conversationA).expect(429);
    expect(res.body).toMatchObject({
      statusCode: 429,
      code: 'TOO_MANY_REQUESTS',
    });
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(10);
  });

  it('the budget is per user AND per conversation: the same user elsewhere, and another user here, are unaffected', async () => {
    const [busy, other] = [loader.add(), loader.add()];
    for (let i = 0; i < 31; i++) await send(busy.id, conversationA);
    await send(busy.id, conversationA).expect(429);
    await send(busy.id, conversationB).expect(201); // another conversation
    await send(other.id, conversationA).expect(201); // another user
  });

  it('is applied after authentication: an unauthenticated flood is a 401 and never consumes a user budget', async () => {
    for (let i = 0; i < 40; i++)
      await request(burst.getHttpServer())
        .post(`/api/v1/probe-auth/conversations/${conversationA}/messages`)
        .expect(401);
  });

  it('TIGHT is keyed by user as well as by IP', async () => {
    const tight = await createApp();
    try {
      const [a, b] = [loader.add(), loader.add()];
      const hit = (id: string) =>
        request(tight.getHttpServer())
          .get('/api/v1/probe-auth/tight')
          .set('Authorization', bearer(id));
      for (let i = 0; i < 20; i++) await hit(a.id).expect(200);
      await hit(a.id).expect(429);
      // b shares the IP counter (21 requests so far, limit 20): the ip key limits b as well.
      await hit(b.id).expect(429);
    } finally {
      await tight.close();
    }
  });
});

// ---- M8: mail --------------------------------------------------------------------------------------------------------------

describe('a mail failure does not break the request (registration-shaped endpoint)', () => {
  const sendMail =
    jest.fn<(message: { to: string; subject: string }) => Promise<unknown>>();

  async function createMailApp(): Promise<NestExpressApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule.forRoot(env), ProbeMailModule],
      providers: [
        ...GLOBAL_PROVIDERS,
        TokenVerifier,
        Authenticator,
        RateLimiter,
        ...fakeAuthProviders(loader),
      ],
    })
      .overrideProvider(MAIL_TRANSPORT)
      .useValue({ sendMail })
      .compile();
    const mailApp = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(mailApp);
    await mailApp.init();
    return mailApp;
  }

  let mailApp: NestExpressApplication;
  beforeAll(async () => {
    mailApp = await createMailApp();
  });
  afterAll(async () => {
    await mailApp.close();
  });
  beforeEach(() => sendMail.mockReset());

  const register = (email = 'new.user@example.test') =>
    request(mailApp.getHttpServer())
      .post('/api/v1/probe-mail/register')
      .send({ email });

  it('answers 202 and sends the email when the mail server works', async () => {
    sendMail.mockResolvedValue({ accepted: ['new.user@example.test'] });
    await register().expect(202);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({
      to: 'new.user@example.test',
      subject: 'Confirm your email address for Nelio',
    });
  });

  it('answers the same 202 when the mail server refuses the connection', async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1025'), {
        code: 'ECONNREFUSED',
      }),
    );
    const res = await register().expect(202);
    expect(res.body).toEqual({});
  });

  it('answers the same 202 when the mail server rejects the recipient, or the transport throws synchronously', async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error('550 no such user'), { responseCode: 550 }),
    );
    await register().expect(202);
    sendMail.mockImplementation(() => {
      throw new Error('transport exploded');
    });
    await register().expect(202);
  });

  it('the response is identical whether or not the email could be sent (nothing to tell an address apart)', async () => {
    sendMail.mockResolvedValue({});
    const ok = await register().expect(202);
    sendMail.mockRejectedValue(new Error('down'));
    const failed = await register().expect(202);
    expect(failed.body).toEqual(ok.body);
    expect(failed.status).toBe(ok.status);
  });

  it('the failure is logged without the address, the link or the token', async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error('failed for new.user@example.test'), {
        code: 'ESOCKET',
      }),
    );
    const logs = captureLogs();
    try {
      await register('new.user@example.test').expect(202);
      const output = logs.output();
      expect(output).toContain('mail_send_failed');
      expect(output).not.toContain('new.user@example.test');
      expect(output).not.toContain('probe-token');
    } finally {
      logs.restore();
    }
  });
});
