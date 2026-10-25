import express from 'express';
import request from 'supertest';
import {
  JsonLogger,
  REDACTED,
  httpLoggingMiddleware,
  isSensitiveKey,
  redact,
  redactString,
  requestIdMiddleware,
  runWithRequestId,
  type LogSink,
} from '../../src/common/logging/index.js';

class MemorySink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
  get entries(): Record<string, unknown>[] {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

describe('redaction', () => {
  it('matches sensitive keys by word, in camelCase, snake_case and kebab-case, but not look-alikes', () => {
    for (const key of [
      'password',
      'passwordHash',
      'password_hash',
      'token_hash',
      'accessToken',
      'refresh-token',
      'Authorization',
      'set-cookie',
      'jwtSecret',
      'api_key',
      'x-api-key',
      'textBody',
      'text_body',
      'messageBody',
      'message_snapshot',
      'email',
      'Content',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of [
      'context',
      'requestId',
      'userId',
      'status',
      'path',
      'durationMs',
      'action',
      'targetType',
      'compass',
    ]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('redacts nested objects and arrays and keeps everything else', () => {
    const result = redact({
      userId: 'u1',
      password: 'hunter2',
      nested: {
        refreshToken: 'abc',
        ok: 1,
        list: [{ textBody: 'private message', n: 2 }],
      },
      tags: ['a', 'b'],
    });
    expect(result).toEqual({
      userId: 'u1',
      password: REDACTED,
      nested: {
        refreshToken: REDACTED,
        ok: 1,
        list: [{ textBody: REDACTED, n: 2 }],
      },
      tags: ['a', 'b'],
    });
  });

  it('redacts secrets that appear inside strings: bearer tokens, JWTs and credentials in URLs', () => {
    expect(redactString('Authorization: Bearer abc.def.ghi-123')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    expect(redactString(`token was ${jwt} ok`)).toBe(
      `token was ${REDACTED} ok`,
    );
    expect(
      redactString(
        'connect postgresql://nelio:s3cr3t@localhost:5433/nelio failed',
      ),
    ).toBe(
      `connect postgresql://nelio:${REDACTED}@localhost:5433/nelio failed`,
    );
  });

  it('survives cycles, errors, BigInt, dates, functions and deep nesting without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    const error = new Error('failed with Bearer abc123.xyz');
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    const out = redact({
      cyclic,
      error,
      big: 10n,
      when: new Date('2026-01-02T03:04:05Z'),
      fn: () => 1,
      deep,
    }) as Record<string, any>;
    expect(out.cyclic.self).toBe('[Circular]');
    expect(out.error.message).toBe(`failed with Bearer ${REDACTED}`);
    expect(out.big).toBe('10');
    expect(out.when).toBe('2026-01-02T03:04:05.000Z');
    expect(out.fn).toBeUndefined();
    expect(JSON.stringify(out.deep)).toContain('[Truncated]');
  });
});

describe('JsonLogger', () => {
  it('writes one JSON object per line with time, level, context and message', () => {
    const sink = new MemorySink();
    new JsonLogger('debug', sink).log('server started', 'Bootstrap');
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0].endsWith('\n')).toBe(true);
    expect(sink.entries[0]).toMatchObject({
      level: 'info',
      context: 'Bootstrap',
      message: 'server started',
    });
    expect(new Date(sink.entries[0].time as string).toString()).not.toBe(
      'Invalid Date',
    );
  });

  it('honours the level threshold', () => {
    const sink = new MemorySink();
    const logger = new JsonLogger('warn', sink);
    logger.debug('d');
    logger.verbose('v');
    logger.log('i');
    logger.warn('w');
    logger.error('e');
    expect(sink.entries.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('includes the request id from the current request context and nothing outside it', () => {
    const sink = new MemorySink();
    const logger = new JsonLogger('info', sink);
    logger.log('outside');
    runWithRequestId('req-12345678', () => logger.log('inside'));
    expect(sink.entries[0].requestId).toBeUndefined();
    expect(sink.entries[1].requestId).toBe('req-12345678');
  });

  it('redacts fields, message text and error details, and serializes errors with their stack', () => {
    const sink = new MemorySink();
    const logger = new JsonLogger('info', sink);
    logger.log(
      'login with Bearer abc.def.ghi',
      { password: 'hunter2', userId: 'u1' },
      'Auth',
    );
    logger.error(new Error('db at postgresql://u:pw@h/db'), 'Db');
    logger.error('boom', 'Error: boom\n    at x (file.js:1:1)', 'Ctx');
    const [login, errorEntry, withStack] = sink.entries;
    expect(login).toMatchObject({
      message: `login with Bearer ${REDACTED}`,
      password: REDACTED,
      userId: 'u1',
      context: 'Auth',
    });
    expect(JSON.stringify(errorEntry)).not.toContain(':pw@');
    expect(errorEntry.error).toMatchObject({ name: 'Error' });
    expect(withStack.stack).toContain('at x (file.js:1:1)');
    expect(withStack.context).toBe('Ctx');
  });

  it('accepts an object as the message', () => {
    const sink = new MemorySink();
    new JsonLogger('info', sink).log({ event: 'x', token: 'secret' });
    expect(sink.entries[0]).toMatchObject({
      message: '',
      event: 'x',
      token: REDACTED,
    });
  });
});

describe('request id and HTTP logging (real Express app)', () => {
  const makeApp = () => {
    const sink = new MemorySink();
    const logger = new JsonLogger('debug', sink);
    const app = express();
    app.use(requestIdMiddleware);
    app.use(httpLoggingMiddleware(logger));
    app.use(express.json());
    app.post('/login', (req, res) => {
      logger.log('login attempt', { email: req.body.email, route: 'login' });
      res.status(401).json({ ok: false });
    });
    app.get('/boom', () => {
      throw new Error('kaput');
    });
    app.get('/ok', (_req, res) => void res.json({ ok: true }));
    return { app, sink };
  };

  it('assigns a request id, returns it in X-Request-Id and puts it on every line of that request', async () => {
    const { app, sink } = makeApp();
    const res = await request(app).get('/ok');
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]).toMatchObject({
      event: 'http_request',
      method: 'GET',
      path: '/ok',
      status: 200,
      requestId: id,
      context: 'HTTP',
    });
    expect(typeof sink.entries[0].durationMs).toBe('number');
  });

  it('accepts a safe incoming id and replaces an unsafe one (no log injection)', async () => {
    const { app } = makeApp();
    expect(
      (await request(app).get('/ok').set('X-Request-Id', 'client-id-123456'))
        .headers['x-request-id'],
    ).toBe('client-id-123456');
    const bad = await request(app)
      .get('/ok')
      .set('X-Request-Id', 'x"} {"level":"fatal"');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs 4xx as warn and 5xx as error', async () => {
    const { app, sink } = makeApp();
    await request(app)
      .post('/login')
      .send({ email: 'a@b.c', password: 'hunter2' });
    await request(app).get('/boom');
    const http = sink.entries.filter((e) => e.event === 'http_request');
    expect(http.map((e) => [e.path, e.status, e.level])).toEqual([
      ['/login', 401, 'warn'],
      ['/boom', 500, 'error'],
    ]);
  });

  it('LOG CONTENT: passwords, tokens, cookies, query strings, e-mail addresses and message bodies never reach the log', async () => {
    const { app, sink } = makeApp();
    await request(app)
      .post('/login?token=QUERYTOKEN123&reset=RESETSECRET')
      .set('Authorization', 'Bearer HEADERTOKEN.abc.def')
      .set('Cookie', 'refresh=COOKIESECRET')
      .send({
        email: 'person@example.test',
        password: 'PASSWORD-VALUE-1',
        body: 'PRIVATE MESSAGE TEXT',
      });
    const everything = sink.lines.join('');
    for (const secret of [
      'QUERYTOKEN123',
      'RESETSECRET',
      'HEADERTOKEN',
      'COOKIESECRET',
      'person@example.test',
      'PASSWORD-VALUE-1',
      'PRIVATE MESSAGE TEXT',
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(sink.entries.find((e) => e.event === 'http_request')?.path).toBe(
      '/login',
    );
    expect(
      sink.entries.find((e) => e.message === 'login attempt'),
    ).toMatchObject({ email: REDACTED });
  });
});
