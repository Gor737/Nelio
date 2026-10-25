import { SetMetadata } from '@nestjs/common';
import type { RateLimitClassName } from '../constants/rate-limit-classes.js';

export const RATE_LIMIT_KEY = 'nelio:rate-limit-class';

/** Puts a handler or controller in a rate-limit class (default: DEFAULT). The numbers live in rate-limit-classes.ts. */
export const RateLimit = (name: RateLimitClassName) =>
  SetMetadata(RATE_LIMIT_KEY, name);
