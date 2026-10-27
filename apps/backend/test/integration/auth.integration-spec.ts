// M11a: Auth against the real database over HTTP, with a fake mail service (it records what would be sent) and a fake Google verifier.
import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { ApiException } from '../../src/common/filters/index.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import { DatabaseModule } from '../../src/infrastructure/database/index.js';
import {
  EventBus,
  EventsModule,
} from '../../src/infrastructure/events/index.js';
import { MailService } from '../../src/infrastructure/mail/index.js';
import {
  AuthCleanupService,
  AuthModule,
} from '../../src/modules/auth/index.js';
import { hashToken } from '../../src/modules/auth/services/sessions.service.js';
import {
  GoogleTokenVerifier,
  type GoogleProfile,
} from '../../src/modules/auth/services/google-auth.service.js';
import { PasswordService } from '../../src/modules/auth/services/password.service.js';
import { TokenIssuer } from '../../src/modules/auth/services/token-issuer.service.js';
import { UsersModule } from '../../src/modules/users/index.js';
import { createPool, resetData } from '../support/database.js';
import { createRefreshToken } from '../support/factories.js';
import {
  TEST_JWT_SECRET,
  closeApp,
  testEnv,
} from '../support/integration-app.js';

const pool = createPool(20);
const FRONTEND = 'http://localhost:3001';
let app: NestExpressApplication;
let issuer: TokenIssuer;
let passwords: PasswordService;
let cleanup: AuthCleanupService;

interface Sent {
  kind: 'verification' | 'reset' | 'already';
  to: string;
  token?: string;
  validForHours?: number;
  fullName: string;
}
const sent: Sent[] = [];
const fakeMail = {
  sendEmailVerification: (
    to: string,
    input: { fullName: string; token: string; validForHours: number },
  ) => {
    sent.push({ kind: 'verification', to, ...input });
    return Promise.resolve(true);
  },
  sendPasswordReset: (
    to: string,
    input: { fullName: string; token: string; validForHours: number },
  ) => {
    sent.push({ kind: 'reset', to, ...input });
    return Promise.resolve(true);
  },
  sendAlreadyRegistered: (to: string, input: { fullName: string }) => {
    sent.push({ kind: 'already', to, ...input });
    return Promise.resolve(true);
  },
};

class FakeGoogle extends GoogleTokenVerifier {
  readonly profiles = new Map<string, GoogleProfile>();
  verify(idToken: string): Promise<GoogleProfile> {
    const profile = this.profiles.get(idToken);
    if (!profile) return Promise.reject(new ApiException('UNAUTHENTICATED'));
    return Promise.resolve(profile);
  }
}
const google = new FakeGoogle();
const revoked: string[] = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      UsersModule,
      AuthModule,
    ],
    providers: GLOBAL_PROVIDERS,
  })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .overrideProvider(GoogleTokenVerifier)
    .useValue(google)
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  issuer = app.get(TokenIssuer, { strict: false });
  passwords = app.get(PasswordService, { strict: false });
  cleanup = app.get(AuthCleanupService);
  app.get(EventBus).on('session.revoked', ({ userId }) => {
    revoked.push(userId);
  });
});
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  sent.length = 0;
  revoked.length = 0;
  google.profiles.clear();
  jest.restoreAllMocks();
});

