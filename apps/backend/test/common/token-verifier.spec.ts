// Unit tests for TokenVerifier and Authenticator (Decision 152): every way a token can be wrong, with a fixed clock.
import { createHmac, randomUUID } from 'node:crypto';
import { ApiException } from '../../src/common/filters/index.js';
import { Authenticator } from '../../src/common/guards/authenticator.js';
import { TokenVerifier } from '../../src/common/guards/token-verifier.js';
import type { AppConfig } from '../../src/infrastructure/config/index.js';
import { FakeAuthUserLoader } from '../support/fake-auth.js';
import { mintAccessToken } from '../support/token-minter.js';

const SECRET = 'unit-test-secret-with-more-than-thirty-two-bytes-in-it';
const NOW = 1_800_000_000;
const verifier = new TokenVerifier({ jwtSecret: SECRET } as AppConfig);
const userId = randomUUID();

const b64 = (value: unknown) =>
  Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).toString('base64url');
const sign = (data: string, secret = SECRET, algorithm = 'sha256') =>
  createHmac(algorithm, secret).update(data).digest('base64url');
/** A token built by hand, so any header, claims or signature can be tried. */
function forge(
  header: unknown,
  claims: unknown,
  options: { secret?: string; signature?: string; algorithm?: string } = {},
) {
  const head = b64(header);
  const body = b64(claims);
  return `${head}.${body}.${options.signature ?? sign(`${head}.${body}`, options.secret, options.algorithm)}`;
}
const goodClaims = { sub: userId, iat: NOW - 10, exp: NOW + 890 };
const good = () => forge({ alg: 'HS256', typ: 'JWT' }, goodClaims);

/** Asserts a 401 UNAUTHENTICATED ApiException and nothing else (the response never says why). */
function expectRejected(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    expect(error).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    return;
  }
  throw new Error('expected the token to be rejected');
}

describe('TokenVerifier', () => {
  it('accepts a valid token and returns the user id and the times', () => {
    expect(verifier.verify(good(), NOW)).toEqual({
      userId,
      issuedAt: NOW - 10,
      expiresAt: NOW + 890,
    });
  });

  it('accepts a token made by the production-shaped test minter (same algorithm and claims)', () => {
    const token = mintAccessToken(userId, { secret: SECRET, nowSeconds: NOW });
    expect(verifier.verify(token, NOW + 1).userId).toBe(userId);
  });

  it('rejects an expired token, including one that expires exactly now', () => {
    expectRejected(() => verifier.verify(good(), NOW + 890));
    expectRejected(() => verifier.verify(good(), NOW + 5000));
    expect(verifier.verify(good(), NOW + 889).userId).toBe(userId);
  });

  describe('algorithm is pinned to HS256', () => {
    it.each([
      [
        'none, with an empty signature',
        forge({ alg: 'none', typ: 'JWT' }, goodClaims, { signature: '' }),
      ],
      [
        'none, with the valid HS256 signature attached',
        forge({ alg: 'none' }, goodClaims),
      ],
      ['None (case variant)', forge({ alg: 'None' }, goodClaims)],
      [
        'HS384 signed with the right secret',
        forge({ alg: 'HS384' }, goodClaims, { algorithm: 'sha384' }),
      ],
      [
        'HS512 signed with the right secret',
        forge({ alg: 'HS512' }, goodClaims, { algorithm: 'sha512' }),
      ],
      [
        'RS256 header with an HMAC signature',
        forge({ alg: 'RS256' }, goodClaims),
      ],
      ['a missing alg', forge({ typ: 'JWT' }, goodClaims)],
      ['alg as an array', forge({ alg: ['HS256'] }, goodClaims)],
      ['a different typ', forge({ alg: 'HS256', typ: 'JWE' }, goodClaims)],
    ])('rejects %s', (_label, token) => {
      expectRejected(() => verifier.verify(token, NOW));
    });
  });

  describe('signature', () => {
    it('rejects a token signed with another secret', () => {
      expectRejected(() =>
        verifier.verify(
          forge({ alg: 'HS256' }, goodClaims, {
            secret: 'another-secret-another-secret-another-secret',
          }),
          NOW,
        ),
      );
    });

    it('rejects a tampered payload (a different sub with the old signature)', () => {
      const [head, , signature] = good().split('.');
      const tampered = `${head}.${b64({ ...goodClaims, sub: randomUUID() })}.${signature}`;
      expectRejected(() => verifier.verify(tampered, NOW));
    });

    it('rejects a tampered expiry', () => {
      const [head, , signature] = good().split('.');
      expectRejected(() =>
        verifier.verify(
          `${head}.${b64({ ...goodClaims, exp: NOW + 10_000_000 })}.${signature}`,
          NOW,
        ),
      );
    });

    it('rejects a truncated, empty, or non-canonical signature', () => {
      const token = good();
      expectRejected(() => verifier.verify(token.slice(0, -4), NOW));
      expectRejected(() =>
        verifier.verify(`${token.split('.').slice(0, 2).join('.')}.`, NOW),
      );
      // the same signature bytes with a different (non-canonical) base64url spelling of the last character
      const [head, payload, signature] = token.split('.');
      const last = signature.slice(-1);
      const alt = last === 'A' ? 'B' : 'A';
      expectRejected(() =>
        verifier.verify(
          `${head}.${payload}.${signature.slice(0, -1)}${alt}`,
          NOW,
        ),
      );
    });
  });

  describe('claims', () => {
    it.each([
      ['no sub', { iat: NOW - 10, exp: NOW + 890 }],
      ['a non-UUID sub', { ...goodClaims, sub: 'admin' }],
      ['a numeric sub', { ...goodClaims, sub: 12345 }],
      ['no exp', { sub: userId, iat: NOW - 10 }],
      ['a string exp', { ...goodClaims, exp: String(NOW + 890) }],
      ['a fractional exp', { ...goodClaims, exp: NOW + 890.5 }],
      ['no iat', { sub: userId, exp: NOW + 890 }],
      ['a string iat', { ...goodClaims, iat: String(NOW) }],
      ['a null exp', { ...goodClaims, exp: null }],
    ])('rejects %s', (_label, claims) => {
      expectRejected(() =>
        verifier.verify(forge({ alg: 'HS256', typ: 'JWT' }, claims), NOW),
      );
    });

    it('rejects a payload that is not a JSON object', () => {
      expectRejected(() =>
        verifier.verify(forge({ alg: 'HS256' }, [1, 2, 3]), NOW),
      );
      expectRejected(() =>
        verifier.verify(forge({ alg: 'HS256' }, 'text'), NOW),
      );
      expectRejected(() =>
        verifier.verify(forge({ alg: 'HS256' }, 'null'), NOW),
      );
    });
  });

  describe('malformed input', () => {
    it.each([
      ['empty', ''],
      ['one part', 'abc'],
      ['two parts', 'abc.def'],
      ['four parts', 'a.b.c.d'],
      ['not base64url', 'a b.c d.e f'],
      ['header that is not JSON', `${b64('not json')}.${b64(goodClaims)}.sig`],
      ['an oversized token', `${'a'.repeat(5000)}.b.c`],
    ])('rejects %s', (_label, token) => {
      expectRejected(() => verifier.verify(token, NOW));
    });

    it('rejects values that are not strings', () => {
      expectRejected(() => verifier.verify(undefined as never, NOW));
      expectRejected(() => verifier.verify(null as never, NOW));
      expectRejected(() => verifier.verify({} as never, NOW));
    });
  });
});

