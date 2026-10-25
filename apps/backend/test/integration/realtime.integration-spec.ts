// M8: the Socket.IO server against the real database, with a real Socket.IO client (architecture section 14).
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import { DatabaseModule } from '../../src/infrastructure/database/index.js';
import {
  EventBus,
  EventsModule,
} from '../../src/infrastructure/events/index.js';
import {
  RealtimeService,
  SocketRegistry,
} from '../../src/infrastructure/realtime/index.js';
import { createPool, resetData } from '../support/database.js';
import { createUser } from '../support/factories.js';
import {
  TEST_JWT_SECRET,
  bearer,
  testEnv,
} from '../support/integration-app.js';
import { ProbeGatewayModule } from '../support/probe-gateway.js';
import { ProbeModule } from '../support/probe.module.js';
import { mintAccessToken } from '../support/token-minter.js';

const ORIGIN = 'http://localhost:3001';
const pool = createPool();
let app: NestExpressApplication;
let port: number;
let realtime: RealtimeService;
let registry: SocketRegistry;
let bus: EventBus;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv()),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      ProbeModule,
      ProbeGatewayModule,
    ],
    providers: GLOBAL_PROVIDERS,
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.listen(0);
  port = (app.getHttpServer().address() as AddressInfo).port;
  realtime = app.get(RealtimeService);
  registry = app.get(SocketRegistry);
  bus = app.get(EventBus);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => resetData(pool));

const opened: Socket[] = [];
afterEach(() => {
  for (const socket of opened.splice(0)) socket.close();
});

interface ConnectOptions {
  token?: string;
  origin?: string | null;
  query?: Record<string, string>;
}
interface ConnectError extends Error {
  data?: { statusCode: number; code: string };
}

/** Connects with the WebSocket transport; resolves with the connected socket or rejects with the `connect_error`. */
function connect({
  token,
  origin = ORIGIN,
  query,
}: ConnectOptions): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://localhost:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: token === undefined ? {} : { token },
      query,
      extraHeaders: origin === null ? {} : { Origin: origin },
    });
    opened.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}