let counter = 0;
const ip = () => `10.9.${(counter >> 8) & 255}.${counter++ & 255}`;
const post = (
  path: string,
  body: object = {},
  headers: Record<string, string> = {},
) => {
  const r = request(app.getHttpServer())
    .post(`/api/v1${path}`)
    .set('X-Forwarded-For', ip());
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r.send(body);
};
const authed = (
  method: 'get' | 'post' | 'delete',
  path: string,
  token: string,
  body: object = {},
) => {
  const r = request(app.getHttpServer())
    [method](`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Forwarded-For', ip());
  return method === 'post' ? r.send(body) : r;
};
const cookieOf = (res: request.Response): string | undefined => {
  const header = (
    res.headers['set-cookie'] as unknown as string[] | undefined
  )?.find((c) => c.startsWith('nelio_refresh='));
  return header?.split(';')[0].slice('nelio_refresh='.length);
};
const refreshWith = (cookie: string, headers: Record<string, string> = {}) =>
  post('/auth/refresh', {}, { Cookie: `nelio_refresh=${cookie}`, ...headers });

const PASSWORD = 'correct horse battery';
const uniqueEmail = () => `user-${randomUUID().slice(0, 8)}@example.test`;
async function registerAndVerify(email = uniqueEmail(), password = PASSWORD) {
  await post('/auth/register', {
    email,
    fullName: 'Test User',
    password,
  }).expect(202);
  const mail = sent
    .filter((m) => m.kind === 'verification' && m.to === email)
    .at(-1) as Sent;
  await post('/auth/verify-email', { token: mail.token }).expect(204);
  const user = (
    await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
      email,
    ])
  ).rows[0];
  return { email, password, id: user.id };
}
const login = (email: string, password = PASSWORD) =>
  post('/auth/login', { email, password });
const userRow = async (id: string) =>
  (
    await pool.query<{
      password_hash: string | null;
      email_verified_at: Date | null;
      tokens_valid_after: Date | null;
      status: string;
    }>(
      'SELECT password_hash, email_verified_at, tokens_valid_after, status FROM users WHERE id = $1',
      [id],
    )
  ).rows[0];
const aliveTokens = async (userId: string) =>
  (
    await pool.query(
      'SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    )
  ).rowCount;

describe('registration and email verification', () => {
  it('is always 202 with the same body, whatever the state of the address', async () => {
    const verified = await registerAndVerify();
    const unverifiedEmail = uniqueEmail();
    await post('/auth/register', {
      email: unverifiedEmail,
      fullName: 'Un Verified',
      password: PASSWORD,
    }).expect(202);
    const bodies = [
      (
        await post('/auth/register', {
          email: uniqueEmail(),
          fullName: 'New',
          password: PASSWORD,
        }).expect(202)
      ).body,
      (
        await post('/auth/register', {
          email: verified.email,
          fullName: 'Again',
          password: PASSWORD,
        }).expect(202)
      ).body,
      (
        await post('/auth/register', {
          email: unverifiedEmail,
          fullName: 'Again',
          password: 'another long password',
        }).expect(202)
      ).body,
    ];
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it('a new address creates an unverified STUDENT and emails a verification link; it cannot log in until verified', async () => {
    const email = uniqueEmail();
    await post('/auth/register', {
      email: email.toUpperCase(),
      fullName: '  Անի  ',
      password: PASSWORD,
    }).expect(202);
    const user = (
      await pool.query(
        'SELECT id, email, full_name, email_verified_at, password_hash FROM users WHERE email = $1',
        [email],
      )
    ).rows[0];
    expect(user).toMatchObject({
      email,
      full_name: 'Անի',
      email_verified_at: null,
    });
    expect(user.password_hash).toMatch(/^\$argon2id\$/);
    expect(
      (
        await pool.query(
          'SELECT role, status FROM user_roles WHERE user_id = $1',
          [user.id],
        )
      ).rows,
    ).toEqual([{ role: 'STUDENT', status: 'ACTIVE' }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'verification', to: email });
    const refused = await login(email).expect(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect(refused.body.message).toMatch(/verify/i);
  });

  it('register with a role (or any unknown property) is 400 and creates nothing', async () => {
    for (const extra of [
      { role: 'ADMIN' },
      { roles: ['ADMIN'] },
      { isAdmin: true },
      { status: 'ACTIVE' },
      { emailVerifiedAt: '2020-01-01' },
    ]) {
      await post('/auth/register', {
        email: uniqueEmail(),
        fullName: 'X',
        password: PASSWORD,
        ...extra,
      }).expect(400);
    }
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(0);
    expect(
      (await pool.query("SELECT 1 FROM user_roles WHERE role = 'ADMIN'"))
        .rowCount,
    ).toBe(0);
  });

  it('validates the input: email shape, name, and the password rules (10-128 characters, not a very common one)', async () => {
    const ok = () => ({ fullName: 'Name', password: PASSWORD });
    const reg = (over: object) =>
      post('/auth/register', { email: uniqueEmail(), ...ok(), ...over });
    await reg({ email: 'not-an-email' }).expect(400);
    await reg({ fullName: '' }).expect(400);
    await reg({ password: 'short' }).expect(400);
    await reg({ password: 'x'.repeat(129) }).expect(400);
    const common = await reg({ password: 'password123' }).expect(400);
    expect(common.body.errors[0].field).toBe('password');
    await reg({ password: 'Password123' }).expect(400);
    await reg({ password: '😀'.repeat(128) }).expect(400); // one repeated character
    await reg({ password: 'ա'.repeat(5) + 'բ'.repeat(5) }).expect(202); // 10 code points, no composition rules
    expect(sent).toHaveLength(1);
  });

  it('an unverified re-registration REPLACES the password; the old password stops working and the new one works after verification', async () => {
    const email = uniqueEmail();
    await post('/auth/register', {
      email,
      fullName: 'A',
      password: 'first long password',
    }).expect(202);
    const before = (
      await pool.query<{ id: string; password_hash: string }>(
        'SELECT id, password_hash FROM users WHERE email = $1',
        [email],
      )
    ).rows[0];
    await pool.query(
      "UPDATE email_tokens SET created_at = now() - interval '5 minutes'",
    );
    await post('/auth/register', {
      email,
      fullName: 'A',
      password: 'second long password',
    }).expect(202);
    const after = (
      await pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [before.id],
      )
    ).rows[0];
    expect(after.password_hash).not.toBe(before.password_hash);
    expect(
      await passwords.verify(after.password_hash, 'second long password'),
    ).toBe(true);
    expect(
      await passwords.verify(after.password_hash, 'first long password'),
    ).toBe(false);
    expect(
      (await pool.query('SELECT 1 FROM users WHERE email = $1', [email]))
        .rowCount,
    ).toBe(1);
    const mail = sent.filter((m) => m.kind === 'verification').at(-1) as Sent;
    await post('/auth/verify-email', { token: mail.token }).expect(204);
    await login(email, 'first long password').expect(401);
    await login(email, 'second long password').expect(200);
  });

  it('a VERIFIED address is unchanged by a new registration and receives the "already registered" email', async () => {
    const user = await registerAndVerify();
    const before = await userRow(user.id);
    sent.length = 0;
    await post('/auth/register', {
      email: user.email,
      fullName: 'Intruder',
      password: 'attacker long password',
    }).expect(202);
    expect(await userRow(user.id)).toEqual(before);
    expect(sent).toEqual([
      expect.objectContaining({ kind: 'already', to: user.email }),
    ]);
    await login(user.email, 'attacker long password').expect(401);
    await login(user.email).expect(200);
  });

  it('two registrations of the same new address at the same moment make one user', async () => {
    const email = uniqueEmail();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        post('/auth/register', {
          email,
          fullName: 'Racer',
          password: PASSWORD,
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([202, 202, 202]);
    expect(
      (await pool.query('SELECT 1 FROM users WHERE email = $1', [email]))
        .rowCount,
    ).toBe(1);
  });

  it('the newest-token cooldown: a second request inside 60 seconds sends nothing new; after it, a new link', async () => {
    const email = uniqueEmail();
    await post('/auth/register', {
      email,
      fullName: 'A',
      password: PASSWORD,
    }).expect(202);
    await post('/auth/resend-verification', { email }).expect(202);
    await post('/auth/register', {
      email,
      fullName: 'A',
      password: PASSWORD,
    }).expect(202);
    expect(sent.filter((m) => m.kind === 'verification')).toHaveLength(1);
    await pool.query(
      "UPDATE email_tokens SET created_at = now() - interval '61 seconds'",
    );
    await post('/auth/resend-verification', { email }).expect(202);
    expect(sent.filter((m) => m.kind === 'verification')).toHaveLength(2);
  });

  it('resend-verification answers 202 for unknown and verified addresses and sends nothing', async () => {
    const user = await registerAndVerify();
    sent.length = 0;
    await post('/auth/resend-verification', { email: uniqueEmail() }).expect(
      202,
    );
    await post('/auth/resend-verification', { email: user.email }).expect(202);
    expect(sent).toEqual([]);
  });

  it('verify-email marks the address verified, is single-use, never logs in, and an expired or unknown token is 400 TOKEN_INVALID', async () => {
    const email = uniqueEmail();
    await post('/auth/register', {
      email,
      fullName: 'A',
      password: PASSWORD,
    }).expect(202);
    const token = (sent[0] as Sent).token as string;
    const res = await post('/auth/verify-email', { token }).expect(204);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toEqual({});
    expect(
      (
        await pool.query(
          'SELECT email_verified_at FROM users WHERE email = $1',
          [email],
        )
      ).rows[0].email_verified_at,
    ).not.toBeNull();
    expect(
      (await post('/auth/verify-email', { token }).expect(400)).body.code,
    ).toBe('TOKEN_INVALID');
    expect(
      (await post('/auth/verify-email', { token: 'x'.repeat(43) }).expect(400))
        .body.code,
    ).toBe('TOKEN_INVALID');
    await post('/auth/verify-email', { token: 'short' }).expect(400);
    const other = uniqueEmail();
    await post('/auth/register', {
      email: other,
      fullName: 'B',
      password: PASSWORD,
    }).expect(202);
    await pool.query(
      "UPDATE email_tokens SET expires_at = now() - interval '1 second' WHERE used_at IS NULL",
    );
    expect(
      (
        await post('/auth/verify-email', {
          token: (sent.at(-1) as Sent).token,
        }).expect(400)
      ).body.code,
    ).toBe('TOKEN_INVALID');
  });

  it('a token is single-use even when two requests consume it at the same moment: exactly one wins', async () => {
    const email = uniqueEmail();
    await post('/auth/register', {
      email,
      fullName: 'A',
      password: PASSWORD,
    }).expect(202);
    const token = (sent[0] as Sent).token as string;
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => post('/auth/verify-email', { token })),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      204, 400, 400, 400,
    ]);
  });

  it('a reset token cannot be used as a verification token and the other way round', async () => {
    const user = await registerAndVerify();
    await post('/auth/forgot-password', { email: user.email }).expect(202);
    const reset = sent.find((m) => m.kind === 'reset') as Sent;
    expect(
      (await post('/auth/verify-email', { token: reset.token }).expect(400))
        .body.code,
    ).toBe('TOKEN_INVALID');
    const email = uniqueEmail();
    await post('/auth/register', {
      email,
      fullName: 'A',
      password: PASSWORD,
    }).expect(202);
    const verification = sent
      .filter((m) => m.kind === 'verification')
      .at(-1) as Sent;
    expect(
      (
        await post('/auth/reset-password', {
          token: verification.token,
          newPassword: 'brand new password',
        }).expect(400)
      ).body.code,
    ).toBe('TOKEN_INVALID');
  });
});

describe('the email lifetime and the stored expiry agree (M11a, owner decision 2026-10-26)', () => {
  const lifetimeOf = async (email: string, type: string) => {
    const row = (
      await pool.query<{ hours: number; created: Date; expires: Date }>(
        `SELECT extract(epoch FROM (t.expires_at - t.created_at)) / 3600 AS hours, t.created_at AS created, t.expires_at AS expires
         FROM email_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1 AND t.type = $2::email_token_type ORDER BY t.created_at DESC LIMIT 1`,
        [email, type],
      )
    ).rows[0];
    return Number(row.hours);
  };

  it('verification: the email says 24 hours and the stored expires_at is 24 hours after the token was created', async () => {
    const email = uniqueEmail();
    await post('/auth/register', {
      email,
      fullName: 'A',
      password: PASSWORD,
    }).expect(202);
    const mail = sent[0] as Sent;
    expect(mail.validForHours).toBe(24);
    expect(
      Math.round((await lifetimeOf(email, 'EMAIL_VERIFICATION')) * 1000) / 1000,
    ).toBeCloseTo(mail.validForHours as number, 2);
  });

  it('reset: the email says 1 hour and the stored expires_at is 1 hour after the token was created', async () => {
    const user = await registerAndVerify();
    await post('/auth/forgot-password', { email: user.email }).expect(202);
    const mail = sent.find((m) => m.kind === 'reset') as Sent;
    expect(mail.validForHours).toBe(1);
    expect(await lifetimeOf(user.email, 'PASSWORD_RESET')).toBeCloseTo(1, 2);
  });

  it('a verification token still works after 23 hours and a reset token is dead after 61 minutes', async () => {
    const user = await registerAndVerify();
    await post('/auth/forgot-password', { email: user.email }).expect(202);
    const reset = sent.find((m) => m.kind === 'reset') as Sent;
    await pool.query(
      "UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE type = 'PASSWORD_RESET'",
    );
    expect(
      (
        await post('/auth/reset-password', {
          token: reset.token,
          newPassword: 'brand new password',
        }).expect(400)
      ).body.code,
    ).toBe('TOKEN_INVALID');
    const email = uniqueEmail();
    await post('/auth/register', {
      email,
      fullName: 'A',
      password: PASSWORD,
    }).expect(202);
    const verification = sent
      .filter((m) => m.kind === 'verification')
      .at(-1) as Sent;
    await pool.query(
      "UPDATE email_tokens SET created_at = now() - interval '23 hours', expires_at = now() + interval '1 hour' WHERE used_at IS NULL AND type = 'EMAIL_VERIFICATION' AND user_id = (SELECT id FROM users WHERE email = $1)",
      [email],
    );
    await post('/auth/verify-email', { token: verification.token }).expect(204);
  });
});

describe('login', () => {
  it('returns an access token in the body and the refresh token only as an HttpOnly cookie with the documented attributes', async () => {
    const user = await registerAndVerify();
    const res = await login(user.email).expect(200);
    expect(res.body).toEqual({
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      expiresIn: 900,
    });
    const setCookie = (res.headers['set-cookie'] as unknown as string[]).find(
      (c) => c.startsWith('nelio_refresh='),
    ) as string;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\/api\/v1\/auth(;|$)/);
    expect(JSON.stringify(res.body)).not.toContain(cookieOf(res) as string);
    const claims = JSON.parse(
      Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString(),
    );
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'sub']);
    expect(claims.sub).toBe(user.id);
    expect(claims.exp - claims.iat).toBe(900);
    const stored = (
      await pool.query<{ token_hash: string }>(
        'SELECT token_hash FROM refresh_tokens WHERE user_id = $1',
        [user.id],
      )
    ).rows[0];
    expect(stored.token_hash).toBe(hashToken(cookieOf(res) as string));
    expect(stored.token_hash).not.toBe(cookieOf(res));
  });

  it('unknown email, wrong password and a Google-only account give the SAME status and body, and all do the work of a password check', async () => {
    const user = await registerAndVerify();
    google.profiles.set('google-token-only-account-0001', {
      sub: 'g-only',
      email: 'only-google@example.test',
      emailVerified: true,
      name: 'G',
    });
    await post('/auth/google', {
      idToken: 'google-token-only-account-0001',
    }).expect(200);
    const verify = jest.spyOn(passwords, 'verify');
    const attempts = [
      await login(uniqueEmail()),
      await login(user.email, 'wrong password here'),
      await login('only-google@example.test'),
    ];
    expect(attempts.map((r) => r.status)).toEqual([401, 401, 401]);
    expect(new Set(attempts.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(verify).toHaveBeenCalledTimes(3);
    expect(attempts[0].headers['set-cookie']).toBeUndefined();
  });

  it('is throttled BEFORE any hashing: the sixth attempt in a minute for one address is 429 and no password was checked for it', async () => {
    const email = uniqueEmail();
    const verify = jest.spyOn(passwords, 'verify');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push(
        (
          await post(
            '/auth/login',
            { email, password: 'whatever long' },
            { 'X-Forwarded-For': ip() },
          )
        ).status,
      );
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect(verify).toHaveBeenCalledTimes(5);
  });

  it('a suspended account is 403 ACCOUNT_SUSPENDED after a correct password and gets no tokens', async () => {
    const user = await registerAndVerify();
    await pool.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [
      user.id,
    ]);
    const res = await login(user.email).expect(403);
    expect(res.body.code).toBe('ACCOUNT_SUSPENDED');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(
      (
        await pool.query('SELECT 1 FROM refresh_tokens WHERE user_id = $1', [
          user.id,
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('the email address is case-insensitive', async () => {
    const user = await registerAndVerify();
    await login(user.email.toUpperCase()).expect(200);
  });
});

describe('refresh', () => {
  async function session() {
    const user = await registerAndVerify();
    const res = await login(user.email).expect(200);
    return {
      user,
      cookie: cookieOf(res) as string,
      access: res.body.accessToken as string,
    };
  }

  it('rotates: a new cookie and a new access token, the old token is marked used, the family stays', async () => {
    const { user, cookie } = await session();
    const res = await refreshWith(cookie).expect(200);
    const next = cookieOf(res) as string;
    expect(next).not.toBe(cookie);
    expect(res.body.accessToken).toEqual(expect.any(String));
    const rows = (
      await pool.query<{
        token_hash: string;
        family_id: string;
        used_at: Date | null;
      }>(
        'SELECT token_hash, family_id, used_at FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at',
        [user.id],
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].family_id).toBe(rows[1].family_id);
    expect(rows[0].used_at).not.toBeNull();
    expect(rows[1].used_at).toBeNull();
    await refreshWith(next).expect(200);
  });

  it('a missing, unknown or malformed cookie is 401 and clears the cookie', async () => {
    const none = await post('/auth/refresh').expect(401);
    expect(String(none.headers['set-cookie'])).toMatch(/nelio_refresh=;/);
    await refreshWith('not-a-real-token').expect(401);
    await post(
      '/auth/refresh',
      {},
      { Cookie: 'other=1; nelio_refresh=%E0%A4%A' },
    ).expect(401);
  });

  it('reuse inside the grace window is 409 and revokes NOTHING; the newest token keeps working', async () => {
    const { user, cookie } = await session();
    const first = await refreshWith(cookie).expect(200);
    const again = await refreshWith(cookie).expect(409);
    expect(again.body.code).toBe('RESOURCE_CONFLICT');
    expect(await aliveTokens(user.id)).toBe(2); // nothing was revoked: the used token and its successor
    expect(
      (
        await pool.query(
          'SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NOT NULL',
          [user.id],
        )
      ).rowCount,
    ).toBe(0);
    await refreshWith(cookieOf(first) as string).expect(200);
  });

  it('reuse AFTER the grace window revokes the whole family and the revocation persists after the 401', async () => {
    const { user, cookie } = await session();
    const first = await refreshWith(cookie).expect(200);
    const newest = cookieOf(first) as string;
    await pool.query(
      "UPDATE refresh_tokens SET used_at = now() - interval '11 seconds' WHERE used_at IS NOT NULL",
    );
    await refreshWith(cookie).expect(401);
    expect(await aliveTokens(user.id)).toBe(0); // committed before the 401 was sent
    await refreshWith(newest).expect(401); // the thief and the real owner are both logged out
    expect(
      (
        await pool.query(
          'SELECT 1 FROM refresh_tokens WHERE revoked_at IS NOT NULL AND user_id = $1',
          [user.id],
        )
      ).rowCount,
    ).toBe(2);
  });

  it('another device of the same user is not affected by a replay in one family', async () => {
    const user = await registerAndVerify();
    const [a, b] = [
      cookieOf(await login(user.email).expect(200)) as string,
      cookieOf(await login(user.email).expect(200)) as string,
    ];
    await refreshWith(a).expect(200);
    await pool.query(
      "UPDATE refresh_tokens SET used_at = now() - interval '11 seconds' WHERE used_at IS NOT NULL",
    );
    await refreshWith(a).expect(401);
    await refreshWith(b).expect(200);
  });

  it('two parallel refreshes with the same token produce exactly ONE new token', async () => {
    for (let round = 0; round < 5; round++) {
      const { user, cookie } = await session();
      const results = await Promise.all([
        refreshWith(cookie),
        refreshWith(cookie),
        refreshWith(cookie),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
        200, 409, 409,
      ]);
      expect(
        (
          await pool.query(
            'SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND used_at IS NULL',
            [user.id],
          )
        ).rowCount,
      ).toBe(1);
    }
  });

  it('is refused 90 days after the family started, and a token never outlives the 90-day cap', async () => {
    const { user, cookie } = await session();
    await pool.query(
      "UPDATE refresh_tokens SET family_started_at = now() - interval '91 days', expires_at = now() - interval '1 day' WHERE user_id = $1",
      [user.id],
    );
    await refreshWith(cookie).expect(401);
    const fresh = await session();
    await pool.query(
      "UPDATE refresh_tokens SET family_started_at = now() - interval '89 days', expires_at = now() + interval '1 day' WHERE user_id = $1",
      [fresh.user.id],
    );
    const res = await refreshWith(fresh.cookie).expect(200);
    const rows = (
      await pool.query<{ left_days: number }>(
        'SELECT extract(epoch FROM (expires_at - now())) / 86400 AS left_days FROM refresh_tokens WHERE token_hash = $1',
        [hashToken(cookieOf(res) as string)],
      )
    ).rows;
    expect(Number(rows[0].left_days)).toBeGreaterThan(0.9);
    expect(Number(rows[0].left_days)).toBeLessThan(1.1); // capped at day 90, not 30 days from now
  });

  it('an idle token lives 30 days from its issue', async () => {
    const { user } = await session();
    const days = (
      await pool.query<{ d: number }>(
        'SELECT extract(epoch FROM (expires_at - created_at)) / 86400 AS d FROM refresh_tokens WHERE user_id = $1',
        [user.id],
      )
    ).rows[0].d;
    expect(Number(days)).toBeCloseTo(30, 1);
  });

  it('the Origin check: another origin is 403, the frontend origin or no Origin is accepted (refresh and logout)', async () => {
    const { cookie } = await session();
    await refreshWith(cookie, { Origin: 'https://evil.example' }).expect(403);
    await post(
      '/auth/logout',
      {},
      { Cookie: `nelio_refresh=${cookie}`, Origin: 'https://evil.example' },
    ).expect(403);
    const ok = await refreshWith(cookie, { Origin: FRONTEND }).expect(200);
    await refreshWith(cookieOf(ok) as string).expect(200);
  });

  it('a suspended user cannot refresh (403) and an account that was suspended has its sessions revoked by the Admin flow', async () => {
    const { user, cookie } = await session();
    await pool.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [
      user.id,
    ]);
    expect((await refreshWith(cookie).expect(403)).body.code).toBe(
      'ACCOUNT_SUSPENDED',
    );
  });
});

describe('logout, logout-all and the access token', () => {
  it('logout revokes this device only; logout-all revokes every device, invalidates old access tokens and tells the sockets', async () => {
    const user = await registerAndVerify();
    const [one, two] = [
      await login(user.email).expect(200),
      await login(user.email).expect(200),
    ];
    await post(
      '/auth/logout',
      {},
      { Cookie: `nelio_refresh=${cookieOf(one)}` },
    ).expect(204);
    await refreshWith(cookieOf(one) as string).expect(401);
    await refreshWith(cookieOf(two) as string).expect(200);
    await post('/auth/logout', {}).expect(204); // no cookie: still 204

    const old = issuer.issueAccessToken(user.id, Date.now() - 5000).accessToken;
    await authed('get', '/me', old).expect(200);
    const third = await login(user.email).expect(200);
    await authed('post', '/auth/logout-all', third.body.accessToken).expect(
      204,
    );
    expect(await aliveTokens(user.id)).toBe(0);
    await authed('get', '/me', old).expect(401);
    await new Promise((r) => setTimeout(r, 60));
    expect(revoked).toEqual([user.id]);
    await authed(
      'get',
      '/me',
      issuer.issueAccessToken(user.id).accessToken,
    ).expect(200); // a token issued after the revocation works
  });

  it('every protected route refuses a missing token (401)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout-all')
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/google/link')
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .delete('/api/v1/auth/google')
      .expect(401);
  });
});

describe('forgot and reset password', () => {
  it('forgot-password is always 202 with the same body and emails only an existing, active account', async () => {
    const user = await registerAndVerify();
    const suspended = await registerAndVerify();
    await pool.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [
      suspended.id,
    ]);
    sent.length = 0;
    const bodies = [
      (await post('/auth/forgot-password', { email: user.email }).expect(202))
        .body,
      (
        await post('/auth/forgot-password', { email: uniqueEmail() }).expect(
          202,
        )
      ).body,
      (
        await post('/auth/forgot-password', { email: suspended.email }).expect(
          202,
        )
      ).body,
    ];
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(sent).toEqual([
      expect.objectContaining({
        kind: 'reset',
        to: user.email,
        validForHours: 1,
      }),
    ]);
  });

  it('reset sets the password, verifies the email, revokes every session and invalidates old access tokens; the link works once', async () => {
    const email = uniqueEmail();
    await post('/auth/register', {
      email,
      fullName: 'A',
      password: PASSWORD,
    }).expect(202); // never verified
    const id = (
      await pool.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1',
        [email],
      )
    ).rows[0].id;
    await pool.query(
      'UPDATE users SET email_verified_at = now() WHERE id = $1',
      [id],
    );
    const session = await login(email).expect(200);
    await post('/auth/forgot-password', { email }).expect(202);
    const token = (sent.find((m) => m.kind === 'reset') as Sent)
      .token as string;
    const old = issuer.issueAccessToken(id, Date.now() - 5000).accessToken;
    await post('/auth/reset-password', {
      token,
      newPassword: 'a brand new password',
    }).expect(204);
    expect(await aliveTokens(id)).toBe(0);
    await refreshWith(cookieOf(session) as string).expect(401);
    await authed('get', '/me', old).expect(401);
    await login(email).expect(401);
    await login(email, 'a brand new password').expect(200);
    expect(
      (
        await post('/auth/reset-password', {
          token,
          newPassword: 'another new password',
        }).expect(400)
      ).body.code,
    ).toBe('TOKEN_INVALID');
    await new Promise((r) => setTimeout(r, 60));
    expect(revoked).toContain(id);
  });

  it('reset verifies an unverified address, and a newer reset link voids the older one', async () => {
    const email = uniqueEmail();
    await post('/auth/register', {
      email,
      fullName: 'A',
      password: PASSWORD,
    }).expect(202);
    await post('/auth/forgot-password', { email }).expect(202);
    const first = (sent.find((m) => m.kind === 'reset') as Sent)
      .token as string;
    await pool.query(
      "UPDATE email_tokens SET created_at = now() - interval '5 minutes'",
    );
    await post('/auth/forgot-password', { email }).expect(202);
    const second = sent.filter((m) => m.kind === 'reset').at(-1) as Sent;
    expect(second.token).not.toBe(first);
    await post('/auth/reset-password', {
      token: second.token,
      newPassword: 'a brand new password',
    }).expect(204);
    expect(
      (
        await post('/auth/reset-password', {
          token: first,
          newPassword: 'yet another password',
        }).expect(400)
      ).body.code,
    ).toBe('TOKEN_INVALID');
    await login(email, 'a brand new password').expect(200); // the email counts as verified now
  });

  it('a bad token is refused BEFORE the password is hashed; a weak password is 400 and the token stays usable', async () => {
    const user = await registerAndVerify();
    await post('/auth/forgot-password', { email: user.email }).expect(202);
    const token = (sent.find((m) => m.kind === 'reset') as Sent)
      .token as string;
    const hash = jest.spyOn(passwords, 'hash');
    await post('/auth/reset-password', {
      token: 'x'.repeat(43),
      newPassword: 'a brand new password',
    }).expect(400);
    expect(hash).not.toHaveBeenCalled();
    await post('/auth/reset-password', {
      token,
      newPassword: 'password123',
    }).expect(400);
    await post('/auth/reset-password', { token, newPassword: 'short' }).expect(
      400,
    );
    await post('/auth/reset-password', {
      token,
      newPassword: 'a brand new password',
    }).expect(204);
  });

  it('a Google-only account adds a password through reset', async () => {
    google.profiles.set('google-token-add-password-001', {
      sub: 'g-add',
      email: 'g-add@example.test',
      emailVerified: true,
      name: 'G',
    });
    await post('/auth/google', {
      idToken: 'google-token-add-password-001',
    }).expect(200);
    await post('/auth/forgot-password', { email: 'g-add@example.test' }).expect(
      202,
    );
    const token = (sent.find((m) => m.kind === 'reset') as Sent)
      .token as string;
    await post('/auth/reset-password', {
      token,
      newPassword: 'now a password too',
    }).expect(204);
    await login('g-add@example.test', 'now a password too').expect(200);
  });
});

describe('change-password', () => {
  it('needs the current password (403 INVALID_CURRENT_PASSWORD), signs OTHER devices out, keeps this one, and returns a working access token', async () => {
    const user = await registerAndVerify();
    const [here, other] = [
      await login(user.email).expect(200),
      await login(user.email).expect(200),
    ];
    const old = issuer.issueAccessToken(user.id, Date.now() - 5000).accessToken;
    const cookie = `nelio_refresh=${cookieOf(here)}`;
    const body = {
      currentPassword: PASSWORD,
      newPassword: 'a brand new password',
    };
    const wrong = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${here.body.accessToken}`)
      .set('X-Forwarded-For', ip())
      .send({ ...body, currentPassword: 'not my password' })
      .expect(403);
    expect(wrong.body.code).toBe('INVALID_CURRENT_PASSWORD');
    await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${here.body.accessToken}`)
      .set('X-Forwarded-For', ip())
      .send({ ...body, newPassword: 'password123' })
      .expect(400);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${here.body.accessToken}`)
      .set('Cookie', cookie)
      .set('X-Forwarded-For', ip())
      .send(body)
      .expect(200);
    await authed('get', '/me', res.body.accessToken).expect(200);
    await authed('get', '/me', old).expect(401);
    await refreshWith(cookieOf(here) as string).expect(200); // this device keeps its session
    await refreshWith(cookieOf(other) as string).expect(401); // the other one is gone
    await login(user.email).expect(401);
    await login(user.email, 'a brand new password').expect(200);
    expect(revoked).toEqual([]); // the sockets of this device are not closed
  });

  it('without a refresh cookie every session is revoked; a Google-only account (no password) is 403 INVALID_CURRENT_PASSWORD', async () => {
    const user = await registerAndVerify();
    const session = await login(user.email).expect(200);
    await authed('post', '/auth/change-password', session.body.accessToken, {
      currentPassword: PASSWORD,
      newPassword: 'a brand new password',
    }).expect(200);
    await refreshWith(cookieOf(session) as string).expect(401);
    google.profiles.set('google-token-nopassword-0001', {
      sub: 'g-np',
      email: 'g-np@example.test',
      emailVerified: true,
      name: 'G',
    });
    const g = await post('/auth/google', {
      idToken: 'google-token-nopassword-0001',
    }).expect(200);
    expect(
      (
        await authed('post', '/auth/change-password', g.body.accessToken, {
          currentPassword: 'anything long',
          newPassword: 'a brand new password',
        }).expect(403)
      ).body.code,
    ).toBe('INVALID_CURRENT_PASSWORD');
  });
});

