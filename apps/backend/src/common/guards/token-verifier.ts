import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../infrastructure/config/index.js';
import { ApiException } from '../filters/api-exception.js';

/** The only algorithm accepted (docs/architecture.md section 11: "HS256, algorithm pinned"). */
export const ACCESS_TOKEN_ALGORITHM = 'HS256';

export interface VerifiedAccessToken {
  /** The user id (the only identity claim: Decision 108). */
  readonly userId: string;
  /** Issued-at, whole seconds since the epoch. */
  readonly issuedAt: number;
  /** Expiry, whole seconds since the epoch. */
  readonly expiresAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const unauthenticated = () => new ApiException('UNAUTHENTICATED');

function decodeJsonObject(part: string): Record<string, unknown> {
  if (!BASE64URL.test(part)) throw unauthenticated();
  try {
    const value: unknown = JSON.parse(
      Buffer.from(part, 'base64url').toString('utf8'),
    );
    if (typeof value === 'object' && value !== null && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // falls through to the rejection below
  }
  throw unauthenticated();
}

/**
 * Verifies access tokens (JWT, HS256). It lives in `common` and reads the secret from the validated configuration; Auth owns the
 * `TokenIssuer` that signs them (docs/architecture.md section 11). It uses `node:crypto` only.
 *
 * What it rejects, always with 401 `UNAUTHENTICATED` and never with a reason the caller could use:
 *   - anything that is not three base64url parts;
 *   - any header whose `alg` is not exactly `HS256` (so `none`, `HS384`, `RS256` and a missing `alg` fail before the signature
 *     is looked at), or whose `typ` is present and not `JWT`;
 *   - a signature that differs (constant-time comparison) or is not canonical base64url;
 *   - missing or mistyped `sub` (UUID), `iat` or `exp` (integers), and an `exp` that is not in the future.
 */
@Injectable()
export class TokenVerifier {
  private readonly secret: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.secret = Buffer.from(config.jwtSecret, 'utf8');
  }

  verify(
    token: string,
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): VerifiedAccessToken {
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096)
      throw unauthenticated();
    const parts = token.split('.');
    if (parts.length !== 3) throw unauthenticated();
    const [headerPart, payloadPart, signaturePart] = parts;

    const header = decodeJsonObject(headerPart);
    if (header.alg !== ACCESS_TOKEN_ALGORITHM) throw unauthenticated();
    if (header.typ !== undefined && header.typ !== 'JWT')
      throw unauthenticated();

    if (!BASE64URL.test(signaturePart)) throw unauthenticated();
    const actual = Buffer.from(signaturePart, 'base64url');
    if (actual.toString('base64url') !== signaturePart) throw unauthenticated(); // non-canonical encoding
    const expected = createHmac('sha256', this.secret)
      .update(`${headerPart}.${payloadPart}`)
      .digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw unauthenticated();

    const claims = decodeJsonObject(payloadPart);
    const { sub, iat, exp } = claims;
    if (typeof sub !== 'string' || !UUID.test(sub)) throw unauthenticated();
    if (!Number.isInteger(iat) || !Number.isInteger(exp))
      throw unauthenticated();
    if ((exp as number) <= nowSeconds) throw unauthenticated();
    return {
      userId: sub.toLowerCase(),
      issuedAt: iat as number,
      expiresAt: exp as number,
    };
  }
}
