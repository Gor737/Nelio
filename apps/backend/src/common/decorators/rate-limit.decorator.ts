import { SetMetadata } from '@nestjs/common';
import type { RateLimitClassName } from '../constants/rate-limit-classes.js';

export const RATE_LIMIT_KEY = 'nelio:rate-limit-class';

export interface RateLimitMetadata {
  readonly name: RateLimitClassName;
  /** The route parameter that holds the conversation id, for classes keyed by conversation. Default `conversationId`. */
  readonly conversationParam: string;
}

/**
 * Puts a handler or controller in a rate-limit class (default: DEFAULT). The numbers live in rate-limit-classes.ts.
 * `conversationParam` names the route parameter with the conversation id for the Per-conversation burst class, for example
 * `@RateLimit('PER_CONVERSATION_BURST', { conversationParam: 'id' })` on `POST /conversations/:id/messages`.
 */
export const RateLimit = (
  name: RateLimitClassName,
  options: { conversationParam?: string } = {},
) =>
  SetMetadata(RATE_LIMIT_KEY, {
    name,
    conversationParam: options.conversationParam ?? 'conversationId',
  } satisfies RateLimitMetadata);
