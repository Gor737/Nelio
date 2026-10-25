// Test-only access-token minter. It signs with the REAL algorithm and claims of production access tokens, so HTTP tests in
// later milestones can authenticate without going through register/login:
//   - JWT, HS256 pinned (Architecture section 11); the secret is JWT_SECRET (>= 32 bytes), as the config module will
//     require; when it is not set a fixed test secret of the same strength is used,
//   - the token carries only the user id as `sub` (Decision 108), plus `iat` and `exp`,
//   - lifetime 15 minutes (TIME_LIMITS.ACCESS_TOKEN_TTL_MS).
// It uses node:crypto only, so it does not depend on the JWT library that the Auth module will choose. It must never be
// imported from src/ (the dependency-cruiser rule src-must-not-import-tests enforces that).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TIME_LIMITS } from '../../src/common/constants/limits.js';

export const ACCESS_TOKEN_ALGORITHM = 'HS256';
const FALLBACK_TEST_SECRET =
  'nelio-test-only-secret-0123456789-abcdef-0123456789';

export interface AccessTokenClaims {
  sub: string;
  iat: number;
  exp: number;
}

export function testJwtSecret(): string {
  const secret = process.env.JWT_SECRET ?? FALLBACK_TEST_SECRET;
  if (Buffer.byteLength(secret) < 32)
    throw new Error('JWT_SECRET must be at least 32 bytes');
  return secret;
}

const base64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64url');
const sign = (data: string, secret: string) =>
  createHmac('sha256', secret).update(data).digest();

export function mintAccessToken(
  userId: string,
  options: { ttlSeconds?: number; nowSeconds?: number; secret?: string } = {},
): string {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    sub: userId,
    iat: now,
    exp: now + (options.ttlSeconds ?? TIME_LIMITS.ACCESS_TOKEN_TTL_MS / 1000),
  };
  const header = base64url(
    JSON.stringify({ alg: ACCESS_TOKEN_ALGORITHM, typ: 'JWT' }),
  );
  const payload = base64url(JSON.stringify(claims));
  const signature = base64url(
    sign(`${header}.${payload}`, options.secret ?? testJwtSecret()),
  );
  return `${header}.${payload}.${signature}`;
}

/** Verifies signature (constant time), pinned algorithm and expiry; used to test the minter and, later, the guard against it. */
export function verifyAccessToken(
  token: string,
  options: { nowSeconds?: number; secret?: string } = {},
): AccessTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [header, payload, signature] = parts;
  const parsedHeader = JSON.parse(
    Buffer.from(header, 'base64url').toString(),
  ) as { alg?: string };
  if (parsedHeader.alg !== ACCESS_TOKEN_ALGORITHM)
    throw new Error(`unexpected algorithm ${String(parsedHeader.alg)}`);
  const expected = sign(
    `${header}.${payload}`,
    options.secret ?? testJwtSecret(),
  );
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('bad signature');
  const claims = JSON.parse(
    Buffer.from(payload, 'base64url').toString(),
  ) as AccessTokenClaims;
  if (claims.exp <= (options.nowSeconds ?? Math.floor(Date.now() / 1000)))
    throw new Error('token expired');
  return claims;
}
