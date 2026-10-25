import { TRANSACTION_LIMITS } from '../../common/constants/limits.js';
import {
  isRetryableTransactionError,
  sqlstateOf,
} from './error-classifiers.js';

export interface RetryOptions {
  /** Attempts, the first one included. */
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Called before each new attempt, with the SQLSTATE that caused it. */
  onRetry?: (attempt: number, sqlstate: string) => void;
}

/**
 * Runs `attempt` until it succeeds, fails with a non-retryable error, or `maxAttempts` is reached (Decision 159: bounded
 * retry on 40P01 and 40001). Jittered linear backoff. The last error is rethrown unchanged.
 */
export async function withRetry<T>(
  attempt: (n: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? TRANSACTION_LIMITS.MAX_ATTEMPTS;
  const baseDelayMs =
    options.baseDelayMs ?? TRANSACTION_LIMITS.RETRY_BASE_DELAY_MS;
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (error) {
      if (!isRetryableTransactionError(error) || n >= maxAttempts) throw error;
      options.onRetry?.(n, sqlstateOf(error) as string);
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * n * (0.5 + Math.random())),
      );
    }
  }
}
