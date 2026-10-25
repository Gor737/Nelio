import { Injectable } from '@nestjs/common';
import { ApiException } from '../filters/api-exception.js';
import { AuthUserLoader } from './auth-user-loader.js';
import type { AuthenticatedUser } from './authenticated-user.js';
import { TokenVerifier } from './token-verifier.js';

export interface AuthenticatedSession {
  readonly user: AuthenticatedUser;
  /** The access token's issued-at, whole seconds. */
  readonly issuedAt: number;
}

/**
 * The authentication algorithm of Decision 152, in one place so that the HTTP guard and the Socket.IO handshake cannot drift:
 *   1. verify the JWT (signature, pinned HS256, exp)            -> else 401 UNAUTHENTICATED
 *   2. load the user and the ACTIVE roles in one query           -> 401 if the user is missing
 *   3. SUSPENDED                                                  -> 403 ACCOUNT_SUSPENDED
 *   4. `iat` (whole seconds) earlier than `tokens_valid_after`    -> 401 (a token issued in the same second is accepted)
 *   5. attach { id, activeRoles }
 */
@Injectable()
export class Authenticator {
  constructor(
    private readonly verifier: TokenVerifier,
    private readonly loader: AuthUserLoader,
  ) {}

  async authenticate(
    token: string,
    nowSeconds?: number,
  ): Promise<AuthenticatedUser> {
    return (await this.authenticateToken(token, nowSeconds)).user;
  }

  /** Like `authenticate`, and also returns the token's `iat`, which a long-lived Socket.IO connection keeps for `recheck`. */
  async authenticateToken(
    token: string,
    nowSeconds?: number,
  ): Promise<AuthenticatedSession> {
    const claims = this.verifier.verify(token, nowSeconds);
    return {
      user: await this.checkUser(claims.userId, claims.issuedAt),
      issuedAt: claims.issuedAt,
    };
  }

  /**
   * Steps 2-5 again for a connection that already authenticated (a Socket.IO event, architecture section 14, lifecycle rule 2):
   * the user must still exist, not be suspended, and the token it connected with must not have been revoked since. The token's
   * expiry is NOT checked: a connection outlives its 15-minute access token, and the client refreshes before reconnecting.
   */
  recheck(userId: string, issuedAt: number): Promise<AuthenticatedUser> {
    return this.checkUser(userId, issuedAt);
  }

  private async checkUser(
    userId: string,
    issuedAt: number,
  ): Promise<AuthenticatedUser> {
    const user = await this.loader.load(userId);
    if (!user) throw new ApiException('UNAUTHENTICATED');
    if (user.status === 'SUSPENDED')
      throw new ApiException('ACCOUNT_SUSPENDED');
    if (
      user.tokensValidAfter &&
      issuedAt < Math.floor(user.tokensValidAfter.getTime() / 1000)
    ) {
      throw new ApiException('UNAUTHENTICATED');
    }
    return { id: user.id, activeRoles: user.activeRoles };
  }

  /** `Authorization: Bearer <token>` -> the token, or undefined when the header is absent. Any other shape is a 401. */
  static bearerToken(header: string | undefined): string | undefined {
    if (header === undefined) return undefined;
    const match = /^Bearer ([^\s]+)$/.exec(header);
    if (!match) throw new ApiException('UNAUTHENTICATED');
    return match[1];
  }
}
