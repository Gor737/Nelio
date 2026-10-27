// M13 security pass on the WHOLE application: security headers (Helmet), CORS, the refresh cookie, Origin checks on refresh, logout and the
// socket handshake, log redaction, and the rate-limit class of every endpoint (a table both ways, then the real limits).
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { RATE_LIMIT_CLASSES } from '../../src/common/constants/rate-limit-classes.js';
import { PasswordService } from '../../src/modules/auth/index.js';
import { createPool, resetData } from '../support/database.js';
import { createUser } from '../support/factories.js';
import { createGroup } from '../support/factories-chat.js';
import { createFullApp, type FullApp } from '../support/full-app.js';
import { TEST_JWT_SECRET } from '../support/integration-app.js';
import { captureLogs, expectNoneLogged } from '../support/log-capture.js';
import { routeInventory, type RouteInfo } from '../support/route-inventory.js';
import { mintAccessToken } from '../support/token-minter.js';

const pool = createPool(5);
let t: FullApp;
let routes: RouteInfo[];
let passwords: PasswordService;
const FRONTEND = 'http://localhost:3001';
const PASSWORD = 'a perfectly fine passphrase';
const opened: Socket[] = [];

beforeAll(async () => {
  t = await createFullApp({}, { listen: true });
  routes = routeInventory(t.app);
  passwords = t.app.get(PasswordService, { strict: false });
});
afterAll(async () => {
  for (const socket of opened) socket.close();
  await t.app.close();
  await pool.end();
});
beforeEach(() => resetData(pool));

async function userWithPassword() {
  const user = await createUser(pool);
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
    user.id,
    await passwords.hash(PASSWORD),
  ]);
  return user;
}
const login = (email: string, ip?: string) =>
  t.call('post', '/auth/login', { ip, body: { email, password: PASSWORD } });
const refreshCookie = (res: { headers: Record<string, unknown> }) =>
  ((res.headers['set-cookie'] as string[]) ?? []).find((c) =>
    c.startsWith('nelio_refresh='),
  ) as string;