const tokenOf = (
  userId: string,
  options: Parameters<typeof mintAccessToken>[1] = {},
) => mintAccessToken(userId, { secret: TEST_JWT_SECRET, ...options });
const rejection = async (options: ConnectOptions) => {
  try {
    await connect(options);
  } catch (error) {
    return (error as ConnectError).data;
  }
  throw new Error('expected the handshake to be rejected');
};
const nextEvent = <T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 2000,
) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no "${event}" within ${timeoutMs} ms`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
const silent = async (socket: Socket, event: string, ms = 250) => {
  let got = false;
  socket.once(event, () => (got = true));
  await new Promise((resolve) => setTimeout(resolve, ms));
  socket.off(event);
  return !got;
};
const ack = <T = Record<string, unknown>>(
  socket: Socket,
  event: string,
  payload?: unknown,
) => socket.timeout(2000).emitWithAck(event, payload) as Promise<T>;
const waitFor = async (condition: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('handshake', () => {
  it('accepts a valid token: the socket joins the personal room and is registered', async () => {
    const user = await createUser(pool);
    const socket = await connect({ token: tokenOf(user.id) });
    expect(socket.connected).toBe(true);
    await waitFor(() => registry.count(user.id) === 1);
    expect(realtime.isOnline(user.id)).toBe(true);
  });

  it.each([
    ['no token', undefined],
    ['an empty token', ''],
    ['a garbage token', 'not.a.token'],
  ])('rejects %s with UNAUTHENTICATED', async (_label, token) => {
    expect(await rejection({ token })).toEqual({
      statusCode: 401,
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects an expired token, a token with a wrong algorithm, and a token for an unknown user', async () => {
    const user = await createUser(pool);
    expect(
      await rejection({
        token: tokenOf(user.id, {
          nowSeconds: Math.floor(Date.now() / 1000) - 2000,
        }),
      }),
    ).toMatchObject({ code: 'UNAUTHENTICATED' });
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, iat: 1, exp: 9_999_999_999 })).toString('base64url')}.`;
    expect(await rejection({ token: none })).toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(await rejection({ token: tokenOf(randomUUID()) })).toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects a stale token (issued before tokens_valid_after, e.g. after logout-everywhere)', async () => {
    const user = await createUser(pool);
    const stale = tokenOf(user.id, {
      nowSeconds: Math.floor(Date.now() / 1000) - 60,
      ttlSeconds: 900,
    });
    await pool.query(
      'UPDATE users SET tokens_valid_after = now() WHERE id = $1',
      [user.id],
    );
    expect(await rejection({ token: stale })).toEqual({
      statusCode: 401,
      code: 'UNAUTHENTICATED',
    });
    await connect({ token: tokenOf(user.id) }); // a fresh token works
  });

  it('rejects a suspended user with ACCOUNT_SUSPENDED', async () => {
    const user = await createUser(pool, { status: 'SUSPENDED' });
    expect(await rejection({ token: tokenOf(user.id) })).toEqual({
      statusCode: 403,
      code: 'ACCOUNT_SUSPENDED',
    });
  });

  it('rejects a wrong Origin even with a valid token, and accepts the frontend origin or no Origin', async () => {
    const user = await createUser(pool);
    const token = tokenOf(user.id);
    expect(await rejection({ token, origin: 'https://evil.example' })).toEqual({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    expect(
      await rejection({ token, origin: 'http://localhost:3001.evil.example' }),
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await rejection({ token, origin: 'http://localhost:3002' }),
    ).toMatchObject({ code: 'FORBIDDEN' });
    await connect({ token, origin: ORIGIN });
    await connect({ token, origin: null }); // same-origin polling and non-browser clients send no Origin
  });

  it('does not accept the token from the URL (it is read from the auth payload only)', async () => {
    const user = await createUser(pool);
    expect(
      await rejection({ query: { token: tokenOf(user.id) } }),
    ).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('a rejected handshake leaves no socket behind', async () => {
    const user = await createUser(pool, { status: 'SUSPENDED' });
    await rejection({ token: tokenOf(user.id) });
    expect(registry.count(user.id)).toBe(0);
    expect(registry.onlineUsers()).toBe(0);
  });
});

describe('personal room, emitToUser(s)', () => {
  it('two sockets of one user both receive emitToUser; another user does not', async () => {
    const [alice, bob] = [await createUser(pool), await createUser(pool)];
    const [a1, a2, b1] = [
      await connect({ token: tokenOf(alice.id) }),
      await connect({ token: tokenOf(alice.id) }),
      await connect({ token: tokenOf(bob.id) }),
    ];
    await waitFor(
      () => registry.count(alice.id) === 2 && registry.count(bob.id) === 1,
    );

    const got = [nextEvent(a1, 'probe:hello'), nextEvent(a2, 'probe:hello')];
    const bobSilent = silent(b1, 'probe:hello');
    expect(realtime.emitToUser(alice.id, 'probe:hello', { n: 1 })).toBe(true);
    expect(await Promise.all(got)).toEqual([{ n: 1 }, { n: 1 }]);
    expect(await bobSilent).toBe(true);
  });

  it('emitToUsers reaches each listed user once, however many times a user is listed', async () => {
    const [alice, bob, carol] = [
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    const [a, b, c] = [
      await connect({ token: tokenOf(alice.id) }),
      await connect({ token: tokenOf(bob.id) }),
      await connect({ token: tokenOf(carol.id) }),
    ];
    await waitFor(() => registry.onlineUsers() === 3);
    const counts = { a: 0, b: 0 };
    a.on('probe:multi', () => counts.a++);
    b.on('probe:multi', () => counts.b++);
    const carolSilent = silent(c, 'probe:multi', 400);
    realtime.emitToUsers([alice.id, bob.id, alice.id], 'probe:multi', {
      ok: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(counts).toEqual({ a: 1, b: 1 });
    expect(await carolSilent).toBe(true);
  });

  it('emitting to a user who is offline is harmless', async () => {
    const offline = await createUser(pool);
    expect(realtime.emitToUser(offline.id, 'probe:hello', {})).toBe(true);
    expect(realtime.emitToUsers([], 'probe:hello', {})).toBe(true);
  });
});

describe('socket.connected / socket.disconnected events', () => {
  it('are emitted with wasLastSocket: false for the first of two sockets to close, true for the last', async () => {
    const user = await createUser(pool);
    const connected: unknown[] = [];
    const disconnected: {
      userId: string;
      socketId: string;
      wasLastSocket: boolean;
    }[] = [];
    const offs = [
      bus.on('socket.connected', (p) => void connected.push(p)),
      bus.on('socket.disconnected', (p) => void disconnected.push(p)),
    ];
    try {
      const [s1, s2] = [
        await connect({ token: tokenOf(user.id) }),
        await connect({ token: tokenOf(user.id) }),
      ];
      await waitFor(() => connected.length === 2);
      expect(connected).toEqual([
        { userId: user.id, socketId: expect.any(String) },
        { userId: user.id, socketId: expect.any(String) },
      ]);
      s1.close();
      await waitFor(() => disconnected.length === 1);
      expect(disconnected[0]).toMatchObject({
        userId: user.id,
        wasLastSocket: false,
      });
      s2.close();
      await waitFor(() => disconnected.length === 2);
      expect(disconnected[1]).toMatchObject({
        userId: user.id,
        wasLastSocket: true,
      });
      expect(registry.count(user.id)).toBe(0);
    } finally {
      offs.forEach((off) => off());
    }
  });
});

describe('disconnectUser and the session.revoked listener', () => {
  it('disconnectUser closes every socket of that user and no other', async () => {
    const [alice, bob] = [await createUser(pool), await createUser(pool)];
    const [a1, a2, b1] = [
      await connect({ token: tokenOf(alice.id) }),
      await connect({ token: tokenOf(alice.id) }),
      await connect({ token: tokenOf(bob.id) }),
    ];
    await waitFor(() => registry.count(alice.id) === 2);
    const closed = [nextEvent(a1, 'disconnect'), nextEvent(a2, 'disconnect')];
    expect(realtime.disconnectUser(alice.id)).toBe(2);
    await Promise.all(closed);
    expect(a1.connected || a2.connected).toBe(false);
    await waitFor(() => registry.count(alice.id) === 0);
    expect(b1.connected).toBe(true);
    expect(registry.count(bob.id)).toBe(1);
  });

  it('a session.revoked event sends "session:revoked" to every device and THEN closes the sockets; other users are untouched', async () => {
    const [alice, bob] = [await createUser(pool), await createUser(pool)];
    const [a1, a2, b1] = [
      await connect({ token: tokenOf(alice.id) }),
      await connect({ token: tokenOf(alice.id) }),
      await connect({ token: tokenOf(bob.id) }),
    ];
    await waitFor(() => registry.count(alice.id) === 2);
    const order: string[] = [];
    const watch = (socket: Socket, name: string) => {
      socket.on('session:revoked', () => order.push(`${name}:revoked`));
      return nextEvent(socket, 'disconnect').then(() =>
        order.push(`${name}:closed`),
      );
    };
    const finished = [watch(a1, 'a1'), watch(a2, 'a2')];
    bus.emit('session.revoked', { userId: alice.id });
    await Promise.all(finished);
    expect(order.filter((e) => e.startsWith('a1'))).toEqual([
      'a1:revoked',
      'a1:closed',
    ]);
    expect(order.filter((e) => e.startsWith('a2'))).toEqual([
      'a2:revoked',
      'a2:closed',
    ]);
    expect(b1.connected).toBe(true);
  });

  it('a revoked user can reconnect only with a token issued after the revocation', async () => {
    const user = await createUser(pool);
    const old = tokenOf(user.id, {
      nowSeconds: Math.floor(Date.now() / 1000) - 30,
      ttlSeconds: 900,
    });
    await connect({ token: old });
    await pool.query(
      'UPDATE users SET tokens_valid_after = now() WHERE id = $1',
      [user.id],
    ); // what revokeAllSessions does
    bus.emit('session.revoked', { userId: user.id });
    await waitFor(() => registry.count(user.id) === 0);
    expect(await rejection({ token: old })).toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await connect({ token: tokenOf(user.id) });
  });
});

describe('events on a connection (ValidationPipe, errors as acks, per-event checks)', () => {
  it('a valid payload is processed', async () => {
    const user = await createUser(pool);
    const socket = await connect({ token: tokenOf(user.id) });
    expect(await ack(socket, 'probe:echo', { text: 'hi' })).toEqual({
      ok: true,
      text: 'hi',
    });
  });

  it('the global ValidationPipe applies to gateway payloads: unknown field, wrong type, bad length, missing payload -> VALIDATION_FAILED', async () => {
    const user = await createUser(pool);
    const socket = await connect({ token: tokenOf(user.id) });
    const unknownField = await ack(socket, 'probe:echo', {
      text: 'hi',
      admin: true,
    });
    expect(unknownField).toMatchObject({
      ok: false,
      statusCode: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(
      (unknownField.errors as { field: string }[]).map((e) => e.field),
    ).toEqual(['admin']);
    expect(await ack(socket, 'probe:echo', { text: 123 })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    expect(await ack(socket, 'probe:echo', { text: '' })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    expect(
      await ack(socket, 'probe:echo', { text: 'x'.repeat(11) }),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(await ack(socket, 'probe:echo', undefined)).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    expect(await ack(socket, 'probe:echo', { text: 'ok' })).toEqual({
      ok: true,
      text: 'ok',
    }); // the connection is still fine
  });

  it('a validation failure without an ack callback arrives as an "exception" event', async () => {
    const user = await createUser(pool);
    const socket = await connect({ token: tokenOf(user.id) });
    const exception = nextEvent<{ ok: boolean; code: string }>(
      socket,
      'exception',
    );
    socket.emit('probe:echo', { text: '' });
    expect(await exception).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
  });

  it('an unexpected server error is a generic INTERNAL_ERROR ack: no stack, no message, and the connection survives', async () => {
    const user = await createUser(pool);
    const socket = await connect({ token: tokenOf(user.id) });
    const result = await ack(socket, 'probe:boom');
    expect(result).toMatchObject({
      ok: false,
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|postgresql|pw@/);
    expect(await ack(socket, 'probe:echo', { text: 'alive' })).toMatchObject({
      ok: true,
    });
  });

  it('an unknown event is ignored (and does not close the connection)', async () => {
    const user = await createUser(pool);
    const socket = await connect({ token: tokenOf(user.id) });
    socket.emit('no-such-event', {});
    expect(await ack(socket, 'probe:echo', { text: 'ok' })).toMatchObject({
      ok: true,
    });
  });

  it('every event re-checks the user: after suspension the next event is ACCOUNT_SUSPENDED, without a reconnect', async () => {
    const user = await createUser(pool);
    const socket = await connect({ token: tokenOf(user.id) });
    const conversationId = randomUUID();
    expect(await ack(socket, 'probe:send', { conversationId })).toEqual({
      ok: true,
    });
    await pool.query(
      "UPDATE users SET status = 'SUSPENDED', suspended_at = now() WHERE id = $1",
      [user.id],
    );
    expect(await ack(socket, 'probe:send', { conversationId })).toMatchObject({
      ok: false,
      statusCode: 403,
      code: 'ACCOUNT_SUSPENDED',
    });
  });

  it('every event re-checks the session: after tokens_valid_after moves forward, the next event is UNAUTHENTICATED', async () => {
    const user = await createUser(pool);
    const socket = await connect({
      token: tokenOf(user.id, {
        nowSeconds: Math.floor(Date.now() / 1000) - 30,
        ttlSeconds: 900,
      }),
    });
    await pool.query(
      'UPDATE users SET tokens_valid_after = now() WHERE id = $1',
      [user.id],
    );
    expect(
      await ack(socket, 'probe:send', { conversationId: randomUUID() }),
    ).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
  });

  it('a packet over the size cap closes the connection instead of being buffered', async () => {
    const user = await createUser(pool);
    const socket = await connect({ token: tokenOf(user.id) });
    const closed = nextEvent(socket, 'disconnect', 5000);
    socket.emit('probe:echo', { text: 'x'.repeat(70_000) });
    await closed;
    expect(socket.connected).toBe(false);
  });
});

describe('Per-conversation burst over Socket.IO and REST share one budget (Decision 167)', () => {
  it('30 events by one user in one conversation pass, the 31st is TOO_MANY_REQUESTS; REST counts against the same budget', async () => {
    const user = await createUser(pool);
    const socket = await connect({ token: tokenOf(user.id) });
    const conversationId = randomUUID();
    const send = () => ack(socket, 'probe:send', { conversationId });
    for (let i = 0; i < 15; i++) expect(await send()).toEqual({ ok: true });
    // 15 more over REST, the same user and conversation
    for (let i = 0; i < 15; i++)
      await request(app.getHttpServer())
        .post(`/api/v1/probe-auth/conversations/${conversationId}/messages`)
        .set('Authorization', bearer(user.id))
        .expect(201);
    expect(await send()).toMatchObject({
      ok: false,
      statusCode: 429,
      code: 'TOO_MANY_REQUESTS',
    });
    await request(app.getHttpServer())
      .post(`/api/v1/probe-auth/conversations/${conversationId}/messages`)
      .set('Authorization', bearer(user.id))
      .expect(429);
    // another conversation is not affected
    expect(
      await ack(socket, 'probe:send', { conversationId: randomUUID() }),
    ).toEqual({ ok: true });
  });
});

describe('HTTP next to Socket.IO', () => {
  it('the HTTP API still works and is still secure by default when the socket server is attached', async () => {
    await request(app.getHttpServer()).get('/api/v1/probe-auth/me').expect(401);
    const user = await createUser(pool);
    await request(app.getHttpServer())
      .get('/api/v1/probe-auth/me')
      .set('Authorization', bearer(user.id))
      .expect(200);
  });
});
