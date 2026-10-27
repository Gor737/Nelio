import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IS_PUBLIC_KEY,
  OPTIONAL_AUTH_KEY,
} from '../decorators/auth.decorators.js';
import { ApiException } from '../filters/api-exception.js';
import { Authenticator } from './authenticator.js';
import type { AuthenticatedRequest } from './authenticated-user.js';

/**
 * The global authentication guard, secure by default (Decision 107): every route requires a valid access token unless it is marked
 * `@Public()` (no authentication at all) or `@OptionalAuth()` (no token = anonymous; a token that is present must be valid).
 * It runs AFTER the rate limiter (docs/architecture.md section 12: 429 -> 401 -> 403 ACCOUNT_SUSPENDED -> other guards), so a flood
 * of requests with bad tokens is answered 429 before any token is verified or any user is loaded.
 *
 * Socket.IO connections are authenticated by the handshake in `infrastructure/realtime`, which uses the same `Authenticator`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: Authenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(
        IS_PUBLIC_KEY,
        targets,
      )
    )
      return true;

    const optional =
      this.reflector.getAllAndOverride<boolean | undefined>(
        OPTIONAL_AUTH_KEY,
        targets,
      ) === true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = Authenticator.bearerToken(request.headers.authorization);
    if (token === undefined) {
      if (optional) return true; // anonymous
      throw new ApiException('UNAUTHENTICATED'); // same response as an invalid token: it does not say which one it was
    }
    request.user = await this.authenticator.authenticate(token);
    return true;
  }
}
