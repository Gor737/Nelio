// M9c: Moderation against the real database: blocks (Decisions 76, 84, 129) and filing reports (Decisions 77, 78).
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { TEXT_LIMITS } from '../../src/common/constants/limits.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import {
  DatabaseModule,
  PrismaService,
  TransactionService,
} from '../../src/infrastructure/database/index.js';
import { EventsModule } from '../../src/infrastructure/events/index.js';
import {
  BlockService,
  ModerationModule,
} from '../../src/modules/moderation/index.js';
import { createPool, resetData } from '../support/database.js';
import {
  addMember,
  createChannel,
  createDirectConversation,
  createGroup,
  createMessage,
  reportMessage,
  reportUser,
} from '../support/factories-chat.js';
import {
  createAdmin,
  createUser,
  createUserWithRoles,
} from '../support/factories.js';
import { createCourse } from '../support/factories-courses.js';
import { bearer, closeApp, testEnv } from '../support/integration-app.js';

const pool = createPool();
let app: NestExpressApplication;
let blocks: BlockService;
let transactions: TransactionService;
let prisma: PrismaService;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      ModerationModule,
    ],
    providers: GLOBAL_PROVIDERS,
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  blocks = app.get(BlockService);
  transactions = app.get(TransactionService);
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
beforeEach(() => resetData(pool));

let clientCounter = 0;
/** Each request comes from its own client address (one trusted proxy hop), so the per-IP counters never couple unrelated tests. */
const nextClientIp = () =>
  `10.1.${(clientCounter >> 8) & 255}.${clientCounter++ & 255}`;
const as = (userId: string) => ({
  put: (path: string) =>
    request(app.getHttpServer())
      .put(`/api/v1${path}`)
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', nextClientIp()),
  get: (path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', nextClientIp()),
  delete: (path: string) =>
    request(app.getHttpServer())
      .delete(`/api/v1${path}`)
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', nextClientIp()),
  post: (path: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', nextClientIp())
      .send(body),
});
const blockRows = async () =>
  (await pool.query('SELECT blocker_id, blocked_id FROM blocks')).rows;
const reportRows = async () =>
  (await pool.query('SELECT * FROM reports ORDER BY created_at')).rows;
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; status: number; message: string };
  }
  throw new Error('expected a rejection');
};

