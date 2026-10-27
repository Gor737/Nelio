// M13 conformance: the runtime leak scan. A world is seeded with values that must never leave the server (password hashes, a deleted
// message's text, report snapshots, other people's email addresses), and EVERY GET route is called as every kind of caller. No answer, success
// or error, may contain a forbidden key or a forbidden value. (The static scan of every response schema, including the routes that change
// data, is in openapi.integration-spec.ts.)
import { createPool, resetData } from '../support/database.js';
import {
  createAdmin,
  createTeacher,
  createUser,
} from '../support/factories.js';
import {
  addMember,
  createChannel,
  createDirectConversation,
  createMessage,
  reportMessage,
} from '../support/factories-chat.js';
import {
  createBlock,
  createLesson,
  createSection,
  createTextBlock,
} from '../support/factories-content.js';
import {
  addCourseTeacher,
  createNotification,
  createPublishedCourse,
} from '../support/factories-courses.js';
import {
  createEnrollment,
  createInvitation,
} from '../support/factories-learning.js';
import { createFullApp, type FullApp } from '../support/full-app.js';
import { routeInventory, type RouteInfo } from '../support/route-inventory.js';

const pool = createPool(5);
let t: FullApp;
let routes: RouteInfo[];

const DELETED_TEXT = 'DELETED-SECRET-TEXT-4f1c';
const SNAPSHOT_TEXT = 'SNAPSHOT-SECRET-TEXT-9a2e';
const ARGON =
  '$argon2id$v=19$m=19456,t=2,p=1$LEAKSALTLEAKSALT$LEAKHASHLEAKHASHLEAKHASHLEAKHASHLEAKHASHLEAK';

const FORBIDDEN_KEYS = [
  'passwordHash',
  'password_hash',
  'tokenHash',
  'token_hash',
  'messageSnapshot',
  'message_snapshot',
  'refreshToken',
  'lastSeenAt',
  'last_seen_at',
];

interface Person {
  id: string;
  email: string;
}
let world: {
  alice: Person;
  bob: Person;
  carol: Person;
  dave: Person;
  eve: Person;
  admin: Person;
  courseId: string;
  lessonId: string;
  blockId: string;
  dm: string;
  reportId: string;
};

beforeAll(async () => {
  t = await createFullApp();
  routes = routeInventory(t.app);
});
afterAll(async () => {
  await t.app.close();
  await pool.end();
});

async function seed() {
  await resetData(pool);
  const alice = await createUser(pool, { email: 'leak-alice@example.test' });
  const bob = await createTeacher(pool);
  const carol = await createTeacher(pool);
  const dave = await createUser(pool, { email: 'leak-dave@example.test' });
  const eve = await createUser(pool, { email: 'leak-eve@example.test' });
  const admin = await createAdmin(pool);
  await pool.query(
    'UPDATE users SET password_hash = $1, last_seen_at = now()',
    [ARGON],
  );
  await pool.query(
    "UPDATE users SET email = 'leak-' || split_part(email, '@', 1) || '@example.test' WHERE email NOT LIKE 'leak-%'",
  );
  const emails = (
    await pool.query<{ id: string; email: string }>(
      'SELECT id, email FROM users',
    )
  ).rows;
  const person = (u: { id: string }): Person => ({
    id: u.id,
    email: emails.find((e) => e.id === u.id)!.email,
  });

  const courseId = await createPublishedCourse(pool);
  await addCourseTeacher(pool, courseId, bob.id, 'OWNER');
  await addCourseTeacher(pool, courseId, carol.id, 'ASSISTANT', bob.id);
  await createEnrollment(pool, courseId, alice.id);
  await createEnrollment(pool, courseId, dave.id, { status: 'PENDING' });
  const section = await createSection(pool, courseId);
  const lessonId = await createLesson(pool, courseId, section, {
    status: 'PUBLISHED',
  });
  await createTextBlock(pool, lessonId, 'A lesson text');
  const blockId = await createBlock(pool, lessonId, {
    type: 'TEXT',
    textBody: 'More text',
  });
  const channel = await createChannel(pool, courseId);
  for (const u of [bob, carol, alice]) await addMember(pool, channel, u.id);
  await createMessage(pool, channel, alice.id, { body: 'hello class' });

  const dm = await createDirectConversation(pool, alice.id, eve.id);
  await createMessage(pool, dm, alice.id, { body: 'a normal message' });
  const deleted = await createMessage(pool, dm, alice.id, {
    body: DELETED_TEXT,
    deletedAt: new Date(),
    deletedBy: alice.id,
  });
  const reportId = await reportMessage(pool, eve.id, deleted, {
    snapshot: SNAPSHOT_TEXT,
  });
  await pool.query(
    'UPDATE conversations c SET last_seq = (SELECT COALESCE(max(seq), 0) FROM messages m WHERE m.conversation_id = c.id)',
  );
  await createNotification(pool, alice.id);
  await createInvitation(pool, courseId, eve.id, bob.id);
  await pool.query(
    'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)',
    [alice.id, dave.id],
  );

  world = {
    alice: person(alice),
    bob: person(bob),
    carol: person(carol),
    dave: person(dave),
    eve: person(eve),
    admin: person(admin),
    courseId,
    lessonId,
    blockId,
    dm,
    reportId,
  };
}

