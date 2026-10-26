// M10c step 3: the chat on the Socket.IO server with real clients against the real database (Decisions 154-158).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import {
  DatabaseModule,
  TransactionService,
} from '../../src/infrastructure/database/index.js';
import { EventsModule } from '../../src/infrastructure/events/index.js';
import {
  ChatModule,
  CourseChannelService,
  PresenceService,
} from '../../src/modules/chat/index.js';
import { TypingService } from '../../src/modules/chat/services/typing.service.js';
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
import {
  TEST_JWT_SECRET,
  bearer,
  testEnv,
} from '../support/integration-app.js';
import { mintAccessToken } from '../support/token-minter.js';

const pool = createPool(25);
let app: NestExpressApplication;
let delivery: ChatDeliveryService;
let port: number;
let presence: PresenceService;
let typing: TypingService;
let blocks: BlockService;
let channels: CourseChannelService;
let transactions: TransactionService;

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
  await app.listen(0);
  delivery = app.get(ChatDeliveryService, { strict: false });
  port = (app.getHttpServer().address() as AddressInfo).port;
  presence = app.get(PresenceService);
  typing = app.get(TypingService, { strict: false });
  blocks = app.get(BlockService, { strict: false });
  channels = app.get(CourseChannelService);
  transactions = app.get(TransactionService);
  presence.debounceMs = 150;
  typing.expiryMs = 150;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => resetData(pool));
const opened: Socket[] = [];
afterEach(async () => {
  for (const socket of opened.splice(0)) socket.close();
  await delivery.idle(); // no background database work may run into the next test's cleanup
});

let counter = 0;
const ip = () => `10.8.${(counter >> 8) & 255}.${counter++ & 255}`;
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

function connect(userId: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://localhost:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: mintAccessToken(userId, { secret: TEST_JWT_SECRET }) },
      extraHeaders: { Origin: 'http://localhost:3001' },
    });
    opened.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}
