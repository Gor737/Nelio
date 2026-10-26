import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TIME_LIMITS } from '../../../common/constants/limits.js';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../infrastructure/config/index.js';

export interface IssuedAccessToken {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  /** Lifetime in seconds. */
  readonly expiresIn: number;
}

const encode = (value: object): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/**
 * Signs access tokens: JWT, HS256, claims `sub`, `iat`, `exp` ONLY (Decisions 108, 144, 152). `common`'s `TokenVerifier` is the counterpart
 * that every request goes through; both read the secret from the validated configuration. `iat` is in whole seconds, which is what the
 * `tokens_valid_after` comparison uses.
 */
@Injectable()
export class TokenIssuer {
  private readonly secret: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.secret = Buffer.from(config.jwtSecret, 'utf8');
  }

  issueAccessToken(
    userId: string,
    nowMs: number = Date.now(),
  ): IssuedAccessToken {
    const iat = Math.floor(nowMs / 1000);
    const lifetimeSeconds = TIME_LIMITS.ACCESS_TOKEN_TTL_MS / 1000;
    const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
      sub: userId,
      iat,
      exp: iat + lifetimeSeconds,
    })}`;
    const signature = createHmac('sha256', this.secret)
      .update(signingInput)
      .digest('base64url');
    return {
      accessToken: `${signingInput}.${signature}`,
      tokenType: 'Bearer',
      expiresIn: lifetimeSeconds,
    };
  }
}
