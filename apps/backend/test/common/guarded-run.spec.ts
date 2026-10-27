import { jest } from '@jest/globals';
import type { Logger } from '@nestjs/common';
import { runGuarded } from '../../src/common/scheduling/guarded-run.js';

const makeLogger = () =>
  ({
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }) as unknown as Logger & {
    log: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };

describe('runGuarded', () => {
  it('returns the result and logs the finish with the duration', async () => {
    const logger = makeLogger();
    expect(await runGuarded('j1', logger, () => Promise.resolve(42))).toBe(42);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'job_finished', job: 'j1' }),
    );
  });

  it('never throws: an error is logged by NAME only (its message may carry data) and the result is undefined', async () => {
    const logger = makeLogger();
    const boom = new RangeError('secret-looking message');
    expect(
      await runGuarded('j2', logger, () => Promise.reject(boom)),
    ).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith({
      event: 'job_failed',
      job: 'j2',
      error: 'RangeError',
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'secret-looking',
    );
  });

  it('skips a tick while the previous run is still going, and runs again after it finished', async () => {
    const logger = makeLogger();
    let release!: () => void;
    const first = runGuarded(
      'j3',
      logger,
      () => new Promise<string>((resolve) => (release = () => resolve('done'))),
    );
    const work = jest.fn(() => Promise.resolve('second'));
    expect(await runGuarded('j3', logger, work)).toBeUndefined();
    expect(work).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith({
      event: 'job_skipped_overlap',
      job: 'j3',
    });
    release();
    expect(await first).toBe('done');
    expect(await runGuarded('j3', logger, work)).toBe('second');
  });

  it('different jobs do not block each other, and a failed job can run again', async () => {
    const logger = makeLogger();
    let release!: () => void;
    const slow = runGuarded(
      'slow',
      logger,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    expect(await runGuarded('other', logger, () => Promise.resolve(1))).toBe(1);
    release();
    await slow;
    await runGuarded('flaky', logger, () => Promise.reject(new Error('x')));
    expect(await runGuarded('flaky', logger, () => Promise.resolve(2))).toBe(2);
  });
});
