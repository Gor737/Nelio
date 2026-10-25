import { Injectable, Logger } from '@nestjs/common';
import { TRANSACTION_LIMITS } from '../../common/constants/limits.js';
import { EventBus, takeQueuedEvents } from '../events/index.js';
import { PrismaService } from './prisma.service.js';
import { withRetry } from './retry.js';
import type { Tx } from './tx.js';

export interface TransactionOptions {
  /** Attempts for deadlock/serialization failure, the first one included. */
  maxAttempts?: number;
  baseDelayMs?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  timeoutMs?: number;
  maxWaitMs?: number;
}

/**
 * `runInTransaction` of Decision 159/161. READ COMMITTED (the PostgreSQL default), transaction-local statement and lock
 * timeouts, and bounded retry of the WHOLE transaction on deadlock (40P01) and serialization failure (40001). The callback
 * must be safe to run again: no email, hashing or network inside it.
 *
 * Events queued with `emitAfterCommit(tx, ...)` are delivered once, after COMMIT of the attempt that succeeded; the queue of
 * a rolled-back or retried attempt is discarded with its transaction object.
 */
@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
  ) {}

  async run<T>(
    fn: (tx: Tx) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const statementTimeoutMs =
      options.statementTimeoutMs ?? TRANSACTION_LIMITS.STATEMENT_TIMEOUT_MS;
    const lockTimeoutMs =
      options.lockTimeoutMs ?? TRANSACTION_LIMITS.LOCK_TIMEOUT_MS;

    const { value, queued } = await withRetry(
      () =>
        this.prisma.$transaction(
          async (tx) => {
            // set_config(..., true) is transaction-local, so it cannot leak to the next user of the pooled connection;
            // unlike SET LOCAL it accepts bind parameters.
            await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true), set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`;
            const result = await fn(tx);
            return { value: result, queued: takeQueuedEvents(tx) };
          },
          {
            timeout: options.timeoutMs ?? TRANSACTION_LIMITS.PRISMA_TIMEOUT_MS,
            maxWait: options.maxWaitMs ?? TRANSACTION_LIMITS.PRISMA_MAX_WAIT_MS,
          },
        ),
      {
        maxAttempts: options.maxAttempts,
        baseDelayMs: options.baseDelayMs,
        onRetry: (attempt, sqlstate) =>
          this.logger.warn(
            `Transaction attempt ${attempt} failed with SQLSTATE ${sqlstate}; retrying`,
          ),
      },
    );

    for (const event of queued)
      this.events.emit(event.name, event.payload as never);
    return value;
  }
}
