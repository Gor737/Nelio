// M10c step 2: messages and CourseChannelService against the real database (Decisions 24-29, 32, 41, 42, 81, 82, 85, 86, 87, 131, 154).
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import {
  DatabaseModule,
  TransactionService,
} from '../../src/infrastructure/database/index.js';
import {
  EventBus,
  EventsModule,
} from '../../src/infrastructure/events/index.js';
import {
  ChatModule,
  CourseChannelService,
} from '../../src/modules/chat/index.js';
import { ChatDeliveryService } from '../../src/modules/chat/services/chat-delivery.service.js';
import { BlockService } from '../../src/modules/moderation/index.js';
import { createPool, resetData } from '../support/database.js';
import { createTeacher, createUser } from '../support/factories.js';
import {
  createDirectConversation,
  createGroup,
} from '../support/factories-chat.js';
import {
  addCourseTeacher,
  createPublishedCourse,
} from '../support/factories-courses.js';
import { createEnrollment } from '../support/factories-learning.js';
import { bearer, closeApp, testEnv } from '../support/integration-app.js';

const pool = createPool(30);
let app: NestExpressApplication;
let delivery: ChatDeliveryService;
let blocks: BlockService;
let channels: CourseChannelService;
let transactions: TransactionService;
const events: { name: string; payload: Record<string, unknown> }[] = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      ChatModule,
    ],
    providers: GLOBAL_PROVIDERS,
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  delivery = app.get(ChatDeliveryService, { strict: false });
  blocks = app.get(BlockService, { strict: false });
  channels = app.get(CourseChannelService);
  transactions = app.get(TransactionService);
  const bus = app.get(EventBus);
  for (const name of [
    'message.created',
    'message.edited',
    'message.deleted',
    'conversation.read',
    'conversation.added',
    'conversation.removed',
    'membership.ended',
  ] as const)
    bus.on(name, (payload) => {
      events.push({ name, payload: payload as Record<string, unknown> });
    });
});
afterEach(() => delivery.idle()); // no background delivery may run into the next test's cleanup
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  events.length = 0;
});

