import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import {
  RATE_LIMIT_KEY,
  type RateLimitMetadata,
} from '../decorators/rate-limit.decorator.js';
import { ApiException } from '../filters/api-exception.js';
import type { AuthenticatedRequest } from './authenticated-user.js';
import { RateLimiter } from './rate-limiter.js';

const DEFAULT_CLASS: RateLimitMetadata = {
  name: 'DEFAULT',
  conversationParam: 'conversationId',
};

function classOf(
  reflector: Reflector,
  context: ExecutionContext,
): RateLimitMetadata {
  return (
    reflector.getAllAndOverride<RateLimitMetadata | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? DEFAULT_CLASS
  );
}

function refuse(response: Response, retryAfterSeconds: number): never {
  response.setHeader('Retry-After', String(retryAfterSeconds));
  throw new ApiException('TOO_MANY_REQUESTS');
}

/**
 * Rate limiter, first phase. It must be the FIRST global guard: the check order is 429 -> 401 -> 403 -> guards -> 400 -> 409
 * (Decision 140), so a flood is refused before a token is verified or a password hashed. Only the keys that exist before
 * authentication are counted here: `ip` (from `request.ip`, which honors TRUST_PROXY, so it is the client behind the proxy) and
 * `email` (lowercased `body.email`, so one address cannot be hammered from many IPs).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const { name } = classOf(this.reflector, context);
    const request = context.switchToHttp().getRequest<Request>();
    const decision = this.limiter.consume(
      name,
      {
        ip: request.ip ?? 'unknown',
        email: (request.body as { email?: unknown } | undefined)?.email as
          string | undefined,
      },
      'pre-auth',
    );
    if (!decision.allowed)
      refuse(
        context.switchToHttp().getResponse<Response>(),
        decision.retryAfterSeconds,
      );
    return true;
  }
}

/**
 * Rate limiter, second phase (Decision 167): the keys that need the authenticated user, `user` and `conversation`. It is
 * registered right after the JWT guard, so it runs after 401 and 403 ACCOUNT_SUSPENDED and before the role and course guards
 * and before the input is validated. A user-keyed limit cannot come before authentication; the order is therefore
 * 429 (ip/email) -> 401 -> 403 ACCOUNT_SUSPENDED -> 429 (user/conversation) -> other guards -> 400 -> 409.
 * It does nothing for anonymous callers and for classes that have no user key.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) return true;
    const { name, conversationParam } = classOf(this.reflector, context);
    const conversationId: unknown = request.params[conversationParam];
    const decision = this.limiter.consume(
      name,
      {
        userId: request.user.id,
        conversationId:
          typeof conversationId === 'string'
            ? conversationId.toLowerCase()
            : undefined,
      },
      'post-auth',
    );
    if (!decision.allowed)
      refuse(
        context.switchToHttp().getResponse<Response>(),
        decision.retryAfterSeconds,
      );
    return true;
  }
}