describe('blocks over HTTP', () => {
  it('PUT /me/blocks/:userId blocks (204) and is idempotent: a second call changes nothing', async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    await as(a.id).put(`/me/blocks/${b.id}`).expect(204);
    await as(a.id).put(`/me/blocks/${b.id}`).expect(204);
    expect(await blockRows()).toEqual([{ blocker_id: a.id, blocked_id: b.id }]);
  });

  it('DELETE /me/blocks/:userId unblocks (204) and is idempotent, also for someone who was never blocked', async () => {
    const [a, b, c] = [
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    await as(a.id).put(`/me/blocks/${b.id}`).expect(204);
    await as(a.id).delete(`/me/blocks/${b.id}`).expect(204);
    await as(a.id).delete(`/me/blocks/${b.id}`).expect(204);
    await as(a.id).delete(`/me/blocks/${c.id}`).expect(204);
    expect(await blockRows()).toEqual([]);
  });

  it('yourself: 400 CANNOT_BLOCK_SELF; an unknown user: 404; a malformed id: 400', async () => {
    const a = await createUser(pool);
    expect(
      (await as(a.id).put(`/me/blocks/${a.id}`).expect(400)).body.code,
    ).toBe('CANNOT_BLOCK_SELF');
    await as(a.id)
      .put('/me/blocks/019d0000-0000-7000-8000-000000000000')
      .expect(404);
    await as(a.id).put('/me/blocks/not-a-uuid').expect(400);
    expect(await blockRows()).toEqual([]);
  });

  it('an ACTIVE Admin cannot be blocked (409 CANNOT_BLOCK_ADMIN); a user whose Admin role was revoked can', async () => {
    const [a, admin] = [await createUser(pool), await createAdmin(pool)];
    expect(
      (await as(a.id).put(`/me/blocks/${admin.id}`).expect(409)).body.code,
    ).toBe('CANNOT_BLOCK_ADMIN');
    const former = await createUserWithRoles(pool, [
      { role: 'STUDENT', status: 'ACTIVE' },
      { role: 'ADMIN', status: 'REVOKED' },
    ]);
    await as(a.id).put(`/me/blocks/${former.id}`).expect(204);
    expect(await blockRows()).toEqual([
      { blocker_id: a.id, blocked_id: former.id },
    ]);
  });

  it('GET /me/blocks lists only your own blocks, newest first, with exactly userId, fullName and blockedAt', async () => {
    const a = await createUser(pool);
    const first = await createUser(pool, { fullName: 'Առաջին' });
    const second = await createUser(pool, { fullName: 'Second' });
    await as(a.id).put(`/me/blocks/${first.id}`).expect(204);
    await as(a.id).put(`/me/blocks/${second.id}`).expect(204);
    const res = await as(a.id).get('/me/blocks').expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.items.map((i: { userId: string }) => i.userId)).toEqual([
      second.id,
      first.id,
    ]);
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual([
        'blockedAt',
        'fullName',
        'userId',
      ]);
    }
    expect(res.body.items[1].fullName).toBe('Առաջին');
  });

  it('nobody can learn who blocked them: the blocked user sees an empty list and nothing in any response mentions the blocker', async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    await as(a.id).put(`/me/blocks/${b.id}`).expect(204);
    const mine = await as(b.id).get('/me/blocks').expect(200);
    expect(mine.body).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
    expect(JSON.stringify(mine.body)).not.toContain(a.id);
    // blocking back is an ordinary, independent block: it does not reveal or depend on the first one
    await as(b.id).put(`/me/blocks/${a.id}`).expect(204);
    expect((await as(b.id).get('/me/blocks').expect(200)).body.total).toBe(1);
  });

  it('paginates with page and pageSize and rejects out-of-range values', async () => {
    const a = await createUser(pool);
    for (let i = 0; i < 3; i++) {
      const other = await createUser(pool);
      await as(a.id).put(`/me/blocks/${other.id}`).expect(204);
    }
    const p1 = (await as(a.id).get('/me/blocks?page=1&pageSize=2').expect(200))
      .body;
    const p2 = (await as(a.id).get('/me/blocks?page=2&pageSize=2').expect(200))
      .body;
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(1);
    expect(p1.total).toBe(3);
    const ids = [...p1.items, ...p2.items].map(
      (i: { userId: string }) => i.userId,
    );
    expect(new Set(ids).size).toBe(3);
    await as(a.id).get('/me/blocks?pageSize=51').expect(400);
    await as(a.id).get('/me/blocks?page=0').expect(400);
  });

  it('every block route needs a signed-in user', async () => {
    const b = await createUser(pool);
    await request(app.getHttpServer()).get('/api/v1/me/blocks').expect(401);
    await request(app.getHttpServer())
      .put(`/api/v1/me/blocks/${b.id}`)
      .expect(401);
    await request(app.getHttpServer())
      .delete(`/api/v1/me/blocks/${b.id}`)
      .expect(401);
  });
});