/** Records every `event` the socket receives from now on. */
function record<T = unknown>(socket: Socket, event: string): T[] {
  const received: T[] = [];
  socket.on(event, (payload: T) => received.push(payload));
  return received;
}
const next = <T>(socket: Socket, event: string, ms = 2500) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no "${event}" within ${ms} ms`)),
      ms,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
const ack = <T = Record<string, unknown>>(
  socket: Socket,
  event: string,
  payload?: unknown,
) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ack for "${event}"`)),
      2500,
    );
    socket.emit(event, payload, (response: T) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
interface Ack {
  ok: boolean;
  statusCode?: number;
  code?: string;
  message?: unknown;
  online?: string[];
  [key: string]: unknown;
}
const sendOverSocket = (
  socket: Socket,
  conversationId: string,
  body = 'hi',
  clientId: string = randomUUID(),
) => ack<Ack>(socket, 'message:send', { conversationId, body, clientId });
const sendOverRest = (
  userId: string,
  conversationId: string,
  body = 'hi',
  clientId: string = randomUUID(),
) =>
  api(userId).post(`/conversations/${conversationId}/messages`, {
    body,
    clientId,
  });
const users = (n: number) =>
  Promise.all(Array.from({ length: n }, () => createUser(pool)));

describe('message:send and message:new', () => {
  it("acknowledges with the message; every member's sockets (also the sender's other device) get message:new in the REST shape; outsiders get nothing", async () => {
    const [a, b, outsider] = await users(3);
    const id = await createGroup(pool, a.id, [b.id]);
    const [senderPhone, senderLaptop, receiver, stranger] = await Promise.all([
      connect(a.id),
      connect(a.id),
      connect(b.id),
      connect(outsider.id),
    ]);
    const onLaptop = next<Record<string, unknown>>(senderLaptop, 'message:new');
    const onReceiver = next<Record<string, unknown>>(receiver, 'message:new');
    const leaked = record(stranger, 'message:new');
    const response = await sendOverSocket(senderPhone, id, ' Բարև 😀 ');
    expect(response.ok).toBe(true);
    const message = response.message as Record<string, unknown>;
    expect(message).toMatchObject({
      conversationId: id,
      seq: 1,
      body: 'Բարև 😀',
    });
    const [laptopCopy, receiverCopy] = await Promise.all([
      onLaptop,
      onReceiver,
    ]);
    const rest = (
      await api(b.id).get(`/conversations/${id}/messages`).expect(200)
    ).body.items[0];
    expect(receiverCopy).toEqual(rest);
    expect(laptopCopy).toEqual(rest);
    expect(message).toEqual(rest);
    await sleep(150);
    expect(leaked).toEqual([]);
  });

  it('a REST send is delivered over the socket too', async () => {
    const [a, b] = await users(2);
    const id = await createGroup(pool, a.id, [b.id]);
    const receiver = await connect(b.id);
    const arrived = next<{ body: string; seq: number }>(
      receiver,
      'message:new',
    );
    await sendOverRest(a.id, id, 'via REST').expect(201);
    expect(await arrived).toMatchObject({ body: 'via REST', seq: 1 });
  });

  it('a member removed a moment ago stops receiving message:new immediately; the others still do', async () => {
    const [admin, stays, removed] = await users(3);
    const id = await createGroup(pool, admin.id, [stays.id, removed.id]);
    const [sock, stayer, leaver] = await Promise.all([
      connect(admin.id),
      connect(stays.id),
      connect(removed.id),
    ]);
    const before = next(leaver, 'message:new');
    await sendOverSocket(sock, id, 'one');
    await before;
    await api(admin.id)
      .del(`/conversations/${id}/members/${removed.id}`)
      .expect(204);
    const missed = record(leaver, 'message:new');
    const kept = next<{ body: string }>(stayer, 'message:new');
    await sendOverSocket(sock, id, 'two');
    expect((await kept).body).toBe('two');
    await sleep(150);
    expect(missed).toEqual([]);
  });

  it('a suspended member is skipped by delivery', async () => {
    const [admin, suspended] = await users(2);
    const id = await createGroup(pool, admin.id, [suspended.id]);
    const [sock, other] = await Promise.all([
      connect(admin.id),
      connect(suspended.id),
    ]);
    await pool.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [
      suspended.id,
    ]);
    const received = record(other, 'message:new');
    await sendOverSocket(sock, id, 'hello');
    await sleep(200);
    expect(received).toEqual([]);
  });

  it('the same client id sent twice over the socket: one message, one message:new, the same message in both acks', async () => {
    const [a, b] = await users(2);
    const id = await createGroup(pool, a.id, [b.id]);
    const [sender, receiver] = await Promise.all([
      connect(a.id),
      connect(b.id),
    ]);
    const received = record<{ id: string }>(receiver, 'message:new');
    const clientId = randomUUID();
    const first = await sendOverSocket(sender, id, 'once', clientId);
    const second = await sendOverSocket(sender, id, 'once', clientId);
    expect(first.ok && second.ok).toBe(true);
    expect((first.message as { id: string }).id).toBe(
      (second.message as { id: string }).id,
    );
    await sleep(250);
    expect(received).toHaveLength(1);
    expect(
      (
        await pool.query('SELECT 1 FROM messages WHERE conversation_id = $1', [
          id,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('REST and the socket answer the same errors for the same mistakes', async () => {
    const [a, b, outsider] = await users(3);
    const group = await createGroup(pool, a.id, [b.id]);
    const dm = await createDirectConversation(pool, a.id, b.id);
    await blocks.block(b.id, a.id);
    const courseId = await createPublishedCourse(pool, {
      status: 'ARCHIVED',
      archivedAt: new Date(),
    });
    const owner = await createTeacher(pool);
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    const channel = await transactions.run((tx) =>
      channels.createForCourse(tx, courseId),
    );
    const reused = randomUUID();
    await sendOverRest(a.id, group, 'original', reused).expect(201);
    const scenarios: [string, string, string, string, string][] = [
      ['a non-member', outsider.id, group, 'hi', randomUUID()],
      ['a block in a direct conversation', a.id, dm, 'hi', randomUUID()],
      ['an archived course channel', owner.id, channel, 'hi', randomUUID()],
      ['a reused client id', a.id, group, 'different text', reused],
      ['an unknown conversation', a.id, randomUUID(), 'hi', randomUUID()],
    ];
    for (const [name, userId, conversationId, body, clientId] of scenarios) {
      const rest = await sendOverRest(userId, conversationId, body, clientId);
      const socket = await connect(userId);
      const over = await sendOverSocket(socket, conversationId, body, clientId);
      expect([name, over.ok, over.code, over.statusCode]).toEqual([
        name,
        false,
        rest.body.code,
        rest.status,
      ]);
      expect(over.message).toBe(rest.body.message);
    }
    // validation: the same fields fail on both transports
    const socket = await connect(a.id);
    const tooLong = await sendOverSocket(socket, group, 'x'.repeat(2001));
    const restLong = await sendOverRest(a.id, group, 'x'.repeat(2001));
    expect([tooLong.ok, tooLong.code, tooLong.statusCode]).toEqual([
      false,
      restLong.body.code,
      restLong.status,
    ]);
    const malformed = await ack<Ack>(socket, 'message:send', {
      conversationId: 'nope',
      body: 'x',
      clientId: randomUUID(),
    });
    expect([malformed.ok, malformed.statusCode, malformed.code]).toEqual([
      false,
      400,
      'VALIDATION_FAILED',
    ]);
    const extra = await ack<Ack>(socket, 'message:send', {
      conversationId: group,
      body: 'x',
      clientId: randomUUID(),
      seq: 99,
    });
    expect([extra.ok, extra.statusCode]).toEqual([false, 400]);
  });

  it('one rate-limit budget per user and conversation across REST and the socket: 15 + 15 pass, the 31st (either way) is 429', async () => {
    const [a, b] = await users(2);
    const id = await createGroup(pool, a.id, [b.id]);
    const socket = await connect(a.id);
    for (let i = 0; i < 15; i++)
      await sendOverRest(a.id, id, `r${i}`).expect(201);
    for (let i = 0; i < 15; i++)
      expect((await sendOverSocket(socket, id, `s${i}`)).ok).toBe(true);
    const overSocket = await sendOverSocket(socket, id, 'one too many');
    expect([overSocket.ok, overSocket.statusCode, overSocket.code]).toEqual([
      false,
      429,
      'TOO_MANY_REQUESTS',
    ]);
    await sendOverRest(a.id, id, 'one too many').expect(429);
    const other = await createGroup(pool, a.id, []);
    expect((await sendOverSocket(socket, other)).ok).toBe(true);
  });

  it('a user suspended after connecting is refused on the next event (per-event re-check)', async () => {
    const [a, b] = await users(2);
    const id = await createGroup(pool, a.id, [b.id]);
    const socket = await connect(a.id);
    expect((await sendOverSocket(socket, id)).ok).toBe(true);
    await pool.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [
      a.id,
    ]);
    const refused = await sendOverSocket(socket, id);
    expect([refused.ok, refused.statusCode, refused.code]).toEqual([
      false,
      403,
      'ACCOUNT_SUSPENDED',
    ]);
    expect(
      (
        await pool.query('SELECT 1 FROM messages WHERE conversation_id = $1', [
          id,
        ])
      ).rowCount,
    ).toBe(1);
  });
});

describe('edits, deletes and conversation events', () => {
  it('message:edited and message:deleted reach every member (a deleted message arrives without text)', async () => {
    const [a, b] = await users(2);
    const id = await createGroup(pool, a.id, [b.id]);
    const receiver = await connect(b.id);
    const message = (await sendOverRest(a.id, id, 'draft').expect(201)).body;
    const edited = next<{ body: string; editedAt: string }>(
      receiver,
      'message:edited',
    );
    await api(a.id)
      .patch(`/conversations/${id}/messages/${message.id}`, { body: 'final' })
      .expect(200);
    expect(await edited).toMatchObject({ id: message.id, body: 'final' });
    const deleted = next<{ body: string | null; deleted: boolean }>(
      receiver,
      'message:deleted',
    );
    await api(a.id)
      .del(`/conversations/${id}/messages/${message.id}`)
      .expect(204);
    expect(await deleted).toMatchObject({
      id: message.id,
      body: null,
      deleted: true,
    });
  });

  it('conversation:added goes to the new members, :removed to the removed one, :updated to the members, :read only to my own devices', async () => {
    const [admin, member, newcomer] = await users(3);
    const added = next<{ type: string; title: string }>(
      await connect(member.id),
      'conversation:added',
    );
    const id = (
      await api(admin.id)
        .post('/conversations/groups', {
          title: 'Study',
          memberIds: [member.id],
        })
        .expect(201)
    ).body.id;
    expect(await added).toMatchObject({ type: 'GROUP', title: 'Study' });

    const [adminSock, memberSock, newcomerSock] = await Promise.all([
      connect(admin.id),
      connect(member.id),
      connect(newcomer.id),
    ]);
    const newcomerAdded = next<{ id: string; myRole: string }>(
      newcomerSock,
      'conversation:added',
    );
    const memberUpdated = next<{ memberCount: number }>(
      memberSock,
      'conversation:updated',
    );
    const newcomerUpdated = next(newcomerSock, 'conversation:updated');
    await api(admin.id)
      .post(`/conversations/${id}/members`, { userIds: [newcomer.id] })
      .expect(200);
    expect(await newcomerAdded).toMatchObject({ id, myRole: 'MEMBER' });
    expect((await memberUpdated).memberCount).toBe(3);
    await newcomerUpdated; // the "members changed" update reaches the newcomer too; wait for it so it is not mistaken for the rename

    const renamed = next<{ title: string }>(
      newcomerSock,
      'conversation:updated',
    );
    await api(admin.id)
      .patch(`/conversations/${id}`, { title: 'Renamed' })
      .expect(200);
    expect((await renamed).title).toBe('Renamed');

    const removed = next<{ conversationId: string }>(
      newcomerSock,
      'conversation:removed',
    );
    await api(admin.id)
      .del(`/conversations/${id}/members/${newcomer.id}`)
      .expect(204);
    expect(await removed).toEqual({ conversationId: id });

    await sendOverRest(admin.id, id, 'x').expect(201);
    const mine = record(adminSock, 'conversation:read');
    const theirs = record(memberSock, 'conversation:read');
    const otherDevice = await connect(admin.id);
    const onOtherDevice = next<{ conversationId: string; lastReadSeq: number }>(
      otherDevice,
      'conversation:read',
    );
    await api(admin.id)
      .put(`/conversations/${id}/read`, { seq: 1 })
      .expect(200);
    expect(await onOtherDevice).toEqual({ conversationId: id, lastReadSeq: 1 });
    await sleep(150);
    expect(mine).toHaveLength(1);
    expect(theirs).toEqual([]);
  });

  it('a course channel member added or ended by the service is told (conversation:added / conversation:removed)', async () => {
    const courseId = await createPublishedCourse(pool);
    const owner = await createTeacher(pool);
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    const student = await createUser(pool);
    await createEnrollment(pool, courseId, student.id);
    const socket = await connect(student.id);
    const added = next<{ type: string }>(socket, 'conversation:added');
    await transactions.run((tx) => channels.createForCourse(tx, courseId));
    expect((await added).type).toBe('COURSE_CHANNEL');
    const removed = next(socket, 'conversation:removed');
    await transactions.run((tx) =>
      channels.endMembership(tx, courseId, student.id),
    );
    await removed;
  });
});

describe('typing', () => {
  it('a member typing is shown to the other members, expires by itself, and stop clears it at once', async () => {
    const [a, b] = await users(2);
    const id = await createGroup(pool, a.id, [b.id]);
    const [typist, watcher] = await Promise.all([connect(a.id), connect(b.id)]);
    const events = record<{
      conversationId: string;
      userId: string;
      isTyping: boolean;
    }>(watcher, 'typing');
    const own = record(typist, 'typing');
    expect(
      await ack<Ack>(typist, 'typing:start', { conversationId: id }),
    ).toEqual({ ok: true });
    await sleep(60);
    expect(events).toEqual([
      { conversationId: id, userId: a.id, isTyping: true },
    ]);
    await sleep(250); // the 150 ms test expiry
    expect(events.at(-1)).toEqual({
      conversationId: id,
      userId: a.id,
      isTyping: false,
    });
    await ack<Ack>(typist, 'typing:start', { conversationId: id });
    await ack<Ack>(typist, 'typing:stop', { conversationId: id });
    await sleep(60);
    expect(events.slice(-2).map((e) => e.isTyping)).toEqual([true, false]);
    await sleep(250);
    expect(events).toHaveLength(4); // no extra "false" from the cleared timer
    expect(own).toEqual([]); // you do not see your own typing
  });

  it('forged typing is ignored: a non-member is refused and nobody is told', async () => {
    const [a, b, intruder] = await users(3);
    const id = await createGroup(pool, a.id, [b.id]);
    const [watcher, forger] = await Promise.all([
      connect(b.id),
      connect(intruder.id),
    ]);
    const seen = record(watcher, 'typing');
    const response = await ack<Ack>(forger, 'typing:start', {
      conversationId: id,
    });
    expect([response.ok, response.statusCode, response.code]).toEqual([
      false,
      404,
      'NOT_FOUND',
    ]);
    expect(
      (await ack<Ack>(forger, 'typing:start', { conversationId: randomUUID() }))
        .ok,
    ).toBe(false);
    expect(
      (await ack<Ack>(forger, 'typing:start', { conversationId: 'nope' }))
        .statusCode,
    ).toBe(400);
    await sleep(200);
    expect(seen).toEqual([]);
  });

  it('there is no typing in a course channel, and a former member cannot type', async () => {
    const courseId = await createPublishedCourse(pool);
    const [owner, student] = [
      await createTeacher(pool),
      await createUser(pool),
    ];
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    await createEnrollment(pool, courseId, student.id);
    const channel = await transactions.run((tx) =>
      channels.createForCourse(tx, courseId),
    );
    const [ownerSock, studentSock] = await Promise.all([
      connect(owner.id),
      connect(student.id),
    ]);
    const seen = record(ownerSock, 'typing');
    expect(
      (await ack<Ack>(studentSock, 'typing:start', { conversationId: channel }))
        .ok,
    ).toBe(false);
    const [a, b] = await users(2);
    const id = await createGroup(pool, a.id, [b.id]);
    const leaver = await connect(b.id);
    await api(b.id).post(`/conversations/${id}/leave`).expect(204);
    expect(
      (await ack<Ack>(leaver, 'typing:start', { conversationId: id })).ok,
    ).toBe(false);
    await sleep(120);
    expect(seen).toEqual([]);
  });

  it('typing is rate limited with the same per-conversation budget (30 in 10 seconds)', async () => {
    const [a, b] = await users(2);
    const id = await createGroup(pool, a.id, [b.id]);
    const socket = await connect(a.id);
    const answers: Ack[] = [];
    for (let i = 0; i < 31; i++)
      answers.push(
        await ack<Ack>(socket, 'typing:start', { conversationId: id }),
      );
    expect(answers.slice(0, 30).every((r) => r.ok)).toBe(true);
    expect([answers[30].ok, answers[30].statusCode]).toEqual([false, 429]);
  });
});

describe('presence', () => {
  const updates = (socket: Socket) =>
    record<{ userId: string; online: boolean }>(socket, 'presence:update');

  it('subscribe answers who is online now; updates arrive only after subscribing, only for peers', async () => {
    const [a, b, stranger] = await users(3);
    await createGroup(pool, a.id, [b.id]);
    const watcher = await connect(a.id);
    expect(await ack<Ack>(watcher, 'presence:subscribe')).toEqual({
      ok: true,
      online: [],
    });
    const seen = updates(watcher);
    const strangerSock = await connect(stranger.id);
    const peerSock = await connect(b.id);
    await sleep(200);
    expect(seen).toEqual([{ userId: b.id, online: true }]);
    expect(await ack<Ack>(watcher, 'presence:subscribe')).toEqual({
      ok: true,
      online: [b.id],
    });
    expect((await api(a.id).get('/me/presence').expect(200)).body).toEqual({
      online: [b.id],
    });
    expect(
      (await api(stranger.id).get('/me/presence').expect(200)).body,
    ).toEqual({ online: [] });
    const strangerSeen = updates(strangerSock);
    peerSock.close();
    await sleep(100);
    expect(strangerSeen).toEqual([]);
  });

  it('online while any socket is connected: closing one of two changes nothing; closing the last goes offline after the debounce', async () => {
    const [a, b] = await users(2);
    await createGroup(pool, a.id, [b.id]);
    const watcher = await connect(a.id);
    await ack<Ack>(watcher, 'presence:subscribe');
    const seen = updates(watcher);
    const [phone, laptop] = await Promise.all([connect(b.id), connect(b.id)]);
    await sleep(150);
    expect(seen).toEqual([{ userId: b.id, online: true }]); // one "online", not two
    phone.close();
    await sleep(400);
    expect(seen).toHaveLength(1);
    expect(
      (await api(a.id).get('/me/presence').expect(200)).body.online,
    ).toEqual([b.id]);
    laptop.close();
    await sleep(60);
    expect(seen).toHaveLength(1); // still inside the debounce
    await sleep(350);
    expect(seen.at(-1)).toEqual({ userId: b.id, online: false });
    expect(
      (await api(a.id).get('/me/presence').expect(200)).body.online,
    ).toEqual([]);
  });

  it('reconnecting inside the debounce never shows offline', async () => {
    const [a, b] = await users(2);
    await createGroup(pool, a.id, [b.id]);
    const watcher = await connect(a.id);
    await ack<Ack>(watcher, 'presence:subscribe');
    const first = await connect(b.id);
    await sleep(150);
    const seen = updates(watcher);
    first.close();
    await sleep(40);
    await connect(b.id);
    await sleep(400);
    expect(seen).toEqual([]);
    expect(presence.isOnline(b.id)).toBe(true);
  });

  it('last_seen_at is written when the last socket closes and is exposed by no endpoint', async () => {
    const [a, b] = await users(2);
    await createGroup(pool, a.id, [b.id]);
    const socket = await connect(b.id);
    expect(
      (await pool.query('SELECT last_seen_at FROM users WHERE id = $1', [b.id]))
        .rows[0].last_seen_at,
    ).toBeNull();
    socket.close();
    await sleep(300);
    expect(
      (await pool.query('SELECT last_seen_at FROM users WHERE id = $1', [b.id]))
        .rows[0].last_seen_at,
    ).not.toBeNull();
    for (const path of [
      '/me/presence',
      `/conversations`,
      '/me/conversations',
    ]) {
      const res = await api(a.id).get(path);
      expect(JSON.stringify(res.body)).not.toMatch(/last_?seen/i);
    }
    const members = await createGroup(pool, a.id, [b.id]);
    expect(
      JSON.stringify(
        (await api(a.id).get(`/conversations/${members}/members`).expect(200))
          .body,
      ),
    ).not.toMatch(/last_?seen/i);
    expect(
      JSON.stringify(
        (await api(a.id).get(`/conversations/${members}`).expect(200)).body,
      ),
    ).not.toMatch(/last_?seen/i);
  });

  it('blocked pairs are hidden from each other everywhere: updates, the subscribe answer and GET /me/presence', async () => {
    const [a, b, c] = await users(3);
    await createGroup(pool, a.id, [b.id, c.id]);
    await blocks.block(a.id, b.id);
    const watcher = await connect(a.id);
    const seen = updates(watcher);
    await ack<Ack>(watcher, 'presence:subscribe');
    const bSock = await connect(b.id);
    const cSock = await connect(c.id);
    await sleep(250);
    expect(seen).toEqual([{ userId: c.id, online: true }]); // b is hidden from the blocker
    expect((await ack<Ack>(watcher, 'presence:subscribe')).online).toEqual([
      c.id,
    ]);
    expect(
      (await api(a.id).get('/me/presence').expect(200)).body.online,
    ).toEqual([c.id]);
    await ack<Ack>(bSock, 'presence:subscribe');
    expect(
      (await api(b.id).get('/me/presence').expect(200)).body.online,
    ).toEqual([c.id]); // and the blocker is hidden from b
    cSock.close();
    expect(presence.isOnline(a.id)).toBe(true);
  });

  it('a course channel is not a presence group: students of one course do not see each other online', async () => {
    const courseId = await createPublishedCourse(pool);
    const [owner, s1, s2] = [
      await createTeacher(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    await createEnrollment(pool, courseId, s1.id);
    await createEnrollment(pool, courseId, s2.id);
    await transactions.run((tx) => channels.createForCourse(tx, courseId));
    const one = await connect(s1.id);
    await ack<Ack>(one, 'presence:subscribe');
    const seen = updates(one);
    await connect(s2.id);
    await sleep(200);
    expect(seen).toEqual([]);
    expect(
      (await api(s1.id).get('/me/presence').expect(200)).body.online,
    ).toEqual([]);
  });

  it('a suspended peer is not shown, and the direct-conversation partner counts as a peer', async () => {
    const [a, b, gone] = await users(3);
    await createDirectConversation(pool, a.id, b.id);
    await createGroup(pool, a.id, [gone.id]);
    await connect(b.id);
    await connect(gone.id);
    await pool.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [
      gone.id,
    ]);
    expect(
      (await api(a.id).get('/me/presence').expect(200)).body.online,
    ).toEqual([b.id]);
  });
});

describe('the gateway is an adapter', () => {
  it('imports no database service, Prisma or SQL, and holds no business rule of its own', () => {
    const source = readFileSync(
      new URL(
        '../../src/modules/chat/gateway/chat.gateway.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(source).not.toMatch(
      /infrastructure\/database|generated\/prisma|@prisma|PrismaService|\$queryRaw|\$executeRaw/,
    );
    expect(source).toMatch(/@UseFilters\(AllExceptionsFilter\)/);
    expect(source).toMatch(/requireActiveUser/);
    expect(source).toMatch(/PER_CONVERSATION_BURST/);
  });
});