let counter = 0;
const ip = () => `10.7.${(counter >> 8) & 255}.${counter++ & 255}`;
const api = (userId: string) => {
  const base = (m: 'get' | 'post' | 'patch' | 'delete' | 'put', path: string) =>
    request(app.getHttpServer())
      [m](`/api/v1${path}`)
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', ip());
  return {
    get: (path: string) => base('get', path),
    post: (path: string, body: object = {}) => base('post', path).send(body),
    patch: (path: string, body: object = {}) => base('patch', path).send(body),
    put: (path: string, body: object = {}) => base('put', path).send(body),
    del: (path: string) => base('delete', path),
  };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (
  userId: string,
  conversationId: string,
  body = 'hello',
  clientId = randomUUID(),
) =>
  api(userId).post(`/conversations/${conversationId}/messages`, {
    body,
    clientId,
  });
const eventsOf = (name: string) => events.filter((e) => e.name === name);
const seqs = async (conversationId: string) =>
  (
    await pool.query<{ seq: number }>(
      'SELECT seq FROM messages WHERE conversation_id = $1 ORDER BY seq',
      [conversationId],
    )
  ).rows.map((r) => r.seq);
const lastSeq = async (conversationId: string) =>
  (
    await pool.query<{ last_seq: number }>(
      'SELECT last_seq FROM conversations WHERE id = $1',
      [conversationId],
    )
  ).rows[0].last_seq;

async function groupOf(memberCount = 2) {
  const [admin, ...members] = await Promise.all(
    Array.from({ length: memberCount + 1 }, () => createUser(pool)),
  );
  const id = await createGroup(
    pool,
    admin.id,
    members.map((m) => m.id),
  );
  return { admin, members, id };
}

async function course(
  status: 'PUBLISHED' | 'ARCHIVED' = 'PUBLISHED',
  extra: { lockedByAdminAt?: Date } = {},
) {
  const courseId = await createPublishedCourse(pool, {
    title: 'Chat course',
    ...(status === 'ARCHIVED' ? { status, archivedAt: new Date() } : {}),
    ...extra,
  });
  const [owner, assistant, student] = [
    await createTeacher(pool),
    await createTeacher(pool),
    await createUser(pool),
  ];
  await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
  await addCourseTeacher(pool, courseId, assistant.id, 'ASSISTANT', owner.id);
  await createEnrollment(pool, courseId, student.id);
  const channel = await transactions.run((tx) =>
    channels.createForCourse(tx, courseId),
  );
  return { courseId, owner, assistant, student, channel };
}

describe('sending', () => {
  it('stores the message, numbers it from 1, updates the conversation and queues one message.created after commit', async () => {
    const { admin, members, id } = await groupOf(1);
    const res = await send(members[0].id, id, '  Բարև 😀  ').expect(201);
    expect(res.body).toMatchObject({
      conversationId: id,
      seq: 1,
      body: 'Բարև 😀',
      deleted: false,
      editedAt: null,
      sender: { id: members[0].id },
    });
    expect(Object.keys(res.body).sort()).toEqual([
      'body',
      'clientId',
      'conversationId',
      'createdAt',
      'deleted',
      'editedAt',
      'id',
      'sender',
      'seq',
    ]);
    expect((await send(admin.id, id, 'second').expect(201)).body.seq).toBe(2);
    const row = (
      await pool.query(
        'SELECT last_seq, last_message_at FROM conversations WHERE id = $1',
        [id],
      )
    ).rows[0];
    expect(row.last_seq).toBe(2);
    expect(row.last_message_at).not.toBeNull();
    await sleep(80);
    expect(eventsOf('message.created').map((e) => e.payload.seq)).toEqual([
      1, 2,
    ]);
  });

  it('validates the text: trimmed, not empty, at most 2000 code points; other properties and a bad client id are 400', async () => {
    const { admin, id } = await groupOf(1);
    const url = `/conversations/${id}/messages`;
    await api(admin.id)
      .post(url, { body: '', clientId: randomUUID() })
      .expect(400);
    await api(admin.id)
      .post(url, { body: '   \n ', clientId: randomUUID() })
      .expect(400);
    await api(admin.id)
      .post(url, { body: 'x'.repeat(2001), clientId: randomUUID() })
      .expect(400);
    await api(admin.id).post(url, { body: 'x', clientId: 'nope' }).expect(400);
    await api(admin.id).post(url, { body: 'x' }).expect(400);
    await api(admin.id)
      .post(url, { body: 'x', clientId: randomUUID(), seq: 5 })
      .expect(400);
    await api(admin.id)
      .post(url, { body: 'x', clientId: randomUUID(), senderId: randomUUID() })
      .expect(400);
    await api(admin.id)
      .post(url, { body: '😀'.repeat(2000), clientId: randomUUID() })
      .expect(201);
    await api(admin.id)
      .post(url, {
        body: '<script>alert(1)</script> **not markdown**',
        clientId: randomUUID(),
      })
      .expect(201);
    expect(
      (
        await pool.query(
          "SELECT body FROM messages WHERE body LIKE '<script>%'",
        )
      ).rows[0].body,
    ).toBe('<script>alert(1)</script> **not markdown**');
  });

  it('sending the same client id and text again returns the SAME message: one row, no gap in seq, one event', async () => {
    const { admin, id } = await groupOf(1);
    const clientId = randomUUID();
    const first = (await send(admin.id, id, 'once', clientId).expect(201)).body;
    const again = (await send(admin.id, id, 'once', clientId).expect(201)).body;
    expect(again).toEqual(first);
    expect(await seqs(id)).toEqual([1]);
    expect(await lastSeq(id)).toBe(1);
    await sleep(80);
    expect(eventsOf('message.created')).toHaveLength(1);
    expect((await send(admin.id, id, 'next').expect(201)).body.seq).toBe(2);
  });

  it('a retry of a message that was already stored still returns it after the situation changed (course archived, block set)', async () => {
    const c = await course();
    const clientId = randomUUID();
    const first = (
      await send(c.student.id, c.channel, 'stored', clientId).expect(201)
    ).body;
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now() WHERE id = $1",
      [c.courseId],
    );
    expect(
      (await send(c.student.id, c.channel, 'stored', clientId).expect(201))
        .body,
    ).toEqual(first);
    expect(
      (
        await send(c.student.id, c.channel, 'new text', randomUUID()).expect(
          409,
        )
      ).body.code,
    ).toBe('COURSE_ARCHIVED');
    const [a, b] = [await createUser(pool), await createUser(pool)];
    const dm = await createDirectConversation(pool, a.id, b.id);
    const dmClientId = randomUUID();
    const sent = (await send(a.id, dm, 'before block', dmClientId).expect(201))
      .body;
    await blocks.block(b.id, a.id);
    expect(
      (await send(a.id, dm, 'before block', dmClientId).expect(201)).body,
    ).toEqual(sent);
    expect(await seqs(dm)).toEqual([1]);
  });

  it('ten identical sends at the same moment: one message, one event, seq has no gap', async () => {
    const { admin, id } = await groupOf(1);
    const clientId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => send(admin.id, id, 'same', clientId)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await seqs(id)).toEqual([1]);
    expect(await lastSeq(id)).toBe(1);
    await sleep(100);
    expect(eventsOf('message.created')).toHaveLength(1);
    expect((await send(admin.id, id, 'after').expect(201)).body.seq).toBe(2);
  });

  it('seq stays contiguous under parallel sends from several people (1..30, no gap, no tie)', async () => {
    const { admin, members, id } = await groupOf(2);
    const senders = [admin, ...members];
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        send(senders[i % 3].id, id, `m${i}`),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(30).fill(201));
    expect(await seqs(id)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(await lastSeq(id)).toBe(30);
    expect(new Set(results.map((r) => r.body.seq)).size).toBe(30);
  });

  it('the same client id with another text, or in another conversation, is 409 CLIENT_ID_REUSED and writes nothing', async () => {
    const { admin, id } = await groupOf(1);
    const other = await createGroup(pool, admin.id, []);
    const clientId = randomUUID();
    await send(admin.id, id, 'original', clientId).expect(201);
    expect(
      (await send(admin.id, id, 'different', clientId).expect(409)).body.code,
    ).toBe('CLIENT_ID_REUSED');
    expect(
      (await send(admin.id, other, 'original', clientId).expect(409)).body.code,
    ).toBe('CLIENT_ID_REUSED');
    expect(await seqs(other)).toEqual([]);
    expect(await lastSeq(other)).toBe(0);
    // the same client id from a DIFFERENT user is a different key
    const { members, id: id2 } = await groupOf(1);
    await send(members[0].id, id2, 'a', clientId).expect(201);
  });

  it('the same client id into two conversations at the same moment: exactly one is written, the other is 409', async () => {
    const { admin, id } = await groupOf(1);
    const other = await createGroup(pool, admin.id, []);
    const clientId = randomUUID();
    const results = await Promise.all([
      send(admin.id, id, 'x', clientId),
      send(admin.id, other, 'x', clientId),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(
      (
        await pool.query('SELECT 1 FROM messages WHERE client_id = $1', [
          clientId,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('a non-member and a former member can neither send, read, edit nor mark read (404)', async () => {
    const { admin, members, id } = await groupOf(2);
    const sent = (await send(admin.id, id, 'hi').expect(201)).body;
    const [outsider] = [await createUser(pool)];
    const former = members[0];
    await api(former.id).post(`/conversations/${id}/leave`).expect(204);
    for (const user of [outsider, former]) {
      await send(user.id, id).expect(404);
      await api(user.id).get(`/conversations/${id}/messages`).expect(404);
      await api(user.id)
        .patch(`/conversations/${id}/messages/${sent.id}`, { body: 'x' })
        .expect(404);
      await api(user.id)
        .del(`/conversations/${id}/messages/${sent.id}`)
        .expect(404);
      await api(user.id)
        .put(`/conversations/${id}/read`, { seq: 1 })
        .expect(404);
    }
    expect(await seqs(id)).toEqual([1]);
  });

  it('in a direct conversation a block (either direction, set after the DM existed) is 403 CANNOT_MESSAGE_USER, while the old history stays readable', async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    const dm = await createDirectConversation(pool, a.id, b.id);
    await send(a.id, dm, 'before the block').expect(201);
    await blocks.block(b.id, a.id);
    expect((await send(a.id, dm, 'blocked sender').expect(403)).body.code).toBe(
      'CANNOT_MESSAGE_USER',
    );
    expect(
      (await send(b.id, dm, 'the blocker too').expect(403)).body.code,
    ).toBe('CANNOT_MESSAGE_USER');
    expect(
      (await api(a.id).get(`/conversations/${dm}/messages`).expect(200)).body
        .items,
    ).toHaveLength(1);
    expect(await seqs(dm)).toEqual([1]);
    expect(await lastSeq(dm)).toBe(1);
    await blocks.unblock(b.id, a.id);
    await send(a.id, dm, 'after unblocking').expect(201);
  });

  it('a block does not stop talking in an existing shared group (Decision 84)', async () => {
    const { admin, members, id } = await groupOf(1);
    await blocks.block(members[0].id, admin.id);
    await send(admin.id, id, 'still here').expect(201);
    await send(members[0].id, id, 'me too').expect(201);
  });
});

describe('the message rate limit (Per-conversation burst, shared by REST and the socket)', () => {
  it('allows 30 messages in 10 seconds per user and conversation; the 31st is 429; another conversation has its own budget', async () => {
    const { admin, id } = await groupOf(1);
    const other = await createGroup(pool, admin.id, []);
    const results: number[] = [];
    for (let i = 0; i < 31; i++)
      results.push((await send(admin.id, id, `m${i}`)).status);
    expect(results.slice(0, 30)).toEqual(Array(30).fill(201));
    expect(results[30]).toBe(429);
    await send(admin.id, other, 'other conversation').expect(201);
    expect(await seqs(id)).toHaveLength(30);
  });
});

describe('history', () => {
  async function conversationWith(count: number) {
    const { admin, members, id } = await groupOf(1);
    for (let i = 1; i <= count; i++)
      await send(i % 2 ? admin.id : members[0].id, id, `message ${i}`).catch(
        () => undefined,
      );
    return { admin, member: members[0], id };
  }

  it('the newest page comes oldest first; before= pages backwards; hasMore says whether to continue', async () => {
    const { admin, id } = await groupOf(1);
    for (let i = 1; i <= 7; i++)
      await pool.query(
        'INSERT INTO messages (conversation_id, seq, sender_id, body, client_id) VALUES ($1, $2, $3, $4, $5)',
        [id, i, admin.id, `m${i}`, randomUUID()],
      );
    await pool.query('UPDATE conversations SET last_seq = 7 WHERE id = $1', [
      id,
    ]);
    const newest = (
      await api(admin.id)
        .get(`/conversations/${id}/messages?limit=3`)
        .expect(200)
    ).body;
    expect(newest.items.map((m: { seq: number }) => m.seq)).toEqual([5, 6, 7]);
    expect(newest.hasMore).toBe(true);
    const older = (
      await api(admin.id)
        .get(`/conversations/${id}/messages?limit=3&before=5`)
        .expect(200)
    ).body;
    expect(older.items.map((m: { seq: number }) => m.seq)).toEqual([2, 3, 4]);
    expect(older.hasMore).toBe(true);
    const oldest = (
      await api(admin.id)
        .get(`/conversations/${id}/messages?limit=3&before=2`)
        .expect(200)
    ).body;
    expect(oldest.items.map((m: { seq: number }) => m.seq)).toEqual([1]);
    expect(oldest.hasMore).toBe(false);
  });

  it('after= returns exactly the messages a client missed, oldest first, nothing else', async () => {
    const { admin, id } = await groupOf(1);
    for (let i = 1; i <= 10; i++)
      await pool.query(
        'INSERT INTO messages (conversation_id, seq, sender_id, body, client_id) VALUES ($1, $2, $3, $4, $5)',
        [id, i, admin.id, `m${i}`, randomUUID()],
      );
    const missed = (
      await api(admin.id)
        .get(`/conversations/${id}/messages?after=6`)
        .expect(200)
    ).body;
    expect(missed.items.map((m: { seq: number }) => m.seq)).toEqual([
      7, 8, 9, 10,
    ]);
    expect(missed.hasMore).toBe(false);
    const paged = (
      await api(admin.id)
        .get(`/conversations/${id}/messages?after=0&limit=4`)
        .expect(200)
    ).body;
    expect(paged.items.map((m: { seq: number }) => m.seq)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(paged.hasMore).toBe(true);
    expect(
      (
        await api(admin.id)
          .get(`/conversations/${id}/messages?after=10`)
          .expect(200)
      ).body.items,
    ).toEqual([]);
  });

  it('validates the cursors and the limit', async () => {
    const { admin, id } = await conversationWith(0);
    const url = `/conversations/${id}/messages`;
    await api(admin.id).get(`${url}?before=3&after=1`).expect(400);
    await api(admin.id).get(`${url}?before=0`).expect(400);
    await api(admin.id).get(`${url}?after=-1`).expect(400);
    await api(admin.id).get(`${url}?before=abc`).expect(400);
    await api(admin.id).get(`${url}?limit=0`).expect(400);
    await api(admin.id).get(`${url}?limit=101`).expect(400);
    await api(admin.id).get(`${url}?limit=100`).expect(200);
  });

  it('a returning member sees the whole history including what was written while away (Decision 29)', async () => {
    const { admin, members, id } = await groupOf(1);
    await send(admin.id, id, 'before').expect(201);
    await api(members[0].id).post(`/conversations/${id}/leave`).expect(204);
    await send(admin.id, id, 'while away').expect(201);
    await api(admin.id)
      .post(`/conversations/${id}/members`, { userIds: [members[0].id] })
      .expect(200);
    const history = (
      await api(members[0].id).get(`/conversations/${id}/messages`).expect(200)
    ).body;
    expect(history.items.map((m: { body: string }) => m.body)).toEqual([
      'before',
      'while away',
    ]);
    expect(
      (await api(members[0].id).get(`/conversations/${id}`).expect(200)).body
        .unreadCount,
    ).toBe(2); // nothing was ever read: both messages are unread
  });
});

describe('editing and deleting', () => {
  it('only the author edits; the edit sets edited_at and queues message.edited; the same text is a no-op', async () => {
    const { admin, members, id } = await groupOf(1);
    const message = (await send(members[0].id, id, 'typo').expect(201)).body;
    await api(admin.id)
      .patch(`/conversations/${id}/messages/${message.id}`, { body: 'hijack' })
      .expect(403);
    const edited = (
      await api(members[0].id)
        .patch(`/conversations/${id}/messages/${message.id}`, {
          body: ' fixed ',
        })
        .expect(200)
    ).body;
    expect(edited).toMatchObject({ body: 'fixed', seq: message.seq });
    expect(edited.editedAt).not.toBeNull();
    const again = (
      await api(members[0].id)
        .patch(`/conversations/${id}/messages/${message.id}`, { body: 'fixed' })
        .expect(200)
    ).body;
    expect(again.editedAt).toBe(edited.editedAt);
    await sleep(80);
    expect(eventsOf('message.edited')).toHaveLength(1);
    await api(members[0].id)
      .patch(`/conversations/${id}/messages/${message.id}`, { body: '' })
      .expect(400);
    await api(members[0].id)
      .patch(`/conversations/${id}/messages/${randomUUID()}`, { body: 'x' })
      .expect(404);
    expect(await seqs(id)).toEqual([1]); // an edit never creates a message
  });

  it('delete hides the text from the API but the row keeps it and its seq; editing it afterwards is 409; deleting twice is fine', async () => {
    const { admin, members, id } = await groupOf(1);
    const message = (await send(members[0].id, id, 'secret words').expect(201))
      .body;
    await api(admin.id)
      .del(`/conversations/${id}/messages/${message.id}`)
      .expect(403); // a group has no moderators
    await api(members[0].id)
      .del(`/conversations/${id}/messages/${message.id}`)
      .expect(204);
    await api(members[0].id)
      .del(`/conversations/${id}/messages/${message.id}`)
      .expect(204);
    const row = (
      await pool.query(
        'SELECT body, deleted_at, deleted_by, seq FROM messages WHERE id = $1',
        [message.id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      body: 'secret words',
      deleted_by: members[0].id,
      seq: 1,
    });
    expect(row.deleted_at).not.toBeNull();
    const history = (
      await api(admin.id).get(`/conversations/${id}/messages`).expect(200)
    ).body.items;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ seq: 1, body: null, deleted: true });
    expect(JSON.stringify(history)).not.toContain('secret words');
    expect(
      (
        await api(members[0].id)
          .patch(`/conversations/${id}/messages/${message.id}`, { body: 'x' })
          .expect(409)
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
    await sleep(80);
    expect(eventsOf('message.deleted')).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM audit_logs WHERE action = 'MESSAGE_DELETED_BY_MODERATOR'",
        )
      ).rowCount,
    ).toBe(0); // own deletion is not a moderation
  });

  it("in a course channel the Owner and Assistants delete anyone's message (audited); a student deletes only their own", async () => {
    const c = await course();
    const fromStudent = (
      await send(c.student.id, c.channel, 'rude words').expect(201)
    ).body;
    const fromOwner = (
      await send(c.owner.id, c.channel, 'announcement').expect(201)
    ).body;
    const other = await createUser(pool);
    await createEnrollment(pool, c.courseId, other.id);
    await transactions.run((tx) => channels.syncCourse(tx, c.courseId));
    await api(other.id)
      .del(`/conversations/${c.channel}/messages/${fromStudent.id}`)
      .expect(403);
    await api(c.student.id)
      .del(`/conversations/${c.channel}/messages/${fromOwner.id}`)
      .expect(403);
    await api(c.assistant.id)
      .del(`/conversations/${c.channel}/messages/${fromStudent.id}`)
      .expect(204);
    const audit = (
      await pool.query(
        "SELECT actor_id, target_type, target_id, metadata FROM audit_logs WHERE action = 'MESSAGE_DELETED_BY_MODERATOR'",
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: c.assistant.id,
      target_type: 'MESSAGE',
      target_id: fromStudent.id,
    });
    expect(audit[0].metadata).toMatchObject({
      conversationId: c.channel,
      courseId: c.courseId,
      authorId: c.student.id,
    });
    await api(c.student.id)
      .del(
        `/conversations/${c.channel}/messages/${(await send(c.student.id, c.channel, 'mine').expect(201)).body.id}`,
      )
      .expect(204);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM audit_logs WHERE action = 'MESSAGE_DELETED_BY_MODERATOR'",
        )
      ).rowCount,
    ).toBe(1);
  });

  it('an archived course makes its channel read-only (send and edit 409) but deleting stays allowed; an Admin lock gives COURSE_ADMIN_LOCKED', async () => {
    const c = await course();
    const message = (
      await send(c.student.id, c.channel, 'before archiving').expect(201)
    ).body;
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now() WHERE id = $1",
      [c.courseId],
    );
    expect(
      (await send(c.student.id, c.channel, 'too late').expect(409)).body.code,
    ).toBe('COURSE_ARCHIVED');
    expect(
      (await send(c.owner.id, c.channel, 'even the owner').expect(409)).body
        .code,
    ).toBe('COURSE_ARCHIVED');
    expect(
      (
        await api(c.student.id)
          .patch(`/conversations/${c.channel}/messages/${message.id}`, {
            body: 'edit',
          })
          .expect(409)
      ).body.code,
    ).toBe('COURSE_ARCHIVED');
    expect(
      (
        await api(c.student.id)
          .get(`/conversations/${c.channel}/messages`)
          .expect(200)
      ).body.items,
    ).toHaveLength(1);
    expect(await seqs(c.channel)).toEqual([1]);
    await pool.query(
      'UPDATE courses SET locked_by_admin_at = now() WHERE id = $1',
      [c.courseId],
    );
    expect(
      (await send(c.student.id, c.channel, 'locked').expect(409)).body.code,
    ).toBe('COURSE_ADMIN_LOCKED');
    await api(c.assistant.id)
      .del(`/conversations/${c.channel}/messages/${message.id}`)
      .expect(204); // moderation still possible
    await pool.query(
      "UPDATE courses SET locked_by_admin_at = NULL, status = 'PUBLISHED', archived_at = NULL WHERE id = $1",
      [c.courseId],
    );
    await send(c.student.id, c.channel, 'writable again').expect(201); // restoring makes it writable again
  });
});

describe('read positions and unread counts', () => {
  it('mark read moves forward only, never backwards, rejects a seq above last_seq, and tells my other devices', async () => {
    const { admin, members, id } = await groupOf(1);
    for (let i = 0; i < 5; i++) await send(admin.id, id, `m${i}`).expect(201);
    const me = members[0];
    const url = `/conversations/${id}/read`;
    expect((await api(me.id).put(url, { seq: 3 }).expect(200)).body).toEqual({
      lastReadSeq: 3,
    });
    expect((await api(me.id).put(url, { seq: 1 }).expect(200)).body).toEqual({
      lastReadSeq: 3,
    }); // never backwards
    expect((await api(me.id).put(url, { seq: 5 }).expect(200)).body).toEqual({
      lastReadSeq: 5,
    });
    expect(
      (await api(me.id).put(url, { seq: 6 }).expect(400)).body.errors[0].field,
    ).toBe('seq');
    await api(me.id).put(url, { seq: -1 }).expect(400);
    await api(me.id).put(url, { seq: 'x' }).expect(400);
    await api(me.id).put(url, {}).expect(400);
    expect(
      (
        await pool.query(
          'SELECT last_read_seq FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
          [id, me.id],
        )
      ).rows[0].last_read_seq,
    ).toBe(5);
    await sleep(80);
    expect(eventsOf('conversation.read').map((e) => e.payload)).toContainEqual({
      conversationId: id,
      userId: me.id,
      lastReadSeq: 5,
    });
  });

  it('parallel mark-reads end at the highest value', async () => {
    const { admin, members, id } = await groupOf(1);
    for (let i = 0; i < 8; i++) await send(admin.id, id, `m${i}`).expect(201);
    await Promise.all(
      [2, 8, 5, 3, 7, 1, 6, 4].map((seq) =>
        api(members[0].id).put(`/conversations/${id}/read`, { seq }),
      ),
    );
    expect(
      (
        await pool.query(
          'SELECT last_read_seq FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
          [id, members[0].id],
        )
      ).rows[0].last_read_seq,
    ).toBe(8);
  });

  it('unread excludes my own messages and deleted ones, and goes to zero after reading', async () => {
    const { admin, members, id } = await groupOf(1);
    const me = members[0];
    await send(admin.id, id, 'one').expect(201);
    await send(me.id, id, 'mine').expect(201);
    const gone = (await send(admin.id, id, 'deleted soon').expect(201)).body;
    await send(admin.id, id, 'four').expect(201);
    await api(admin.id)
      .del(`/conversations/${id}/messages/${gone.id}`)
      .expect(204);
    expect(
      (await api(me.id).get(`/conversations/${id}`).expect(200)).body
        .unreadCount,
    ).toBe(2);
    expect(
      (await api(admin.id).get(`/conversations/${id}`).expect(200)).body
        .unreadCount,
    ).toBe(1); // only 'mine'
    await api(me.id).put(`/conversations/${id}/read`, { seq: 4 }).expect(200);
    expect(
      (await api(me.id).get('/me/conversations').expect(200)).body.items[0]
        .unreadCount,
    ).toBe(0);
  });
});

describe('CourseChannelService', () => {
  it('createForCourse makes one channel with the Owner, the Assistants and the ACTIVE students; a second call changes nothing', async () => {
    const courseId = await createPublishedCourse(pool);
    const [owner, assistant, active, pending, left] = [
      await createTeacher(pool),
      await createTeacher(pool),
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    await addCourseTeacher(pool, courseId, assistant.id, 'ASSISTANT', owner.id);
    await createEnrollment(pool, courseId, active.id);
    await createEnrollment(pool, courseId, pending.id, { status: 'PENDING' });
    await createEnrollment(pool, courseId, left.id, {
      status: 'LEFT',
      leftAt: new Date(),
    });
    const first = await transactions.run((tx) =>
      channels.createForCourse(tx, courseId),
    );
    const second = await transactions.run((tx) =>
      channels.createForCourse(tx, courseId),
    );
    expect(second).toBe(first);
    expect(
      (
        await pool.query('SELECT 1 FROM conversations WHERE course_id = $1', [
          courseId,
        ])
      ).rowCount,
    ).toBe(1);
    const members = (
      await pool.query<{ user_id: string }>(
        'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL',
        [first],
      )
    ).rows
      .map((r) => r.user_id)
      .sort();
    expect(members).toEqual([owner.id, assistant.id, active.id].sort());
  });

  it('addMember and endMembership are idempotent and do nothing for a course without a channel', async () => {
    const courseId = await createPublishedCourse(pool);
    const user = await createUser(pool);
    expect(
      await transactions.run((tx) => channels.addMember(tx, courseId, user.id)),
    ).toBe(false);
    expect(
      await transactions.run((tx) =>
        channels.endMembership(tx, courseId, user.id),
      ),
    ).toBe(false);
    expect(
      await transactions.run((tx) => channels.syncCourse(tx, courseId)),
    ).toEqual({ added: 0, removed: 0 });
    expect(
      (await pool.query('SELECT 1 FROM conversation_members')).rowCount,
    ).toBe(0);
    const c = await course();
    const newcomer = await createUser(pool);
    expect(
      await transactions.run((tx) =>
        channels.addMember(tx, c.courseId, newcomer.id),
      ),
    ).toBe(true);
    expect(
      await transactions.run((tx) =>
        channels.addMember(tx, c.courseId, newcomer.id),
      ),
    ).toBe(false);
    expect(
      await transactions.run((tx) =>
        channels.endMembership(tx, c.courseId, newcomer.id),
      ),
    ).toBe(true);
    expect(
      await transactions.run((tx) =>
        channels.endMembership(tx, c.courseId, newcomer.id),
      ),
    ).toBe(false);
    await sleep(80);
    expect(
      eventsOf('conversation.removed').map((e) => e.payload.userId),
    ).toContain(newcomer.id);
    expect(eventsOf('membership.ended').map((e) => e.payload.userId)).toContain(
      newcomer.id,
    );
  });

  it('a student who left and returns reuses their row, sees the whole history, and the missed messages are unread', async () => {
    const c = await course();
    await send(c.owner.id, c.channel, 'before').expect(201);
    await transactions.run((tx) =>
      channels.endMembership(tx, c.courseId, c.student.id),
    );
    await api(c.student.id).get(`/conversations/${c.channel}`).expect(404);
    await send(c.owner.id, c.channel, 'while away').expect(201);
    await transactions.run((tx) =>
      channels.addMember(tx, c.courseId, c.student.id),
    );
    expect(
      (
        await pool.query(
          'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
          [c.channel, c.student.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await api(c.student.id)
          .get(`/conversations/${c.channel}/messages`)
          .expect(200)
      ).body.items.map((m: { body: string }) => m.body),
    ).toEqual(['before', 'while away']);
    expect(
      (await api(c.student.id).get(`/conversations/${c.channel}`).expect(200))
        .body.unreadCount,
    ).toBe(2);
  });

  it('syncCourse repairs a missing member, a stray member, a LEFT student and a removed Assistant, and leaves correct state untouched', async () => {
    const c = await course();
    const [stray, leaver] = [await createUser(pool), await createUser(pool)];
    const enrollment = await createEnrollment(pool, c.courseId, leaver.id);
    await transactions.run((tx) => channels.syncCourse(tx, c.courseId));
    const state = async () =>
      (
        await pool.query(
          'SELECT user_id, left_at, joined_at FROM conversation_members WHERE conversation_id = $1 ORDER BY user_id',
          [c.channel],
        )
      ).rows;
    const correct = await state();
    expect(
      await transactions.run((tx) => channels.syncCourse(tx, c.courseId)),
    ).toEqual({ added: 0, removed: 0 });
    expect(await state()).toEqual(correct); // nothing was touched
    // damage: a student's row deleted, a stranger added, a student left but is still a member, an Assistant removed from the course
    await pool.query(
      'DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [c.channel, c.student.id],
    );
    await pool.query(
      'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)',
      [c.channel, stray.id],
    );
    await pool.query(
      "UPDATE enrollments SET status = 'LEFT', left_at = now() WHERE id = $1",
      [enrollment],
    );
    await pool.query(
      'DELETE FROM course_teachers WHERE course_id = $1 AND user_id = $2',
      [c.courseId, c.assistant.id],
    );
    const repaired = await transactions.run((tx) =>
      channels.syncCourse(tx, c.courseId),
    );
    expect(repaired).toEqual({ added: 1, removed: 3 });
    const active = (
      await pool.query<{ user_id: string }>(
        'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL',
        [c.channel],
      )
    ).rows
      .map((r) => r.user_id)
      .sort();
    expect(active).toEqual([c.owner.id, c.student.id].sort());
    expect(
      await transactions.run((tx) => channels.syncCourse(tx, c.courseId)),
    ).toEqual({ added: 0, removed: 0 });
  });

  it('reconcileAll repairs every course with a channel and reports what it did; the second run does nothing', async () => {
    const [a, b] = [await course(), await course()];
    await pool.query(
      'DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [a.channel, a.student.id],
    );
    await pool.query(
      'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)',
      [b.channel, (await createUser(pool)).id],
    );
    expect(await channels.reconcileAll()).toEqual({
      courses: 2,
      added: 1,
      removed: 1,
    });
    expect(await channels.reconcileAll()).toEqual({
      courses: 2,
      added: 0,
      removed: 0,
    });
  });

  it('channel sends need membership: an ACTIVE student whose row is missing cannot send until synced', async () => {
    const c = await course();
    await pool.query(
      'DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [c.channel, c.student.id],
    );
    await send(c.student.id, c.channel).expect(404);
    await transactions.run((tx) => channels.syncCourse(tx, c.courseId));
    await send(c.student.id, c.channel).expect(201);
  });

  it('the channel factory and the service agree: one channel per course even when created at the same moment', async () => {
    const courseId = await createPublishedCourse(pool);
    const owner = await createTeacher(pool);
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    const ids = await Promise.all(
      [1, 2, 3].map(() =>
        transactions.run((tx) => channels.createForCourse(tx, courseId)),
      ),
    );
    expect(new Set(ids).size).toBe(1);
  });
});