describe('BlockService for other modules (Chat)', () => {
  it('isBlockedEitherWay is true in both directions, false without a block and for the same user', async () => {
    const [a, b, c] = [
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    expect(await blocks.isBlockedEitherWay(a.id, b.id)).toBe(false);
    await blocks.block(a.id, b.id);
    expect(await blocks.isBlockedEitherWay(a.id, b.id)).toBe(true);
    expect(await blocks.isBlockedEitherWay(b.id, a.id)).toBe(true);
    expect(await blocks.isBlockedEitherWay(a.id, c.id)).toBe(false);
    expect(await blocks.isBlockedEitherWay(a.id, a.id)).toBe(false);
  });

  it('a block whose blocked party is an Admin never counts (blocks do not apply to Admins), even if the row exists', async () => {
    const [a, admin] = [await createUser(pool), await createAdmin(pool)];
    // the application refuses to create it; the rows could exist from before the role was granted
    await pool.query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)',
      [a.id, admin.id],
    );
    expect(await blocks.isBlockedEitherWay(a.id, admin.id)).toBe(false);
    expect(await blocks.isBlockedEitherWay(admin.id, a.id)).toBe(false);
    await blocks.assertCanAdd(admin.id, [a.id]);
    // the Admin blocking an ordinary user is an ordinary block
    await pool.query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)',
      [admin.id, a.id],
    );
    expect(await blocks.isBlockedEitherWay(a.id, admin.id)).toBe(true);
  });

  it('works inside a transaction (the same connection sees an uncommitted block)', async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    const seen = await transactions.run(async (tx) => {
      await tx.$executeRaw`INSERT INTO blocks (blocker_id, blocked_id) VALUES (${a.id}::uuid, ${b.id}::uuid)`;
      return blocks.isBlockedEitherWay(a.id, b.id, tx);
    });
    expect(seen).toBe(true);
  });

  it('assertCanAdd (Decision 84): refuses with the neutral MEMBERS_UNAVAILABLE only when a candidate has blocked the adder', async () => {
    const [adder, blocker, friend] = [
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    await blocks.assertCanAdd(adder.id, [blocker.id, friend.id]);
    await blocks.block(blocker.id, adder.id);
    const error = await rejection(
      blocks.assertCanAdd(adder.id, [friend.id, blocker.id]),
    );
    expect(error.code).toBe('MEMBERS_UNAVAILABLE');
    expect(error.status).toBe(409);
    expect(error.message).not.toContain(blocker.id);
    expect(error.message.toLowerCase()).not.toContain('block');
    await blocks.assertCanAdd(adder.id, [friend.id]);
    await blocks.assertCanAdd(adder.id, []);
    await blocks.assertCanAdd(adder.id, [adder.id]);
  });

  it("assertCanAdd: the adder having blocked the candidate is not a reason to refuse (only the candidate's block is)", async () => {
    const [adder, candidate] = [await createUser(pool), await createUser(pool)];
    await blocks.block(adder.id, candidate.id);
    await blocks.assertCanAdd(adder.id, [candidate.id]);
  });
});

describe('POST /users/:id/report', () => {
  it('files an OPEN USER report and returns only id, status and createdAt', async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    const res = await as(a.id)
      .post(`/users/${b.id}/report`, {
        reason: 'HARASSMENT',
        description: 'Insults in the course chat',
      })
      .expect(201);
    expect(Object.keys(res.body).sort()).toEqual(['createdAt', 'id', 'status']);
    expect(res.body.status).toBe('OPEN');
    const [row] = await reportRows();
    expect(row).toMatchObject({
      id: res.body.id,
      reporter_id: a.id,
      target_type: 'USER',
      target_user_id: b.id,
      message_id: null,
      message_snapshot: null,
      reason: 'HARASSMENT',
      description: 'Insults in the course chat',
      status: 'OPEN',
    });
  });

  it('the description is optional', async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    await as(a.id)
      .post(`/users/${b.id}/report`, { reason: 'SPAM' })
      .expect(201);
    expect((await reportRows())[0].description).toBeNull();
  });

  it('reporting yourself: 400 VALIDATION_FAILED; an unknown user: 404; a malformed id: 400; nothing is stored', async () => {
    const a = await createUser(pool);
    expect(
      (
        await as(a.id)
          .post(`/users/${a.id}/report`, { reason: 'SPAM' })
          .expect(400)
      ).body.code,
    ).toBe('VALIDATION_FAILED');
    await as(a.id)
      .post('/users/019d0000-0000-7000-8000-000000000000/report', {
        reason: 'SPAM',
      })
      .expect(404);
    await as(a.id).post('/users/nope/report', { reason: 'SPAM' }).expect(400);
    expect(await reportRows()).toEqual([]);
  });

  it('validates the body: reason must be one of the four, the description 1-1000 characters counted as code points', async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    const send = (body: object) => as(a.id).post(`/users/${b.id}/report`, body);
    await send({}).expect(400);
    await send({ reason: 'RUDE' }).expect(400);
    await send({ reason: 'SPAM', description: '' }).expect(400);
    await send({
      reason: 'SPAM',
      description: 'x'.repeat(TEXT_LIMITS.REPORT_DESCRIPTION.max + 1),
    }).expect(400);
    expect(await reportRows()).toEqual([]);
    // 1000 emoji are 1000 code points (2000 UTF-16 units): accepted by the helper and by the database CHECK
    await send({
      reason: 'OTHER',
      description: '😀'.repeat(TEXT_LIMITS.REPORT_DESCRIPTION.max),
    }).expect(201);
  });

  it('a second OPEN report on the same user by the same reporter is 409 RESOURCE_CONFLICT; once handled, a new one is allowed; others are independent', async () => {
    const [a, b, c] = [
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    await as(a.id)
      .post(`/users/${b.id}/report`, { reason: 'SPAM' })
      .expect(201);
    expect(
      (
        await as(a.id)
          .post(`/users/${b.id}/report`, { reason: 'SPAM' })
          .expect(409)
      ).body.code,
    ).toBe('RESOURCE_CONFLICT');
    await as(c.id)
      .post(`/users/${b.id}/report`, { reason: 'SPAM' })
      .expect(201);
    await pool.query(
      "UPDATE reports SET status = 'DISMISSED' WHERE reporter_id = $1",
      [a.id],
    );
    await as(a.id)
      .post(`/users/${b.id}/report`, { reason: 'SPAM' })
      .expect(201);
    expect(await reportRows()).toHaveLength(3);
  });

  it('needs a signed-in user', async () => {
    const b = await createUser(pool);
    await request(app.getHttpServer())
      .post(`/api/v1/users/${b.id}/report`)
      .send({ reason: 'SPAM' })
      .expect(401);
  });
});

