// M6 database-core tests against the real nelio_test database: transaction runner (deadlock retry, timeouts), error
// classifiers (unique / foreign key / CHECK), lockRow whitelist, emit-after-commit and AuditWriter.
import { Test, type TestingModule } from '@nestjs/testing';
import type pg from 'pg';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import {
  DatabaseModule,
  PrismaService,
  TransactionService,
  isCheckViolation,
  isDeadlock,
  isForeignKeyViolation,
  isUniqueViolation,
  lockAdvisory,
  lockRow,
  lockRows,
  type Tx,
} from '../../src/infrastructure/database/index.js';
import {
  AuditModule,
  AuditWriter,
} from '../../src/infrastructure/audit/index.js';
import {
  EventBus,
  EventsModule,
  emitAfterCommit,
} from '../../src/infrastructure/events/index.js';
import { createPool, resetData } from '../support/database.js';
import { createUser } from '../support/factories.js';
import { testDatabaseUrl } from '../support/test-database.mjs';

let pool: pg.Pool;
let moduleRef: TestingModule;
let prisma: PrismaService;
let transactions: TransactionService;
let audit: AuditWriter;
let bus: EventBus;

beforeAll(async () => {
  pool = createPool();
  moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot({
        NODE_ENV: 'test',
        DATABASE_URL: testDatabaseUrl(),
        JWT_SECRET: 'test-secret-with-more-than-thirty-two-bytes-in-it',
      }),
      EventsModule,
      DatabaseModule,
      AuditModule,
    ],
  }).compile();
  await moduleRef.init();
  prisma = moduleRef.get(PrismaService);
  transactions = moduleRef.get(TransactionService);
  audit = moduleRef.get(AuditWriter);
  bus = moduleRef.get(EventBus);
});

afterAll(async () => {
  await moduleRef.close();
  await pool.end();
});

beforeEach(async () => {
  await resetData(pool);
});

/** Lets `count` callers arrive, then releases them all at once. */
function barrier(count: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    if (++arrived >= count) release();
    await gate;
  };
}