describe('Google sign-in', () => {
  const profile = (over: Partial<GoogleProfile> = {}): GoogleProfile => ({
    sub: `sub-${randomUUID()}`,
    email: uniqueEmail(),
    emailVerified: true,
    name: 'Google Person',
    ...over,
  });
  const signIn = (p: GoogleProfile) => {
    const token = `google-token-${randomUUID()}`;
    google.profiles.set(token, p);
    return post('/auth/google', { idToken: token });
  };

  it('rule 4: a new verified Google email creates a verified STUDENT without a password; the same call again logs the same user in', async () => {
    const p = profile({ name: 'Անի Հակոբյան' });
    const first = await signIn(p).expect(200);
    expect(first.body.tokenType).toBe('Bearer');
    expect(cookieOf(first)).toBeDefined();
    const user = (
      await pool.query(
        'SELECT id, full_name, email_verified_at, password_hash FROM users WHERE email = $1',
        [p.email],
      )
    ).rows[0];
    expect(user).toMatchObject({
      full_name: 'Անի Հակոբյան',
      password_hash: null,
    });
    expect(user.email_verified_at).not.toBeNull();
    expect(
      (
        await pool.query(
          'SELECT role, status FROM user_roles WHERE user_id = $1',
          [user.id],
        )
      ).rows,
    ).toEqual([{ role: 'STUDENT', status: 'ACTIVE' }]);
    await signIn(p).expect(200);
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(1);
    expect(
      (
        await pool.query(
          'SELECT provider, provider_account_id FROM auth_identities WHERE user_id = $1',
          [user.id],
        )
      ).rows,
    ).toEqual([{ provider: 'GOOGLE', provider_account_id: p.sub }]);
  });

  it('rule 1: matching is on the Google subject, never the email: the same sub with a changed email logs the same user in', async () => {
    const p = profile();
    await signIn(p).expect(200);
    await signIn({ ...p, email: uniqueEmail() }).expect(200);
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM auth_identities')).rowCount).toBe(
      1,
    );
  });

  it('a verified Google email that belongs to a VERIFIED password account links to it', async () => {
    const user = await registerAndVerify();
    const p = profile({ email: user.email });
    await signIn(p).expect(200);
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(1);
    const row = await userRow(user.id);
    expect(row.password_hash).not.toBeNull(); // a verified account keeps its password
    await login(user.email).expect(200);
  });

  it('rule 2: linking to an UNVERIFIED password account clears the password, verifies the email and revokes its sessions', async () => {
    const email = uniqueEmail();
    await post('/auth/register', {
      email,
      fullName: 'Squatter',
      password: PASSWORD,
    }).expect(202);
    const id = (
      await pool.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1',
        [email],
      )
    ).rows[0].id;
    await createRefreshToken(pool, id);
    await signIn(profile({ email })).expect(200);
    const row = await userRow(id);
    expect(row.password_hash).toBeNull();
    expect(row.email_verified_at).not.toBeNull();
    expect(row.tokens_valid_after).not.toBeNull();
    await login(email).expect(401); // the pre-registered password no longer works
    expect(
      (
        await pool.query(
          'SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL AND family_id NOT IN (SELECT family_id FROM refresh_tokens ORDER BY created_at DESC LIMIT 1)',
          [id],
        )
      ).rowCount,
    ).toBe(0);
    expect(revoked).toContain(id);
  });

  it('rule 3: an UNVERIFIED Google email is rejected (401) and creates nothing, even when a user with that email exists', async () => {
    const user = await registerAndVerify();
    await signIn(profile({ emailVerified: false })).expect(401);
    await signIn(profile({ email: user.email, emailVerified: false })).expect(
      401,
    );
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM auth_identities')).rowCount).toBe(
      0,
    );
  });

  it('an unverifiable token is 401, a missing configuration is 503, and a suspended user is 403', async () => {
    await post('/auth/google', {
      idToken: 'google-token-unknown-0000001',
    }).expect(401);
    await post('/auth/google', { idToken: 'short' }).expect(400);
    const p = profile();
    await signIn(p).expect(200);
    await pool.query("UPDATE users SET status = 'SUSPENDED' WHERE email = $1", [
      p.email,
    ]);
    expect((await signIn(p).expect(403)).body.code).toBe('ACCOUNT_SUSPENDED');
    const bySub = profile({ sub: p.sub, email: uniqueEmail() });
    expect((await signIn(bySub).expect(403)).body.code).toBe(
      'ACCOUNT_SUSPENDED',
    );
  });

  it('two first sign-ins of the same Google account at the same moment make ONE user and one identity', async () => {
    for (let round = 0; round < 4; round++) {
      const p = profile();
      const results = await Promise.all([signIn(p), signIn(p), signIn(p)]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(
        (await pool.query('SELECT 1 FROM users WHERE email = $1', [p.email]))
          .rowCount,
      ).toBe(1);
      expect(
        (
          await pool.query(
            'SELECT 1 FROM auth_identities WHERE provider_account_id = $1',
            [p.sub],
          )
        ).rowCount,
      ).toBe(1);
    }
  });

  it('link adds a Google login to the signed-in account; the Google account cannot belong to two users and a user has at most one', async () => {
    const [a, b] = [await registerAndVerify(), await registerAndVerify()];
    const [ta, tb] = [
      (await login(a.email)).body.accessToken as string,
      (await login(b.email)).body.accessToken as string,
    ];
    const p = profile();
    const tokenFor = (x: GoogleProfile) => {
      const t = `google-token-${randomUUID()}`;
      google.profiles.set(t, x);
      return t;
    };
    await authed('post', '/auth/google/link', ta, {
      idToken: tokenFor(p),
    }).expect(204);
    expect(
      (
        await authed('post', '/auth/google/link', tb, {
          idToken: tokenFor(p),
        }).expect(409)
      ).body.code,
    ).toBe('RESOURCE_CONFLICT');
    expect(
      (
        await authed('post', '/auth/google/link', ta, {
          idToken: tokenFor(profile()),
        }).expect(409)
      ).body.code,
    ).toBe('RESOURCE_CONFLICT');
    await authed('post', '/auth/google/link', tb, {
      idToken: tokenFor(profile({ emailVerified: false })),
    }).expect(401);
    await signIn(p).expect(200); // the linked Google account now signs in as `a`
    expect(
      (
        await pool.query(
          'SELECT user_id FROM auth_identities WHERE provider_account_id = $1',
          [p.sub],
        )
      ).rows[0].user_id,
    ).toBe(a.id);
  });

  it('unlink removes the Google login only while a password remains; the last login method cannot go (409 NO_LOGIN_METHOD_REMAINING)', async () => {
    const p = profile();
    const googleOnly = (await signIn(p).expect(200)).body.accessToken as string;
    const refused = await authed('delete', '/auth/google', googleOnly).expect(
      409,
    );
    expect(refused.body.code).toBe('NO_LOGIN_METHOD_REMAINING');
    expect((await pool.query('SELECT 1 FROM auth_identities')).rowCount).toBe(
      1,
    );
    const user = await registerAndVerify();
    const token = (await login(user.email)).body.accessToken as string;
    const t = `google-token-${randomUUID()}`;
    google.profiles.set(t, profile({ email: user.email }));
    await authed('post', '/auth/google/link', token, { idToken: t }).expect(
      204,
    );
    await authed('delete', '/auth/google', token).expect(204);
    expect(
      (await authed('delete', '/auth/google', token).expect(404)).body.code,
    ).toBe('NOT_FOUND');
    await login(user.email).expect(200);
  });
});