describe('POST /conversations/:conversationId/messages/:messageId/report', () => {
  async function chat() {
    const [reporter, sender, outsider] = [
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    const conversation = await createGroup(pool, sender.id, [reporter.id]);
    const message = await createMessage(pool, conversation, sender.id, {
      body: 'original text',
    });
    return { reporter, sender, outsider, conversation, message };
  }
  const report = (
    userId: string,
    conversation: string,
    message: string,
    body: object = { reason: 'HARASSMENT' },
  ) =>
    as(userId).post(
      `/conversations/${conversation}/messages/${message}/report`,
      body,
    );

  it('files an OPEN MESSAGE report that stores the message body as it is now; the response carries no snapshot', async () => {
    const { reporter, conversation, message } = await chat();
    const res = await report(reporter.id, conversation, message, {
      reason: 'INAPPROPRIATE',
      description: 'see message',
    }).expect(201);
    expect(Object.keys(res.body).sort()).toEqual(['createdAt', 'id', 'status']);
    const [row] = await reportRows();
    expect(row).toMatchObject({
      id: res.body.id,
      reporter_id: reporter.id,
      target_type: 'MESSAGE',
      message_id: message,
      target_user_id: null,
      message_snapshot: 'original text',
      reason: 'INAPPROPRIATE',
      status: 'OPEN',
    });
  });

  it('the snapshot survives a later edit and a later delete of the message', async () => {
    const { reporter, conversation, message } = await chat();
    await report(reporter.id, conversation, message).expect(201);
    await pool.query(
      "UPDATE messages SET body = 'edited text', edited_at = now() WHERE id = $1",
      [message],
    );
    expect((await reportRows())[0].message_snapshot).toBe('original text');
    await pool.query(
      'UPDATE messages SET deleted_at = now(), deleted_by = sender_id WHERE id = $1',
      [message],
    );
    expect((await reportRows())[0].message_snapshot).toBe('original text');
  });

  it('the evidence is the body at the moment of the request, not an earlier one', async () => {
    const { reporter, conversation, message } = await chat();
    await pool.query(
      "UPDATE messages SET body = 'second version' WHERE id = $1",
      [message],
    );
    await report(reporter.id, conversation, message).expect(201);
    expect((await reportRows())[0].message_snapshot).toBe('second version');
  });

  it('stores an Armenian and emoji body exactly', async () => {
    const { reporter, sender, conversation } = await chat();
    const body = 'Բարև ձեզ 😀 é';
    const message = await createMessage(pool, conversation, sender.id, {
      body,
    });
    await report(reporter.id, conversation, message).expect(201);
    expect((await reportRows())[0].message_snapshot).toBe(body);
  });

  it('a reported message cannot be hard-deleted (the report keeps pointing at it)', async () => {
    const { reporter, conversation, message } = await chat();
    await report(reporter.id, conversation, message).expect(201);
    await expect(
      pool.query('DELETE FROM messages WHERE id = $1', [message]),
    ).rejects.toMatchObject({ code: '23001' }); // restrict_violation: ON DELETE RESTRICT
  });

  it('someone who is not in the conversation, or has left it, gets 404 and nothing is stored', async () => {
    const { reporter, outsider, conversation, message } = await chat();
    await report(outsider.id, conversation, message).expect(404);
    await pool.query(
      'UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2',
      [conversation, reporter.id],
    );
    await report(reporter.id, conversation, message).expect(404);
    expect(await reportRows()).toEqual([]);
  });

  it('the answer for a non-member is identical to the answer for a message that does not exist', async () => {
    const { outsider, conversation, message } = await chat();
    const real = await report(outsider.id, conversation, message).expect(404);
    const missing = await report(
      outsider.id,
      conversation,
      '019d0000-0000-7000-8000-000000000000',
    ).expect(404);
    expect(real.body.code).toBe(missing.body.code);
    expect(real.body.message).toBe(missing.body.message);
  });

  it('a message of another conversation, or a deleted message, is 404', async () => {
    const { reporter, sender, conversation, message } = await chat();
    const other = await createGroup(pool, sender.id, [reporter.id]);
    await report(reporter.id, other, message).expect(404);
    const deleted = await createMessage(pool, conversation, sender.id, {
      deletedAt: new Date(),
      deletedBy: sender.id,
    });
    await report(reporter.id, conversation, deleted).expect(404);
    expect(await reportRows()).toEqual([]);
  });

  it('reporting your own message is 400 VALIDATION_FAILED', async () => {
    const { sender, conversation, message } = await chat();
    const res = await report(sender.id, conversation, message).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(await reportRows()).toEqual([]);
  });

  it('a second OPEN report on the same message by the same reporter is 409; another reporter may report it; after handling, a new one is allowed', async () => {
    const { reporter, sender, conversation, message } = await chat();
    const third = await createUser(pool);
    await addMember(pool, conversation, third.id);
    await report(reporter.id, conversation, message).expect(201);
    expect(
      (await report(reporter.id, conversation, message).expect(409)).body.code,
    ).toBe('RESOURCE_CONFLICT');
    await report(third.id, conversation, message).expect(201);
    await pool.query(
      "UPDATE reports SET status = 'ACTIONED' WHERE reporter_id = $1",
      [reporter.id],
    );
    await report(reporter.id, conversation, message).expect(201);
    expect(await reportRows()).toHaveLength(3);
    expect(sender.id).not.toBe(reporter.id);
  });

  it('works in a direct conversation and in a course channel', async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    const direct = await createDirectConversation(pool, a.id, b.id);
    const fromB = await createMessage(pool, direct, b.id, { body: 'hi' });
    await report(a.id, direct, fromB).expect(201);
    const channel = await createChannel(pool, await createCourse(pool));
    await addMember(pool, channel, b.id);
    await addMember(pool, channel, a.id);
    const text = await createMessage(pool, channel, b.id);
    await report(a.id, channel, text).expect(201);
  });

  it('validates the body like a user report', async () => {
    const { reporter, conversation, message } = await chat();
    await report(reporter.id, conversation, message, {}).expect(400);
    await report(reporter.id, conversation, message, {
      reason: 'SPAM',
      description: '',
    }).expect(400);
    await report(reporter.id, 'nope', message).expect(400);
    expect(await reportRows()).toEqual([]);
  });

  it('two requests at once from the same reporter file exactly one report (the other is 409)', async () => {
    const { reporter, conversation, message } = await chat();
    const results = await Promise.all([
      report(reporter.id, conversation, message),
      report(reporter.id, conversation, message),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(await reportRows()).toHaveLength(1);
  });

  it('existing reports of other tables are untouched by the helpers (reportMessage/reportUser factories still insert directly)', async () => {
    const { reporter, conversation, message, sender } = await chat();
    await reportMessage(pool, reporter.id, message);
    await reportUser(pool, reporter.id, sender.id);
    expect(await reportRows()).toHaveLength(2);
    // the open message report made by the factory blocks a second one through the API too
    await report(reporter.id, conversation, message).expect(409);
    void prisma;
  });
});
