/**
 * Rate-limit classes (docs/architecture.md section 13, Decision 137): Strict, Tight, Per-conversation burst, Default.
 * A global throttler runs before authentication (check order: 429 first), so `ip` is always available; `user` and
 * `email` keys are added where the endpoint has them. The numbers are `proposed` (the documents name the classes and the
 * endpoints, not the values) and are listed in the M4 report for review.
 */
export interface RateLimitClass {
  /** Maximum requests per key within the window. */
  readonly limit: number;
  readonly windowMs: number;
  /** Keys the counter is kept for. Sensitive endpoints combine per-IP and per-email counters. */
  readonly keys: readonly ('ip' | 'email' | 'user' | 'conversation')[];
  readonly appliesTo: readonly string[];
}

export const RATE_LIMIT_CLASSES = {
  STRICT: {
    limit: 5,
    windowMs: 60_000,
    keys: ['ip', 'email'],
    appliesTo: [
      'login',
      'registration',
      'forgot-password',
      'resend-verification',
    ],
  },
  TIGHT: {
    limit: 20,
    windowMs: 60_000,
    keys: ['ip', 'user'],
    appliesTo: [
      'user search',
      'DM/group creation',
      'uploads',
      'reports',
      'teacher application',
      'invitations',
    ],
  },
  PER_CONVERSATION_BURST: {
    limit: 30,
    windowMs: 10_000,
    keys: ['user', 'conversation'],
    appliesTo: ['message send', 'typing'],
  },
  DEFAULT: {
    limit: 120,
    windowMs: 60_000,
    keys: ['ip'],
    appliesTo: ['every other endpoint'],
  },
} as const satisfies Record<string, RateLimitClass>;

export type RateLimitClassName = keyof typeof RATE_LIMIT_CLASSES;