describe('security headers (Helmet) and CORS', () => {
  it('every answer, success or error, carries the Helmet headers and no X-Powered-By', async () => {
    for (const res of [
      await t.call('get', '/categories'),
      await t.call('get', '/me'),
      await t.call('get', '/nowhere'),
    ]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['referrer-policy']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-request-id']).toMatch(/\S+/);
    }
  });

  it('the frontend origin is allowed with credentials and may read X-Request-Id and Retry-After; the allowed origin is never reflected from the request', async () => {
    const ok = await t.call('get', '/categories', {
      headers: { Origin: FRONTEND },
    });
    expect(ok.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(String(ok.headers['access-control-expose-headers'])).toMatch(
      /X-Request-Id/i,
    );
    expect(String(ok.headers['access-control-expose-headers'])).toMatch(
      /Retry-After/i,
    );
    for (const origin of [
      'https://evil.example',
      `${FRONTEND}.evil.example`,
      'http://localhost:3002',
      'null',
    ]) {
      const res = await t.call('get', '/categories', {
        headers: { Origin: origin },
      });
      // the answer names the ONE configured origin and never reflects the caller's, so a browser on another origin is blocked
      expect([origin, res.headers['access-control-allow-origin']]).toEqual([
        origin,
        FRONTEND,
      ]);
    }
  });

  it('a preflight from the frontend is answered for the methods the API uses; another origin is never echoed back', async () => {
    const preflight = (origin: string) =>
      request(t.app.getHttpServer())
        .options('/api/v1/courses')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization,content-type');
    const ok = await preflight(FRONTEND);
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(String(ok.headers['access-control-allow-methods'])).toMatch(/POST/);
    const bad = await preflight('https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBe(FRONTEND); // never the evil origin: the browser blocks the call
    expect(bad.headers['access-control-allow-origin']).not.toBe(
      'https://evil.example',
    );
  });
});

describe('the refresh cookie', () => {
  it('is HttpOnly, Secure, SameSite=Lax, scoped to /api/v1/auth, and the token never appears in a body', async () => {
    const user = await userWithPassword();
    const res = await login(user.email).expect(200);
    const cookie = refreshCookie(res);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth(;|$)/);
    expect(cookie).not.toMatch(/Domain=/i);
    const value = cookie.split(';')[0].slice('nelio_refresh='.length);
    expect(JSON.stringify(res.body)).not.toContain(value);
  });

  it('is cleared on logout with the same attributes', async () => {
    const user = await userWithPassword();
    const cookie = refreshCookie(await login(user.email).expect(200)).split(
      ';',
    )[0];
    const out = await t
      .call('post', '/auth/logout', { headers: { Cookie: cookie } })
      .expect(204);
    const cleared = refreshCookie(out);
    expect(cleared).toMatch(/nelio_refresh=;/);
    expect(cleared).toMatch(/Path=\/api\/v1\/auth/);
    expect(cleared).toMatch(/HttpOnly/);
  });
});

describe('Origin checks', () => {
  it('refresh and logout refuse another origin (403) before touching the token, and accept the frontend origin or no Origin', async () => {
    const user = await userWithPassword();
    const cookie = refreshCookie(await login(user.email).expect(200)).split(
      ';',
    )[0];
    for (const path of ['/auth/refresh', '/auth/logout']) {
      const bad = await t.call('post', path, {
        headers: { Cookie: cookie, Origin: 'https://evil.example' },
      });
      expect([path, bad.status, bad.body.code]).toEqual([
        path,
        403,
        'FORBIDDEN',
      ]);
    }
    // the token survived the refused attempts
    await t
      .call('post', '/auth/refresh', {
        headers: { Cookie: cookie, Origin: FRONTEND },
      })
      .expect(200);
  });

  it('refresh without a cookie is a 401 whatever the origin (the origin is checked first, then the token)', async () => {
    expect((await t.call('post', '/auth/refresh', {})).status).toBe(401);
    expect(
      (
        await t.call('post', '/auth/refresh', {
          headers: { Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
  });

  const connect = (origin: string | null, token: string) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = io(`http://localhost:${t.port}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        auth: { token },
        extraHeaders: origin === null ? {} : { Origin: origin },
      });
      opened.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', (error) => {
        socket.close();
        reject(error);
      });
    });

  it('the socket handshake refuses another origin even with a valid token, and accepts the frontend origin or none', async () => {
    const user = await createUser(pool);
    const token = mintAccessToken(user.id, { secret: TEST_JWT_SECRET });
    for (const origin of [
      'https://evil.example',
      `${FRONTEND}.evil.example`,
      'http://localhost:3002',
    ])
      await expect(connect(origin, token)).rejects.toMatchObject({
        data: { code: 'FORBIDDEN' },
      });
    await expect(connect(FRONTEND, token)).resolves.toBeDefined();
    await expect(connect(null, token)).resolves.toBeDefined();
  });

  it('the socket handshake refuses a missing, malformed or revoked token', async () => {
    const user = await createUser(pool);
    await expect(connect(FRONTEND, '')).rejects.toMatchObject({
      data: { code: 'UNAUTHENTICATED' },
    });
    await expect(connect(FRONTEND, 'garbage')).rejects.toMatchObject({
      data: { code: 'UNAUTHENTICATED' },
    });
    const old = mintAccessToken(user.id, {
      secret: TEST_JWT_SECRET,
      nowSeconds: Math.floor(Date.now() / 1000) - 30,
    });
    await pool.query(
      'UPDATE users SET tokens_valid_after = now() WHERE id = $1',
      [user.id],
    );
    await expect(connect(FRONTEND, old)).rejects.toMatchObject({
      data: { code: 'UNAUTHENTICATED' },
    });
  });
});

describe('log redaction: what the application writes to its log', () => {
  it('never contains a password, a token, a cookie, an Authorization header or a message body, however the request ends', async () => {
    const user = await userWithPassword();
    const logs = captureLogs();
    try {
      const secrets = {
        password: 'Sup3r-secret-passphrase-for-logs',
        wrongPassword: 'Another-secret-passphrase-9',
        resetToken: 'reset-token-' + 'r'.repeat(31),
        verifyToken: 'verify-token-' + 'v'.repeat(30),
        message: 'a private message body that must stay private',
        cookieValue: 'refresh-cookie-value-' + 'c'.repeat(22),
      };
      await t.call('post', '/auth/login', {
        body: { email: user.email, password: secrets.wrongPassword },
      });
      await t.call('post', '/auth/register', {
        body: {
          email: 'logs@example.test',
          fullName: 'Logs Test',
          password: secrets.password,
        },
      });
      await t.call('post', '/auth/reset-password', {
        body: { token: secrets.resetToken, password: secrets.password },
      });
      await t.call('post', '/auth/verify-email', {
        body: { token: secrets.verifyToken },
      });
      await t.call('post', '/auth/refresh', {
        headers: { Cookie: `nelio_refresh=${secrets.cookieValue}` },
      });
      const token = mintAccessToken(user.id, { secret: TEST_JWT_SECRET });
      await t.call('get', '/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      await t.call('get', '/me', {
        headers: { Authorization: 'Bearer ' + token.slice(0, -4) + 'XXXX' },
      });
      const group = await createGroup(pool, user.id, []);
      await t.call('post', `/conversations/${group}/messages`, {
        userId: user.id,
        body: {
          body: secrets.message,
          clientId: '0191a000-0000-7000-8000-000000000077',
        },
      });
      await t.call('post', `/conversations/${group}/messages`, {
        userId: user.id,
        body: { body: secrets.message },
      }); // invalid: no clientId
      expectNoneLogged(logs, [
        ...Object.values(secrets),
        token,
        token.slice(0, -4),
        'nelio_refresh=',
        PASSWORD,
      ]);
    } finally {
      logs.restore();
    }
  });

  it('an unexpected server error is logged with its request id but not with the request body', async () => {
    const user = await createUser(pool);
    const logs = captureLogs();
    try {
      const { UsersService } =
        await import('../../src/modules/users/services/users.service.js');
      const { jest } = await import('@jest/globals');
      jest
        .spyOn(t.app.get(UsersService, { strict: false }), 'updateMe')
        .mockRejectedValueOnce(new Error('boom with BODY-SECRET-123'));
      const res = await t.call('patch', '/me', {
        userId: user.id,
        body: { fullName: 'Visible Name' },
      });
      expect(res.status).toBe(500);
      expect(res.text).not.toContain('boom');
      expect(res.text).not.toContain('BODY-SECRET-123');
      expect(logs.output()).not.toContain('Visible Name');
      jest.restoreAllMocks();
    } finally {
      logs.restore();
    }
  });
});

describe('rate-limit classes', () => {
  /** The class every endpoint MUST have: the four classes of the architecture name their endpoints, everything else is DEFAULT. */
  const STRICT = [
    'POST /auth/login',
    'POST /auth/register',
    'POST /auth/forgot-password',
    'POST /auth/resend-verification',
    'POST /auth/google',
    'POST /auth/google/link',
  ];
  const TIGHT = [
    'GET /users',
    'POST /conversations/direct',
    'POST /conversations/groups',
    'POST /files',
    'POST /conversations/:conversationId/messages/:messageId/report',
    'POST /users/:id/report',
    'POST /me/teacher-application',
    'POST /courses/:courseId/invitations',
  ];
  const BURST = ['POST /conversations/:id/messages'];

  it('every endpoint is in exactly the class of this table (an endpoint that is in none is DEFAULT)', () => {
    const expected = (key: string) =>
      STRICT.includes(key)
        ? 'STRICT'
        : TIGHT.includes(key)
          ? 'TIGHT'
          : BURST.includes(key)
            ? 'PER_CONVERSATION_BURST'
            : 'DEFAULT';
    for (const route of routes) {
      const actual = route.rateLimit?.name ?? 'DEFAULT';
      expect([route.key, actual]).toEqual([route.key, expected(route.key)]);
    }
    for (const key of [...STRICT, ...TIGHT, ...BURST])
      expect(routes.some((r) => r.key === key)).toBe(true);
  });

  it('the message-send burst names the right route parameter', () => {
    const send = routes.find(
      (r) => r.key === 'POST /conversations/:id/messages',
    ) as RouteInfo;
    expect(send.rateLimit?.conversationParam).toBe('id');
  });

  it('the classes of the architecture are the four documented ones, with the registered numbers', () => {
    expect(Object.keys(RATE_LIMIT_CLASSES).sort()).toEqual([
      'DEFAULT',
      'PER_CONVERSATION_BURST',
      'STRICT',
      'TIGHT',
    ]);
  });

  it('STRICT: the sixth login attempt in a minute from one address is throttled; TIGHT: the 21st search; DEFAULT: the 121st read', async () => {
    const strictIp = '10.91.0.1';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push(
        (
          await t.call('post', '/auth/login', {
            ip: strictIp,
            body: { email: `a${i}@example.test`, password: PASSWORD },
          })
        ).status,
      );
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);

    const user = await createUser(pool);
    const tightIp = '10.91.0.2';
    const tight: number[] = [];
    for (let i = 0; i < 21; i++)
      tight.push(
        (await t.call('get', '/users?q=ab', { ip: tightIp, userId: user.id }))
          .status,
      );
    expect(tight.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(tight[20]).toBe(429);

    const defaultIp = '10.91.0.3';
    let last = 0;
    for (let i = 0; i < 121; i++)
      last = (await t.call('get', '/categories', { ip: defaultIp })).status;
    expect(last).toBe(429);
  }, 60000);

  it('PER_CONVERSATION_BURST: the 31st message within ten seconds is throttled, and another conversation is not', async () => {
    const user = await createUser(pool);
    const a = await createGroup(pool, user.id, []);
    const b = await createGroup(pool, user.id, []);
    const ip = '10.91.0.4';
    const send = (conversation: string, n: number) =>
      t.call('post', `/conversations/${conversation}/messages`, {
        ip,
        userId: user.id,
        body: {
          body: `m${n}`,
          clientId: `0191a000-0000-7000-8000-${String(n).padStart(12, '0')}`,
        },
      });
    const results: number[] = [];
    for (let n = 1; n <= 31; n++) results.push((await send(a, n)).status);
    expect(results.slice(0, 30).every((s) => s === 201)).toBe(true);
    expect(results[30]).toBe(429);
    expect((await send(b, 100)).status).toBe(201);
  }, 60000);
});
