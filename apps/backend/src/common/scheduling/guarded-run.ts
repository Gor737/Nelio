import type { Logger } from '@nestjs/common';

const running = new Set<string>();

/**
 * Runs one scheduled job so that it can never hurt the process: a job that is still running from the last tick is skipped (no overlap), and
 * an error is logged (the error NAME only, never its message, which could carry data) instead of escaping into the scheduler. Returns the
 * job's result, or `undefined` when it was skipped or failed.
 */
export async function runGuarded<T>(
  job: string,
  logger: Logger,
  work: () => Promise<T>,
): Promise<T | undefined> {
  if (running.has(job)) {
    logger.warn({ event: 'job_skipped_overlap', job });
    return undefined;
  }
  running.add(job);
  const started = Date.now();
  try {
    const result = await work();
    logger.log({
      event: 'job_finished',
      job,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    logger.error({
      event: 'job_failed',
      job,
      error: error instanceof Error ? error.name : 'error',
    });
    return undefined;
  } finally {
    running.delete(job);
  }
}
