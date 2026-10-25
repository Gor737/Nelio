// HTTP behavior of the shared infrastructure (M6), without a database: real global guard/filter/pipe wiring and the real
// configureApp (prefix, helmet, CORS, request id, Swagger) around a probe module.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.setup.js';
import { GLOBAL_PROVIDERS } from '../src/common/global-providers.js';
import { AppConfigModule } from '../src/infrastructure/config/index.js';
import { captureLogs, expectNoneLogged } from './support/log-capture.js';
import { ProbeModule } from './support/probe.module.js';

const env = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused',
  JWT_SECRET: 'test-secret-with-more-than-thirty-two-bytes-in-it',
  FRONTEND_ORIGIN: 'http://localhost:3001',
  SWAGGER_ENABLED: 'true',
};

async function createApp(
  extraEnv: Record<string, string> = {},
): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule.forRoot({ ...env, ...extraEnv }), ProbeModule],
    providers: GLOBAL_PROVIDERS,
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

  // KNOWN GAP, not fixed (docs/roadmap.md M8/M10): PER_CONVERSATION_BURST is keyed by user + conversation, and neither exists
  // before authentication, so today the guard has nothing to count and the class does NOT limit. This test pins the current
  // behavior so the gap cannot be forgotten: when M8/M10 implement the keys it must fail, and be replaced by a test that
  // proves the 31st request in 10 seconds is answered 429.
  it('KNOWN GAP: PER_CONVERSATION_BURST does not limit anything yet', async () => {
    for (let i = 0; i < 40; i++)
      await request(app.getHttpServer())
        .post('/api/v1/probe/burst')
        .expect(201);
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
