// The test-only token minter must behave like production access tokens (HS256, subject only, 15 minutes), because the HTTP
// tests of later milestones authenticate with it.
import { createHmac } from 'node:crypto';
import { TIME_LIMITS } from '../../src/common/constants/limits.js';
import {
  ACCESS_TOKEN_ALGORITHM,
  mintAccessToken,
  testJwtSecret,
  verifyAccessToken,
} from './token-minter.js';

const USER_ID = '01a16d4d-1c05-7426-80a4-0235db94f5f2';
const decode = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<
    string,
    unknown
  >;

describe('test-only access-token minter', () => {
  it('produces a three-part JWT with the pinned HS256 header', () => {
    const [header] = mintAccessToken(USER_ID).split('.');
    expect(decode(header)).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(ACCESS_TOKEN_ALGORITHM).toBe('HS256');
  });

  it('carries only the user id as subject (Decision 108) plus iat and exp, valid for 15 minutes', () => {
    const token = mintAccessToken(USER_ID, { nowSeconds: 1_800_000_000 });
    const claims = decode(token.split('.')[1]);
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'sub']);
    expect(claims).toEqual({
      sub: USER_ID,
      iat: 1_800_000_000,
      exp: 1_800_000_000 + TIME_LIMITS.ACCESS_TOKEN_TTL_MS / 1000,
    });
    expect(TIME_LIMITS.ACCESS_TOKEN_TTL_MS / 1000).toBe(900);
  });

  it('is signed with the secret: the signature matches an independent HMAC-SHA256 and verifies', () => {
    const token = mintAccessToken(USER_ID);
    const [header, payload, signature] = token.split('.');
    const expected = createHmac('sha256', testJwtSecret())
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
    expect(verifyAccessToken(token).sub).toBe(USER_ID);
  });

  it('rejects a token with another secret, a tampered payload, the "none" algorithm, and an expired token', () => {
    const token = mintAccessToken(USER_ID);
    expect(() =>
      verifyAccessToken(
        mintAccessToken(USER_ID, {
          secret: 'another-secret-that-is-at-least-32-bytes-long',
        }),
      ),
    ).toThrow('bad signature');

    const [header, , signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        sub: '00000000-0000-7000-8000-000000000000',
        iat: 1,
        exp: 9_999_999_999,
      }),
    ).toString('base64url');
    expect(() => verifyAccessToken(`${header}.${forged}.${signature}`)).toThrow(
      'bad signature',
    );

    const none = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    expect(() => verifyAccessToken(`${none}.${token.split('.')[1]}.`)).toThrow(
      'unexpected algorithm none',
    );

    const old = mintAccessToken(USER_ID, { nowSeconds: 1_000_000_000 });
    expect(() =>
      verifyAccessToken(old, { nowSeconds: 1_000_000_000 + 901 }),
    ).toThrow('token expired');
    expect(
      verifyAccessToken(old, { nowSeconds: 1_000_000_000 + 899 }).sub,
    ).toBe(USER_ID);
  });

  it('refuses a secret shorter than 32 bytes', () => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'too-short';
    try {
      expect(() => testJwtSecret()).toThrow('at least 32 bytes');
    } finally {
      if (previous === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previous;
    }
  });
});