describe('TransactionService: deadlock retry', () => {
  /** Two transactions lock the same two users in opposite order: a real PostgreSQL deadlock on the first attempt. */
  async function crossLock(maxAttempts: number) {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    const meet = barrier(2);
    const attempts = { first: 0, second: 0 };
    const first = transactions.run(
      async (tx) => {
        const n = ++attempts.first;
        await lockRow(tx, 'user', a.id, 'NO_KEY_UPDATE');
        if (n === 1) await meet();
        await lockRow(tx, 'user', b.id, 'NO_KEY_UPDATE');
      },
      { maxAttempts, baseDelayMs: 5 },
    );
    const second = transactions.run(
      async (tx) => {
        const n = ++attempts.second;
        await lockRow(tx, 'user', b.id, 'NO_KEY_UPDATE');
        if (n === 1) await meet();
        await lockRow(tx, 'user', a.id, 'NO_KEY_UPDATE');
      },
      { maxAttempts, baseDelayMs: 5 },
    );
    const results = await Promise.allSettled([first, second]);
    return { results, attempts };
  }

  it('retries the whole transaction after a forced deadlock and both succeed', async () => {
    const { results, attempts } = await crossLock(3);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(attempts.first + attempts.second).toBe(3); // exactly one loser, run twice
  }, 20_000);

  it('gives up at the attempt limit and surfaces the deadlock', async () => {
    const { results, attempts } = await crossLock(1);
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(isDeadlock(rejected[0].reason)).toBe(true);
    expect(attempts.first + attempts.second).toBe(2); // no retry
  }, 20_000);

  it('does not retry an ordinary error', async () => {
    let calls = 0;
    await expect(
      transactions.run(async () => {
        calls++;
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');
    expect(calls).toBe(1);
  });
});

describe('TransactionService: timeouts', () => {
  it('sets statement_timeout and lock_timeout for the transaction only', async () => {
    const inside = await transactions.run(async (tx) => {
      const rows = await tx.$queryRaw<
        { s: string; l: string }[]
      >`SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l`;
      return rows[0];
    });
    expect(inside).toEqual({ s: '8s', l: '5s' });
    const after = await prisma.$queryRaw<
      { s: string; l: string }[]
    >`SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l`;
    expect(after[0]).toEqual({ s: '0', l: '0' });
  });

  it('cancels a statement that runs longer than statement_timeout', async () => {
    await expect(
      transactions.run(async (tx) => tx.$queryRaw`SELECT pg_sleep(2)`, {
        statementTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({});
  });
});

describe('database error classifiers (real constraint violations)', () => {
  async function failure(fn: (tx: Tx) => Promise<unknown>): Promise<unknown> {
    try {
      await transactions.run(fn);
    } catch (error) {
      return error;
    }
    throw new Error('expected the transaction to fail');
  }

  it('unique violation', async () => {
    const user = await createUser(pool);
    const error = await failure(
      (tx) =>
        tx.$executeRaw`INSERT INTO users (email, full_name, password_hash) VALUES (${user.email}, 'Dup', 'x')`,
    );
    expect(isUniqueViolation(error)).toBe(true);
    expect(isForeignKeyViolation(error)).toBe(false);
  });

  it('foreign-key violation', async () => {
    const error = await failure((tx) =>
      tx.auditLog.create({
        data: {
          actorId: '00000000-0000-7000-8000-000000000001',
          action: 'USER_SUSPENDED',
          targetType: 'user',
          targetId: '00000000-0000-7000-8000-000000000002',
        },
      }),
    );
    expect(isForeignKeyViolation(error)).toBe(true);
    expect(isUniqueViolation(error)).toBe(false);
  });

  it('CHECK violation', async () => {
    const user = await createUser(pool);
    const error = await failure((tx) =>
      tx.block.create({ data: { blockerId: user.id, blockedId: user.id } }),
    );
    expect(isCheckViolation(error)).toBe(true);
  });
});

describe('lockRow / lockRows / lockAdvisory', () => {
  it('locks an existing row and reports a missing one', async () => {
    const user = await createUser(pool);
    const found = await transactions.run((tx) =>
      lockRow(tx, 'user', user.id, 'SHARE'),
    );
    const missing = await transactions.run((tx) =>
      lockRow(tx, 'user', '00000000-0000-7000-8000-000000000009', 'SHARE'),
    );
    expect(found).toBe(true);
    expect(missing).toBe(false);
  });

  it('rejects a table, mode or id outside the whitelist before any SQL', async () => {
    await transactions.run(async (tx) => {
      await expect(
        lockRow(
          tx,
          'users; DROP TABLE users' as never,
          '00000000-0000-7000-8000-000000000009',
          'SHARE',
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        lockRow(
          tx,
          'user',
          '00000000-0000-7000-8000-000000000009',
          'UPDATE' as never,
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        lockRow(tx, 'user', "x'; DROP TABLE users;--", 'SHARE'),
      ).rejects.toThrow(TypeError);
      await expect(
        lockRow(
          tx,
          'toString' as never,
          '00000000-0000-7000-8000-000000000009',
          'SHARE',
        ),
      ).rejects.toThrow(TypeError);
      await expect(lockAdvisory(tx, 'OTHER' as never)).rejects.toThrow(
        TypeError,
      );
    });
  });

  it('lockRows locks in ascending id order and returns the existing ids', async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    const locked = await transactions.run((tx) =>
      lockRows(tx, 'user', [b.id, a.id, b.id], 'NO_KEY_UPDATE'),
    );
    expect(locked).toEqual([a.id, b.id].sort());
  });

  it('takes the ADMIN-SET advisory lock', async () => {
    await expect(
      transactions.run((tx) => lockAdvisory(tx, 'ADMIN-SET')),
    ).resolves.toBeUndefined();
  });
});

describe('emit-after-commit', () => {
  const payload = { userId: '00000000-0000-7000-8000-000000000001' } as never;
  let received: unknown[];
  let off: () => void;

  beforeEach(() => {
    received = [];
    off = bus.on('session.revoked', (p) => void received.push(p));
  });
  afterEach(() => off());

  it('delivers an event only after the transaction commits', async () => {
    await transactions.run(async (tx) => {
      emitAfterCommit(tx, 'session.revoked', payload);
      expect(received).toHaveLength(0); // still inside the transaction
    });
    expect(received).toEqual([payload]);
  });

  it('never delivers an event of a rolled-back transaction', async () => {
    await expect(
      transactions.run(async (tx) => {
        emitAfterCommit(tx, 'session.revoked', payload);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(received).toHaveLength(0);
  });

  it('delivers once when the first attempt deadlocked and the retry committed', async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    const meet = barrier(2);
    const attempts = [0, 0];
    const run = (index: 0 | 1, first: string, second: string) =>
      transactions.run(
        async (tx) => {
          const n = ++attempts[index];
          await lockRow(tx, 'user', first, 'NO_KEY_UPDATE');
          if (n === 1) await meet();
          await lockRow(tx, 'user', second, 'NO_KEY_UPDATE');
          emitAfterCommit(tx, 'session.revoked', payload);
        },
        { baseDelayMs: 5 },
      );
    await Promise.all([run(0, a.id, b.id), run(1, b.id, a.id)]);
    expect(received).toHaveLength(2); // one per committed transaction, none for the deadlocked attempt
  }, 20_000);

  it('a throwing listener cannot break the committed transaction', async () => {
    const offBad = bus.on('session.revoked', () => {
      throw new Error('listener failure');
    });
    try {
      await expect(
        transactions.run(async (tx) =>
          emitAfterCommit(tx, 'session.revoked', payload),
        ),
      ).resolves.toBeUndefined();
    } finally {
      offBad();
    }
  });
});

describe('AuditWriter', () => {
  it('writes the audit row in the caller transaction and keeps it on commit', async () => {
    const actor = await createUser(pool);
    await transactions.run((tx) =>
      audit.record(tx, {
        actorId: actor.id,
        action: 'USER_SUSPENDED',
        targetType: 'user',
        targetId: actor.id,
        metadata: { reason: 'test' },
      }),
    );
    const { rows } = await pool.query(
      'SELECT action, metadata FROM audit_logs WHERE actor_id = $1',
      [actor.id],
    );
    expect(rows).toEqual([
      { action: 'USER_SUSPENDED', metadata: { reason: 'test' } },
    ]);
  });

  it('the audit row disappears when the transaction rolls back', async () => {
    const actor = await createUser(pool);
    await expect(
      transactions.run(async (tx) => {
        await audit.record(tx, {
          actorId: actor.id,
          action: 'USER_SUSPENDED',
          targetType: 'user',
          targetId: actor.id,
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const { rows } = await pool.query('SELECT 1 FROM audit_logs');
    expect(rows).toHaveLength(0);
  });

  it('rejects an unknown action before any SQL runs', async () => {
    const actor = await createUser(pool);
    await expect(
      transactions.run((tx) =>
        audit.record(tx, {
          actorId: actor.id,
          action: 'NOT_AN_ACTION' as never,
          targetType: 'user',
          targetId: actor.id,
        }),
      ),
    ).rejects.toThrow(TypeError);
    const { rows } = await pool.query('SELECT 1 FROM audit_logs');
    expect(rows).toHaveLength(0);
  });
});
