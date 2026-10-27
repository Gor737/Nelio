import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  RATE_LIMIT_CLASSES,
  type RateLimitClassName,
} from '../constants/rate-limit-classes.js';
import { RateLimitStore } from './rate-limit.store.js';

/** The values a counter can be keyed by. A class uses only the keys it declares in `RATE_LIMIT_CLASSES`. */
export interface RateLimitSubjects {
  readonly ip?: string;
  /** Submitted email address (any case); counted lowercased. */
  readonly email?: string;
  /** The authenticated user. */
  readonly userId?: string;
  /** The conversation the request or event is about. */
  readonly conversationId?: string;
}

/**
 * `pre-auth`: the keys that exist before authentication (`ip`, `email`); `post-auth`: the keys that need the authenticated user
 * (`user`, `conversation`). The rate-limit guard consumes the first phase before the JWT guard (429 comes first), the user-keyed
 * guard consumes the second right after authentication, and a Socket.IO gateway consumes the second per event.
 */
export type RateLimitPhase = 'pre-auth' | 'post-auth';

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the worst exceeded window ends (at least 1); 0 when allowed. */
  readonly retryAfterSeconds: number;
}

/**
 * The counting behind every rate limit, shared by the HTTP guards and the Socket.IO gateways (Decisions 153 and 167).
 *
 * Counters are kept per class and per subject, so a flood of STRICT requests cannot use up the DEFAULT budget of the same IP.
 * Subjects of a class, by its declared keys:
 *   - `ip`, `email`      one counter each (the email is lowercased and trimmed);
 *   - `user`             one counter per user;
 *   - `user` + `conversation`  ONE composite counter per user per conversation (the burst class: 30 messages in 10 s per user in
 *                        a conversation, not 30 for the whole conversation). A missing conversation id is counted as
 *                        `conversation:-`, which is stricter, never unlimited.
 * Every applicable counter is incremented and the request is refused when any of them is over its limit. A class with no key in
 * the requested phase (for example PER_CONVERSATION_BURST before authentication) consumes nothing.
 */
@Injectable()
export class RateLimiter implements OnModuleDestroy {
  private readonly store = new RateLimitStore();

  consume(
    name: RateLimitClassName,
    subjects: RateLimitSubjects,
    phase: RateLimitPhase,
  ): RateLimitDecision {
    const spec = RATE_LIMIT_CLASSES[name];
    const keys: readonly string[] = spec.keys;
    const counters: string[] = [];

    if (phase === 'pre-auth') {
      if (keys.includes('ip') && subjects.ip !== undefined)
        counters.push(`ip:${subjects.ip}`);
      if (
        keys.includes('email') &&
        typeof subjects.email === 'string' &&
        subjects.email.length > 0
      ) {
        counters.push(
          `email:${subjects.email.trim().toLowerCase().slice(0, 254)}`,
        );
      }
    } else if (subjects.userId !== undefined) {
      if (keys.includes('user') && keys.includes('conversation')) {
        counters.push(
          `user:${subjects.userId}|conversation:${subjects.conversationId ?? '-'}`,
        );
      } else if (keys.includes('user')) {
        counters.push(`user:${subjects.userId}`);
      }
    }

    let worstResetMs = 0;
    let exceeded = false;
    for (const counter of counters) {
      const { count, resetInMs } = this.store.hit(
        `${name}|${counter}`,
        spec.windowMs,
      );
      if (count > spec.limit) {
        exceeded = true;
        worstResetMs = Math.max(worstResetMs, resetInMs);
      }
    }
    return exceeded
      ? {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(worstResetMs / 1000)),
        }
      : { allowed: true, retryAfterSeconds: 0 };
  }

  /** Counters currently held (for tests and monitoring). */
  size(): number {
    return this.store.size();
  }

  onModuleDestroy(): void {
    this.store.close();
  }
}