describe('Authenticator (Decision 152, steps 2-5)', () => {
  const loader = new FakeAuthUserLoader();
  const authenticator = new Authenticator(verifier, loader);
  const tokenFor = (id: string, iat = NOW - 10) =>
    forge({ alg: 'HS256', typ: 'JWT' }, { sub: id, iat, exp: NOW + 890 });
  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return (error as ApiException).code;
    }
    return 'OK';
  };

  it('returns the id and only the ACTIVE roles the loader gives', async () => {
    const user = loader.add({ roles: ['STUDENT', 'TEACHER'] });
    await expect(
      authenticator.authenticate(tokenFor(user.id), NOW),
    ).resolves.toEqual({
      id: user.id,
      activeRoles: ['STUDENT', 'TEACHER'],
    });
  });

  it('an unknown user is UNAUTHENTICATED', async () => {
    expect(
      await codeOf(authenticator.authenticate(tokenFor(randomUUID()), NOW)),
    ).toBe('UNAUTHENTICATED');
  });

  it('a suspended user is ACCOUNT_SUSPENDED (403), checked before tokens_valid_after', async () => {
    const user = loader.add({
      status: 'SUSPENDED',
      tokensValidAfter: new Date((NOW + 100) * 1000),
    });
    expect(
      await codeOf(authenticator.authenticate(tokenFor(user.id), NOW)),
    ).toBe('ACCOUNT_SUSPENDED');
  });

  it('iat before tokens_valid_after is UNAUTHENTICATED; the same whole second is accepted (sub-second part ignored)', async () => {
    const validAfterMs = (NOW - 5) * 1000 + 750; // 0.75 s into the second NOW-5
    const user = loader.add({ tokensValidAfter: new Date(validAfterMs) });
    expect(
      await codeOf(authenticator.authenticate(tokenFor(user.id, NOW - 6), NOW)),
    ).toBe('UNAUTHENTICATED');
    expect(
      await codeOf(authenticator.authenticate(tokenFor(user.id, NOW - 5), NOW)),
    ).toBe('OK'); // equal second
    expect(
      await codeOf(authenticator.authenticate(tokenFor(user.id, NOW - 4), NOW)),
    ).toBe('OK');
  });

  it('a user with tokens_valid_after = null accepts any iat', async () => {
    const user = loader.add({ tokensValidAfter: null });
    expect(
      await codeOf(authenticator.authenticate(tokenFor(user.id, 1), NOW)),
    ).toBe('OK');
  });

  it('does not load the user when the token itself is invalid', async () => {
    const before = loader.loads;
    await codeOf(authenticator.authenticate('garbage', NOW));
    expect(loader.loads).toBe(before);
  });

  describe('Authorization header parsing', () => {
    it('returns the token of a Bearer header, undefined when absent, and rejects any other shape', () => {
      expect(Authenticator.bearerToken('Bearer abc.def.ghi')).toBe(
        'abc.def.ghi',
      );
      expect(Authenticator.bearerToken(undefined)).toBeUndefined();
      for (const header of [
        'Basic abc',
        'bearer abc',
        'Bearer',
        'Bearer ',
        'Bearer a b',
        'abc',
        '',
      ])
        expect(() => Authenticator.bearerToken(header)).toThrow(ApiException);
    });
  });
});
