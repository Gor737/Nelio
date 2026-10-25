import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import {
  RATE_LIMIT_CLASSES,
  type RateLimitClassName,
} from '../constants/rate-limit-classes.js';
import { RATE_LIMIT_KEY } from '../decorators/rate-limit.decorator.js';
import { ApiException } from '../filters/api-exception.js';
import { RateLimitStore } from './rate-limit.store.js';

/**
 * Global rate limiter. It must be the FIRST global guard: the check order is 429 -> 401 -> 403 -> guards -> 400 -> 409
 * (Decision 140), so a flood is refused before a token is verified or a password hashed.
 *
 * Keys: `ip` (from `request.ip`, which honors TRUST_PROXY, so it is the client behind the proxy) and `email` (lowercased
 * `body.email`, so one address cannot be hammered from many IPs). The `user` and `conversation` keys need the
 * authenticated user, which does not exist before authentication; they are added with the Socket.IO gateways and message
 * endpoints in M8/M10, and until then those classes limit by `ip` only. Every applicable counter is incremented and the
 * request is refused when any is over its limit.
 */
@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly store = new RateLimitStore();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const name =
      this.reflector.getAllAndOverride<RateLimitClassName | undefined>(
        RATE_LIMIT_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? 'DEFAULT';
    const spec = RATE_LIMIT_CLASSES[name];
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const subjects: string[] = [];
    for (const key of spec.keys) {
      if (key === 'ip') subjects.push(`ip:${request.ip ?? 'unknown'}`);
      if (key === 'email') {
        const email = (request.body as { email?: unknown } | undefined)?.email;
        if (typeof email === 'string' && email.length > 0)
          subjects.push(`email:${email.trim().toLowerCase().slice(0, 254)}`);
      }
    }
    // Per-class counters: a flood of STRICT requests must not use up the DEFAULT budget of the same IP.
    let worstResetMs = 0;
    let exceeded = false;
    for (const subject of subjects) {
      const { count, resetInMs } = this.store.hit(
        `${name}|${subject}`,
        spec.windowMs,
      );
      if (count > spec.limit) {
        exceeded = true;
        worstResetMs = Math.max(worstResetMs, resetInMs);
      }
    }
    if (exceeded) {
      response.setHeader(
        'Retry-After',
        String(Math.max(1, Math.ceil(worstResetMs / 1000))),
      );
      throw new ApiException('TOO_MANY_REQUESTS');
    }
    return true;
  }

  onModuleDestroy(): void {
    this.store.close();
  }
}
