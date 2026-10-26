// M10c step 1: conversations and membership over HTTP against the real database (Decisions 26, 80, 83, 84, 87, 131).
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { COUNT_LIMITS } from '../../src/common/constants/limits.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import { DatabaseModule } from '../../src/infrastructure/database/index.js';
import {
  EventBus,
  EventsModule,
} from '../../src/infrastructure/events/index.js';
import { ChatDeliveryService } from '../../src/modules/chat/services/chat-delivery.service.js';
import { ChatModule } from '../../src/modules/chat/index.js';
import { BlockService } from '../../src/modules/moderation/index.js';
import { createPool, resetData } from '../support/database.js';
import { createUser } from '../support/factories.js';
import {
  addMember,
  createChannel,
  createDirectConversation,
  createGroup,
  createMessage,
} from '../support/factories-chat.js';
import {
  addCourseTeacher,
  createPublishedCourse,
} from '../support/factories-courses.js';
import { createEnrollment } from '../support/factories-learning.js';
import { bearer, closeApp, testEnv } from '../support/integration-app.js';
import { createTeacher } from '../support/factories.js';

const pool = createPool(25);
let app: NestExpressApplication;
let delivery: ChatDeliveryService;
let blocks: BlockService;
const events: { name: string; payload: unknown }[] = [];

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
  const bus = app.get(EventBus);
  for (const name of [
    'conversation.added',
    'conversation.removed',
    'conversation.updated',
  ] as const)
    bus.on(name, (payload) => {
      events.push({ name, payload });
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
const ip = () => `10.6.${(counter >> 8) & 255}.${counter++ & 255}`;
const api = (userId: string) => {
  const base = (m: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    request(app.getHttpServer())
      [m](`/api/v1${path}`)
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', ip());
  return {
    get: (path: string) => base('get', path),
    post: (path: string, body: object = {}) => base('post', path).send(body),
    patch: (path: string, body: object = {}) => base('patch', path).send(body),
    del: (path: string) => base('delete', path),
  };
};
const users = (n: number) =>
  Promise.all(Array.from({ length: n }, () => createUser(pool)));
const activeMembers = async (conversationId: string) =>
  (
    await pool.query<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL ORDER BY user_id',
      [conversationId],
    )
  ).rows;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('direct conversations', () => {
  it('get-or-create: the same conversation every time, from either side, with the other person as peer', async () => {
    const [a, b] = await users(2);
    const first = (
      await api(a.id)
        .post('/conversations/direct', { userId: b.id })
        .expect(200)
    ).body;
    const again = (
      await api(a.id)
        .post('/conversations/direct', { userId: b.id })
        .expect(200)
    ).body;
    const fromB = (
      await api(b.id)
        .post('/conversations/direct', { userId: a.id })
        .expect(200)
    ).body;
    expect(new Set([first.id, again.id, fromB.id]).size).toBe(1);
    expect(first).toMatchObject({
      type: 'DIRECT',
      title: null,
      courseId: null,
      memberCount: 2,
      myRole: 'MEMBER',
      unreadCount: 0,
      readOnly: false,
      peer: { id: b.id, fullName: b.full_name },
    });
    expect(fromB.peer.id).toBe(a.id);
    expect(JSON.stringify(first)).not.toContain(b.email);
    const [pair] = (
      await pool.query('SELECT user_a_id, user_b_id FROM direct_conversations')
    ).rows;
    expect(pair.user_a_id < pair.user_b_id).toBe(true);
    expect(
      (await activeMembers(first.id)).map((m) => m.user_id).sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('two people opening their first DM at the same moment get ONE conversation', async () => {
    for (let round = 0; round < 8; round++) {
      const [a, b] = await users(2);
      const results = await Promise.all([
        api(a.id).post('/conversations/direct', { userId: b.id }),
        api(b.id).post('/conversations/direct', { userId: a.id }),
        api(a.id).post('/conversations/direct', { userId: b.id }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    }
    expect(
      (await pool.query("SELECT 1 FROM conversations WHERE type = 'DIRECT'"))
        .rowCount,
    ).toBe(8);
  });

  it('yourself is 400; an unknown or suspended user is 404; a malformed id is 400', async () => {
    const [a, gone] = [
      await createUser(pool),
      await createUser(pool, { status: 'SUSPENDED' }),
    ];
    await api(a.id).post('/conversations/direct', { userId: a.id }).expect(400);
    await api(a.id)
      .post('/conversations/direct', { userId: randomUUID() })
      .expect(404);
    await api(a.id)
      .post('/conversations/direct', { userId: gone.id })
      .expect(404);
    await api(a.id)
      .post('/conversations/direct', { userId: 'nope' })
      .expect(400);
    await api(a.id).post('/conversations/direct', {}).expect(400);
  });

  it('a block in either direction is 403 CANNOT_MESSAGE_USER with the identical answer for both sides', async () => {
    const [a, b, c] = await users(3);
    await blocks.block(a.id, b.id);
    const byBlocker = await api(a.id)
      .post('/conversations/direct', { userId: b.id })
      .expect(403);
    const byBlocked = await api(b.id)
      .post('/conversations/direct', { userId: a.id })
      .expect(403);
    expect(byBlocker.body.code).toBe('CANNOT_MESSAGE_USER');
    expect({ ...byBlocker.body }).toEqual({ ...byBlocked.body });
    await api(a.id).post('/conversations/direct', { userId: c.id }).expect(200); // other people are unaffected
    expect(
      (await pool.query("SELECT 1 FROM conversations WHERE type = 'DIRECT'"))
        .rowCount,
    ).toBe(1);
  });

  it('an empty DM is hidden from my list until the first message, but it can be read by id', async () => {
    const [a, b] = await users(2);
    const dm = (
      await api(a.id)
        .post('/conversations/direct', { userId: b.id })
        .expect(200)
    ).body;
    expect(
      (await api(a.id).get('/me/conversations').expect(200)).body.items,
    ).toEqual([]);
    expect(
      (await api(b.id).get('/me/conversations').expect(200)).body.total,
    ).toBe(0);
    await api(a.id).get(`/conversations/${dm.id}`).expect(200);
    await createMessage(pool, dm.id, a.id);
    await pool.query(
      'UPDATE conversations SET last_seq = 1, last_message_at = now() WHERE id = $1',
      [dm.id],
    );
    for (const user of [a, b])
      expect(
        (
          await api(user.id).get('/me/conversations').expect(200)
        ).body.items.map((c: { id: string }) => c.id),
      ).toEqual([dm.id]);
  });

  it('a DM cannot be renamed, left or have members changed (409), and nobody else can read it (404)', async () => {
    const [a, b, outsider] = await users(3);
    const dm = (
      await api(a.id)
        .post('/conversations/direct', { userId: b.id })
        .expect(200)
    ).body;
    await api(a.id)
      .patch(`/conversations/${dm.id}`, { title: 'x' })
      .expect(409);
    await api(a.id).post(`/conversations/${dm.id}/leave`).expect(409);
    await api(a.id)
      .post(`/conversations/${dm.id}/members`, { userIds: [outsider.id] })
      .expect(409);
    await api(outsider.id).get(`/conversations/${dm.id}`).expect(404);
    await api(outsider.id).get(`/conversations/${dm.id}/members`).expect(404);
  });
});

describe('creating groups', () => {
  it('the creator is the admin; the others are members; each is told after commit', async () => {
    const [creator, x, y] = await users(3);
    const ok = await api(creator.id)
      .post('/conversations/groups', {
        title: '  Study group  ',
        memberIds: [x.id, y.id, creator.id],
      })
      .expect(201);
    expect(ok.body).toMatchObject({
      type: 'GROUP',
      title: 'Study group',
      memberCount: 3,
      myRole: 'ADMIN',
      peer: null,
      courseId: null,
    });
    expect(
      (await activeMembers(ok.body.id)).find((m) => m.user_id === creator.id)
        ?.role,
    ).toBe('ADMIN');
    expect(
      (await api(x.id).get(`/conversations/${ok.body.id}`).expect(200)).body
        .myRole,
    ).toBe('MEMBER');
    await sleep(80);
    expect(events.filter((e) => e.name === 'conversation.added')).toHaveLength(
      3,
    );
  });

  it('validates the title and the member list; more than 50 with the creator is 400', async () => {
    const [creator, x] = await users(2);
    await api(creator.id)
      .post('/conversations/groups', { title: '', memberIds: [x.id] })
      .expect(400);
    await api(creator.id)
      .post('/conversations/groups', {
        title: 'x'.repeat(81),
        memberIds: [x.id],
      })
      .expect(400);
    await api(creator.id)
      .post('/conversations/groups', { title: 'ok' })
      .expect(400);
    await api(creator.id)
      .post('/conversations/groups', { title: 'ok', memberIds: ['nope'] })
      .expect(400);
    await api(creator.id)
      .post('/conversations/groups', { title: '😀'.repeat(80), memberIds: [] })
      .expect(201);
    const many = Array.from({ length: COUNT_LIMITS.GROUP_MEMBERS_MAX }, () =>
      randomUUID(),
    );
    expect(
      (
        await api(creator.id)
          .post('/conversations/groups', { title: 'big', memberIds: many })
          .expect(400)
      ).body.errors[0].field,
    ).toBe('memberIds');
  });

  it('an unknown, suspended or blocking person makes the whole request the neutral 409 MEMBERS_UNAVAILABLE and creates nothing', async () => {
    const [creator, ok, blocker] = await users(3);
    const suspended = await createUser(pool, { status: 'SUSPENDED' });
    await blocks.block(blocker.id, creator.id);
    const before = (
      await pool.query('SELECT count(*)::int AS n FROM conversations')
    ).rows[0].n;
    const messages = new Set<string>();
    for (const bad of [randomUUID(), suspended.id, blocker.id]) {
      const res = await api(creator.id)
        .post('/conversations/groups', { title: 'g', memberIds: [ok.id, bad] })
        .expect(409);
      expect(res.body.code).toBe('MEMBERS_UNAVAILABLE');
      messages.add(res.body.message);
    }
    expect(messages.size).toBe(1); // the same words whatever the reason: nothing reveals the block
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM conversations')).rows[0]
        .n,
    ).toBe(before);
  });

  it('someone the creator has blocked can still be added (only the other direction is refused)', async () => {
    const [creator, blocked] = await users(2);
    await blocks.block(creator.id, blocked.id);
    await api(creator.id)
      .post('/conversations/groups', { title: 'g', memberIds: [blocked.id] })
      .expect(201);
  });
});

describe('membership of a group', () => {
  async function group(memberCount = 2) {
    const [admin, ...rest] = await users(memberCount + 1);
    const id = await createGroup(
      pool,
      admin.id,
      rest.map((u) => u.id),
    );
    return { admin, members: rest, id };
  }

  it('lists the active members with role, no email; a non-member and a former member get 404', async () => {
    const { admin, members, id } = await group(2);
    const list = (
      await api(admin.id).get(`/conversations/${id}/members`).expect(200)
    ).body;
    expect(list).toHaveLength(3);
    expect(list.find((m: { id: string }) => m.id === admin.id)).toMatchObject({
      role: 'ADMIN',
    });
    expect(JSON.stringify(list)).not.toContain('@');
    const [outsider] = await users(1);
    await api(outsider.id).get(`/conversations/${id}/members`).expect(404);
    await api(members[0].id).post(`/conversations/${id}/leave`).expect(204);
    await api(members[0].id).get(`/conversations/${id}/members`).expect(404);
    await api(members[0].id).get(`/conversations/${id}`).expect(404);
  });

  it('only a group admin adds, renames, removes and changes roles (403); non-members get 404 for all of it', async () => {
    const { admin, members, id } = await group(2);
    const [candidate, outsider] = await users(2);
    const member = members[0];
    await api(member.id)
      .post(`/conversations/${id}/members`, { userIds: [candidate.id] })
      .expect(403);
    await api(member.id)
      .patch(`/conversations/${id}`, { title: 'x' })
      .expect(403);
    await api(member.id)
      .del(`/conversations/${id}/members/${members[1].id}`)
      .expect(403);
    await api(member.id)
      .patch(`/conversations/${id}/members/${members[1].id}`, { role: 'ADMIN' })
      .expect(403);
    await api(outsider.id)
      .post(`/conversations/${id}/members`, { userIds: [candidate.id] })
      .expect(404);
    await api(outsider.id)
      .patch(`/conversations/${id}`, { title: 'x' })
      .expect(404);
    expect(
      (
        await api(admin.id)
          .patch(`/conversations/${id}`, { title: ' New name ' })
          .expect(200)
      ).body.title,
    ).toBe('New name');
    expect(
      (
        await api(admin.id)
          .post(`/conversations/${id}/members`, { userIds: [candidate.id] })
          .expect(200)
      ).body,
    ).toHaveLength(4);
  });

  it('adding: people already in are skipped; blocking adders get the neutral 409; the adder blocking the candidate is fine', async () => {
    const { admin, id } = await group(1);
    const [fresh, blocker, blocked] = await users(3);
    await blocks.block(blocker.id, admin.id);
    await blocks.block(admin.id, blocked.id);
    await api(admin.id)
      .post(`/conversations/${id}/members`, {
        userIds: [fresh.id.toUpperCase(), fresh.id],
      })
      .expect(200); // the same person twice (any case) is one person
    await api(admin.id)
      .post(`/conversations/${id}/members`, { userIds: [admin.id, fresh.id] })
      .expect(200);
    await api(admin.id)
      .post(`/conversations/${id}/members`, { userIds: [fresh.id] })
      .expect(200);
    const refused = await api(admin.id)
      .post(`/conversations/${id}/members`, { userIds: [blocker.id] })
      .expect(409);
    expect(refused.body.code).toBe('MEMBERS_UNAVAILABLE');
    expect(refused.body.message).not.toMatch(/block/i);
    await api(admin.id)
      .post(`/conversations/${id}/members`, { userIds: [blocked.id] })
      .expect(200);
    expect((await activeMembers(id)).map((m) => m.user_id)).not.toContain(
      blocker.id,
    );
    await api(admin.id)
      .post(`/conversations/${id}/members`, { userIds: [randomUUID()] })
      .expect(409);
    await api(admin.id)
      .post(`/conversations/${id}/members`, {
        userIds: [(await createUser(pool, { status: 'SUSPENDED' })).id],
      })
      .expect(409);
  });

  it('a block that exists only in an existing shared group changes nothing there (Decision 84)', async () => {
    const { admin, members, id } = await group(1);
    await blocks.block(members[0].id, admin.id);
    expect((await activeMembers(id)).length).toBe(2);
    await api(admin.id).get(`/conversations/${id}`).expect(200);
    await api(members[0].id).get(`/conversations/${id}`).expect(200);
  });

  it('the group never passes 50 members: ten admins adding at the same moment (one new person each, group at 45) end at exactly 50', async () => {
    const [creator, ...rest] = await users(45);
    const id = await createGroup(
      pool,
      creator.id,
      rest.map((u) => u.id),
    ); // 45 members
    const admins = rest.slice(0, 9);
    await pool.query(
      "UPDATE conversation_members SET role = 'ADMIN' WHERE conversation_id = $1 AND user_id = ANY($2::uuid[])",
      [id, admins.map((a) => a.id)],
    );
    const adders = [creator, ...admins]; // ten admins
    const newcomers = await users(10);
    const results = await Promise.all(
      adders.map((adder, i) =>
        api(adder.id).post(`/conversations/${id}/members`, {
          userIds: [newcomers[i].id],
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses.filter((s) => s === 409)).toHaveLength(5);
    expect((await activeMembers(id)).length).toBe(
      COUNT_LIMITS.GROUP_MEMBERS_MAX,
    );
    for (const r of results.filter((x) => x.status === 409))
      expect(r.body.code).toBe('RESOURCE_CONFLICT');
  });

  it('a request that would pass 50 adds nobody (all or nothing)', async () => {
    const [creator, ...rest] = await users(48);
    const id = await createGroup(
      pool,
      creator.id,
      rest.map((u) => u.id),
    ); // 48
    const newcomers = await users(3);
    await api(creator.id)
      .post(`/conversations/${id}/members`, {
        userIds: newcomers.map((u) => u.id),
      })
      .expect(409);
    expect((await activeMembers(id)).length).toBe(48);
    await api(creator.id)
      .post(`/conversations/${id}/members`, {
        userIds: newcomers.slice(0, 2).map((u) => u.id),
      })
      .expect(200);
    expect((await activeMembers(id)).length).toBe(50);
  });

  it('two admins adding different people at the same moment: both succeed and both are members', async () => {
    const { admin, members, id } = await group(2);
    await pool.query(
      "UPDATE conversation_members SET role = 'ADMIN' WHERE conversation_id = $1 AND user_id = $2",
      [id, members[0].id],
    );
    const [x, y] = await users(2);
    const results = await Promise.all([
      api(admin.id).post(`/conversations/${id}/members`, { userIds: [x.id] }),
      api(members[0].id).post(`/conversations/${id}/members`, {
        userIds: [y.id],
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect((await activeMembers(id)).length).toBe(5);
  });

  it('a returning member comes back on the SAME row: member role, new joined_at, read position kept, no second row', async () => {
    const { admin, members, id } = await group(2);
    const returning = members[0];
    await pool.query(
      "UPDATE conversation_members SET role = 'ADMIN', last_read_seq = 7, is_muted = true WHERE conversation_id = $1 AND user_id = $2",
      [id, returning.id],
    );
    const before = (
      await pool.query(
        'SELECT joined_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [id, returning.id],
      )
    ).rows[0].joined_at;
    await api(returning.id).post(`/conversations/${id}/leave`).expect(204);
    await sleep(20);
    await api(admin.id)
      .post(`/conversations/${id}/members`, { userIds: [returning.id] })
      .expect(200);
    const rows = (
      await pool.query(
        'SELECT role, left_at, joined_at, last_read_seq, is_muted FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [id, returning.id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'MEMBER',
      left_at: null,
      last_read_seq: 7,
      is_muted: false,
    });
    expect(rows[0].joined_at.getTime()).toBeGreaterThan(before.getTime());
    expect(
      (
        await pool.query(
          'SELECT 1 FROM conversation_members WHERE conversation_id = $1',
          [id],
        )
      ).rowCount,
    ).toBe(3);
  });

  it('removing a member makes them a former member (404) and tells them; removing yourself is leaving', async () => {
    const { admin, members, id } = await group(2);
    await api(admin.id)
      .del(`/conversations/${id}/members/${members[0].id}`)
      .expect(204);
    await api(members[0].id).get(`/conversations/${id}`).expect(404);
    await api(admin.id)
      .del(`/conversations/${id}/members/${members[0].id}`)
      .expect(404);
    await sleep(80);
    expect(events).toContainEqual({
      name: 'conversation.removed',
      payload: { conversationId: id, userId: members[0].id },
    });
    await api(members[1].id)
      .del(`/conversations/${id}/members/${members[1].id}`)
      .expect(204);
    expect((await activeMembers(id)).map((m) => m.user_id)).toEqual([admin.id]);
  });

  it('promote and demote; demoting the last admin while others remain is 409 LAST_GROUP_ADMIN', async () => {
    const { admin, members, id } = await group(2);
    await api(admin.id)
      .patch(`/conversations/${id}/members/${admin.id}`, { role: 'MEMBER' })
      .expect(409)
      .then((r) => expect(r.body.code).toBe('LAST_GROUP_ADMIN'));
    const promoted = (
      await api(admin.id)
        .patch(`/conversations/${id}/members/${members[0].id}`, {
          role: 'ADMIN',
        })
        .expect(200)
    ).body;
    expect(
      promoted.find((m: { id: string }) => m.id === members[0].id).role,
    ).toBe('ADMIN');
    await api(admin.id)
      .patch(`/conversations/${id}/members/${admin.id}`, { role: 'MEMBER' })
      .expect(200);
    await api(members[0].id)
      .patch(`/conversations/${id}/members/${members[0].id}`, {
        role: 'MEMBER',
      })
      .expect(409);
    await api(admin.id)
      .patch(`/conversations/${id}/members/${members[0].id}`, { role: 'ADMIN' })
      .expect(403); // admin was demoted
    await api(members[0].id)
      .patch(`/conversations/${id}/members/${randomUUID()}`, { role: 'ADMIN' })
      .expect(404);
    await api(members[0].id)
      .patch(`/conversations/${id}/members/${admin.id}`, { role: 'OWNER' })
      .expect(400);
  });

  it('the last admin leaving promotes the member who joined first; ties go to the smaller user id; another admin means no promotion', async () => {
    const { admin, members, id } = await group(3);
    const same = new Date('2026-03-01T10:00:00Z');
    await pool.query(
      'UPDATE conversation_members SET joined_at = $2 WHERE conversation_id = $1 AND user_id = $3',
      [id, new Date('2026-01-01T00:00:00Z'), admin.id],
    );
    await pool.query(
      'UPDATE conversation_members SET joined_at = $2 WHERE conversation_id = $1 AND user_id = ANY($3::uuid[])',
      [id, same, [members[0].id, members[1].id]],
    );
    await pool.query(
      'UPDATE conversation_members SET joined_at = $2 WHERE conversation_id = $1 AND user_id = $3',
      [id, new Date('2026-04-01T00:00:00Z'), members[2].id],
    );
    await api(admin.id).post(`/conversations/${id}/leave`).expect(204);
    const expected = [members[0].id, members[1].id].sort()[0];
    const roles = Object.fromEntries(
      (await activeMembers(id)).map((m) => [m.user_id, m.role]),
    );
    expect(roles[expected]).toBe('ADMIN');
    expect(Object.values(roles).filter((r) => r === 'ADMIN')).toHaveLength(1);
    // with a second admin present nobody is promoted
    const g2 = await group(2);
    await pool.query(
      "UPDATE conversation_members SET role = 'ADMIN' WHERE conversation_id = $1 AND user_id = $2",
      [g2.id, g2.members[0].id],
    );
    await api(g2.admin.id).post(`/conversations/${g2.id}/leave`).expect(204);
    expect(
      (await activeMembers(g2.id))
        .filter((m) => m.role === 'ADMIN')
        .map((m) => m.user_id),
    ).toEqual([g2.members[0].id]);
  });

  it('two people who are both the last admin cannot both leave without a successor: the survivor is always an admin', async () => {
    const { admin, members, id } = await group(1);
    await pool.query(
      "UPDATE conversation_members SET role = 'ADMIN' WHERE conversation_id = $1 AND user_id = $2",
      [id, members[0].id],
    );
    const results = await Promise.all([
      api(admin.id).post(`/conversations/${id}/leave`),
      api(members[0].id).post(`/conversations/${id}/leave`),
    ]);
    expect(results.map((r) => r.status)).toEqual([204, 204]);
    const left = await activeMembers(id);
    expect(left.every((m) => m.role === 'ADMIN')).toBe(true);
  });

  it('the last member leaving leaves an empty group, and an empty group is just a group nobody can read', async () => {
    const { admin, id } = await group(0);
    await api(admin.id).post(`/conversations/${id}/leave`).expect(204);
    expect(await activeMembers(id)).toEqual([]);
    await api(admin.id).get(`/conversations/${id}`).expect(404);
  });

  it('mute is mine alone and works in any conversation I am in', async () => {
    const { admin, members, id } = await group(1);
    const dm = (
      await api(admin.id)
        .post('/conversations/direct', { userId: members[0].id })
        .expect(200)
    ).body;
    expect(
      (
        await api(members[0].id)
          .patch(`/conversations/${id}/membership`, { isMuted: true })
          .expect(200)
      ).body.isMuted,
    ).toBe(true);
    expect(
      (await api(admin.id).get(`/conversations/${id}`).expect(200)).body
        .isMuted,
    ).toBe(false);
    expect(
      (
        await api(admin.id)
          .patch(`/conversations/${dm.id}/membership`, { isMuted: true })
          .expect(200)
      ).body.isMuted,
    ).toBe(true);
    await api(members[0].id)
      .patch(`/conversations/${id}/membership`, { isMuted: 'yes' })
      .expect(400);
    await api((await createUser(pool)).id)
      .patch(`/conversations/${id}/membership`, { isMuted: true })
      .expect(404);
  });
});

describe('my conversations', () => {
  it('lists DMs with messages, groups and channels, most recent first, with unread counts that exclude my own and deleted messages', async () => {
    const [me, a, b] = await users(3);
    const g = await createGroup(pool, a.id, [me.id, b.id]);
    const dm = await createDirectConversation(pool, me.id, b.id);
    await createMessage(pool, g, a.id);
    await createMessage(pool, g, b.id);
    await createMessage(pool, g, me.id);
    const gone = await createMessage(pool, g, a.id);
    await pool.query(
      'UPDATE messages SET deleted_at = now(), deleted_by = sender_id WHERE id = $1',
      [gone],
    );
    await pool.query(
      "UPDATE conversations SET last_seq = 4, last_message_at = now() - interval '1 hour' WHERE id = $1",
      [g],
    );
    await createMessage(pool, dm, b.id);
    await pool.query(
      'UPDATE conversations SET last_seq = 1, last_message_at = now() WHERE id = $1',
      [dm],
    );
    await pool.query(
      'UPDATE conversation_members SET last_read_seq = 1 WHERE conversation_id = $1 AND user_id = $2',
      [g, me.id],
    );
    const res = (await api(me.id).get('/me/conversations').expect(200)).body;
    expect(res.items.map((c: { id: string }) => c.id)).toEqual([dm, g]);
    expect(res.items[0]).toMatchObject({ unreadCount: 1, peer: { id: b.id } });
    expect(res.items[1].unreadCount).toBe(1); // seq 2 from b; seq 3 is mine; seq 4 is deleted
    expect(res.total).toBe(2);
  });

  it('paginates, hides former memberships, and never lists a conversation I am not in', async () => {
    const [me, other] = await users(2);
    for (let i = 0; i < 3; i++) await createGroup(pool, me.id, [other.id]);
    const stranger = await createGroup(pool, other.id, []);
    const left = await createGroup(pool, other.id, [me.id]);
    await pool.query(
      'UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2',
      [left, me.id],
    );
    const p1 = (
      await api(me.id).get('/me/conversations?page=1&pageSize=2').expect(200)
    ).body;
    const p2 = (
      await api(me.id).get('/me/conversations?page=2&pageSize=2').expect(200)
    ).body;
    expect([p1.items.length, p2.items.length, p1.total]).toEqual([2, 1, 3]);
    const ids = [...p1.items, ...p2.items].map((c: { id: string }) => c.id);
    expect(ids).not.toContain(stranger);
    expect(ids).not.toContain(left);
    await api(me.id).get('/me/conversations?pageSize=51').expect(400);
  });

  it('needs a signed-in user', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/me/conversations')
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/conversations/direct')
      .send({})
      .expect(401);
  });
});

describe('the course channel', () => {
  it('members (Owner, Assistant, ACTIVE students that were synced) see it under the course title; others get 404; no channel yet is 404', async () => {
    const courseId = await createPublishedCourse(pool, {
      title: 'Intro to Armenian',
    });
    const [owner, assistant, student, unsynced] = [
      await createTeacher(pool),
      await createTeacher(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    await addCourseTeacher(pool, courseId, assistant.id, 'ASSISTANT', owner.id);
    await createEnrollment(pool, courseId, student.id);
    await createEnrollment(pool, courseId, unsynced.id);
    await api(owner.id).get(`/courses/${courseId}/channel`).expect(404); // never published: no channel yet
    const channel = await createChannel(pool, courseId);
    for (const user of [owner, assistant, student])
      await addMember(pool, channel, user.id);
    for (const user of [owner, assistant, student]) {
      const res = await api(user.id)
        .get(`/courses/${courseId}/channel`)
        .expect(200);
      expect(res.body).toMatchObject({
        id: channel,
        type: 'COURSE_CHANNEL',
        title: 'Intro to Armenian',
        courseId,
        memberCount: 3,
        readOnly: false,
      });
    }
    await api(unsynced.id).get(`/courses/${courseId}/channel`).expect(404); // an active student whose row is missing is not a member
    await api((await createUser(pool)).id)
      .get(`/courses/${courseId}/channel`)
      .expect(403); // not related to the course at all
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now() WHERE id = $1",
      [courseId],
    );
    expect(
      (await api(student.id).get(`/courses/${courseId}/channel`).expect(200))
        .body.readOnly,
    ).toBe(true);
    await api(student.id).post(`/conversations/${channel}/leave`).expect(409);
  });
});