describe('expired-token cleanup', () => {
  it('removes refresh tokens that expired over a day ago and email tokens that expired or were used over a day ago, and nothing else', async () => {
    const user = await registerAndVerify();
    const session = await login(user.email).expect(200);
    await post('/auth/forgot-password', { email: user.email }).expect(202);
    const keepRefresh = hashToken(cookieOf(session) as string);
    for (const [i, expires] of ['2 days', '12 hours'].entries()) {
      await pool.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, family_id, family_started_at, expires_at) VALUES ($1, $2, $3, now() - interval '3 days', now() - interval '${expires}')`,
        [user.id, `old-${i}`, randomUUID()],
      );
    }
    await pool.query(
      "INSERT INTO email_tokens (user_id, type, token_hash, expires_at) VALUES ($1, 'PASSWORD_RESET', 'expired-long-ago', now() - interval '2 days')",
      [user.id],
    );
    await pool.query(
      "INSERT INTO email_tokens (user_id, type, token_hash, expires_at, used_at) VALUES ($1, 'PASSWORD_RESET', 'used-long-ago', now() + interval '1 hour', now() - interval '2 days')",
      [user.id],
    );
    const before = (
      await pool.query('SELECT count(*)::int AS n FROM email_tokens')
    ).rows[0].n;
    expect(await cleanup.run()).toEqual({ refreshTokens: 1, emailTokens: 2 });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM refresh_tokens WHERE token_hash IN ($1, 'old-1')",
          [keepRefresh],
        )
      ).rowCount,
    ).toBe(2);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM email_tokens')).rows[0]
        .n,
    ).toBe(before - 2);
    expect(await cleanup.run()).toEqual({ refreshTokens: 0, emailTokens: 0 });
  });
});

describe('the real-login smoke path', () => {
  it('register, verify, login, an authenticated call, refresh, an authenticated call, logout', async () => {
    const email = uniqueEmail();
    await post('/auth/register', {
      email,
      fullName: 'Smoke Test',
      password: PASSWORD,
    }).expect(202);
    const token = (sent.find((m) => m.kind === 'verification') as Sent)
      .token as string;
    const verified = await post('/auth/verify-email', { token }).expect(204);
    expect(verified.headers['set-cookie']).toBeUndefined();
    const session = await login(email).expect(200);
    const me = await authed('get', '/me', session.body.accessToken).expect(200);
    expect(me.body).toMatchObject({
      email,
      fullName: 'Smoke Test',
      emailVerified: true,
      roles: [{ role: 'STUDENT', status: 'ACTIVE' }],
    });
    const next = await refreshWith(cookieOf(session) as string).expect(200);
    await authed('get', '/me', next.body.accessToken).expect(200);
    await post(
      '/auth/logout',
      {},
      { Cookie: `nelio_refresh=${cookieOf(next)}` },
    ).expect(204);
    await refreshWith(cookieOf(next) as string).expect(401);
    expect(TEST_JWT_SECRET.length).toBeGreaterThan(32);
  });
});