/** Fills the `:params` of a route with real ids of the seeded world. */
function fill(path: string): string {
  return path
    .replace(':courseId', world.courseId)
    .replace(':lessonId', world.lessonId)
    .replace(':blockId', world.blockId)
    .replace(':reportId', world.reportId)
    .replace(/^\/admin\/users\/:userId/, `/admin/users/${world.alice.id}`)
    .replace(':userId', world.alice.id)
    .replace(/^\/conversations\/:id/, `/conversations/${world.dm}`)
    .replace(/^\/users\/:id/, `/users/${world.alice.id}`)
    .replace(/:[A-Za-z]+/g, world.alice.id);
}

function keysIn(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysIn(v, found));
  else if (value && typeof value === 'object')
    for (const [key, v] of Object.entries(value)) {
      found.add(key);
      keysIn(v, found);
    }
  return found;
}

describe('every GET route, as every kind of caller', () => {
  it('leaks nothing: no forbidden key, no password hash, no deleted text, no snapshot outside the Admin reports, no email outside /me and /admin', async () => {
    await seed();
    const callers: [string, string | undefined][] = [
      ['anonymous', undefined],
      ['student', world.alice.id],
      ['pending student', world.dave.id],
      ['owner', world.bob.id],
      ['assistant', world.carol.id],
      ['stranger', world.eve.id],
      ['admin', world.admin.id],
    ];
    const emails = [
      world.alice,
      world.dave,
      world.eve,
      world.bob,
      world.carol,
      world.admin,
    ].map((p) => p.email);
    const gets = routes.filter((r) => r.method === 'get');
    let ok = 0;
    let total = 0;
    for (const route of gets) {
      const path = fill(route.path);
      const query = route.path === '/users' ? '?q=leak' : '';
      for (const [caller, userId] of callers) {
        const res = await t.call('get', path + query, { userId });
        total++;
        if (res.status >= 200 && res.status < 300) ok++;
        const text = res.text ?? '';
        const where = `${route.key} as ${caller} (${res.status})`;
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          /* a binary or empty body */
        }
        const keys = body ? keysIn(body) : new Set<string>();
        for (const key of FORBIDDEN_KEYS)
          expect([where, key, keys.has(key)]).toEqual([where, key, false]);
        expect([where, 'argon hash', text.includes('$argon2')]).toEqual([
          where,
          'argon hash',
          false,
        ]);
        expect([where, 'deleted text', text.includes(DELETED_TEXT)]).toEqual([
          where,
          'deleted text',
          false,
        ]);
        const adminReport = route.path.startsWith('/admin/reports');
        expect([
          where,
          'snapshot',
          adminReport
            ? false
            : text.includes(SNAPSHOT_TEXT) || keys.has('snapshot'),
        ]).toEqual([where, 'snapshot', false]);
        const emailAllowed =
          route.path.startsWith('/me') || route.path.startsWith('/admin');
        if (!emailAllowed) {
          expect([where, 'email key', keys.has('email')]).toEqual([
            where,
            'email key',
            false,
          ]);
          for (const email of emails)
            expect([where, 'email value', text.includes(email)]).toEqual([
              where,
              'email value',
              false,
            ]);
        }
      }
    }
    expect(gets.length).toBeGreaterThanOrEqual(40);
    expect(total).toBe(gets.length * callers.length);
    // a vacuous crawl proves nothing: a good part of the answers must have been real successes
    expect(ok).toBeGreaterThan(total / 4);
  }, 120000);

  it('the Admin report detail and context DO carry the evidence (so the scan above is not blind to it) and never the live deleted text', async () => {
    await seed();
    const detail = await t
      .call('get', `/admin/reports/${world.reportId}`, {
        userId: world.admin.id,
      })
      .expect(200);
    expect(detail.text).toContain(SNAPSHOT_TEXT);
    expect(detail.text).not.toContain(DELETED_TEXT);
    const context = await t
      .call('get', `/admin/reports/${world.reportId}/context`, {
        userId: world.admin.id,
      })
      .expect(200);
    expect(context.text).toContain(SNAPSHOT_TEXT);
    expect(context.text).not.toContain(DELETED_TEXT);
  });

  it("the Admin users list shows emails (so the scan above is not blind to them); /me shows only the caller's own", async () => {
    await seed();
    const list = await t
      .call('get', '/admin/users', { userId: world.admin.id })
      .expect(200);
    expect(list.text).toContain(world.alice.email);
    const me = await t
      .call('get', '/me', { userId: world.alice.id })
      .expect(200);
    expect(me.text).toContain(world.alice.email);
    expect(me.text).not.toContain(world.eve.email);
  });
});

describe('what mutations answer', () => {
  it("sending a message answers with the message and no other person's email; a deleted message is returned without text", async () => {
    await seed();
    const sent = await t
      .call('post', `/conversations/${world.dm}/messages`, {
        userId: world.alice.id,
        body: {
          body: 'fresh message',
          clientId: '0191a000-0000-7000-8000-000000000042',
        },
      })
      .expect(201);
    expect(sent.text).not.toContain('$argon2');
    expect(sent.text).not.toContain(world.eve.email);
    const history = await t
      .call('get', `/conversations/${world.dm}/messages`, {
        userId: world.eve.id,
      })
      .expect(200);
    expect(history.text).not.toContain(DELETED_TEXT);
    expect(history.text).toContain('a normal message');
  });
});
