// M13 conformance: the hot queries use their indexes at a realistic size. A database with tens of thousands of rows is built, ANALYZEd, and
// `EXPLAIN (FORMAT JSON)` is read for each query the architecture names (docs/architecture.md section 9): unread notifications, message
// history by `seq`, active members, the completion recheck and the file-reference check. A plan that sorts or scans a whole table where an
// index should answer fails the test. The SQL below is the SQL of the services; `sourceContains` fails when the service text changes, so a
// query cannot drift away from this check unnoticed.
import { readFileSync } from 'node:fs';
import { createPool, resetData } from '../support/database.js';

const pool = createPool(5);

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Plan Rows'?: number;
  Plans?: PlanNode[];
}
const nodes = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(nodes),
];

async function plan(sql: string, params: unknown[] = []): Promise<PlanNode[]> {
  const { rows } = await pool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
    `EXPLAIN (FORMAT JSON) ${sql}`,
    params,
  );
  return nodes(rows[0]['QUERY PLAN'][0].Plan);
}
const usesIndex = (all: PlanNode[], index: string) =>
  all.some((n) => n['Index Name'] === index);
const seqScans = (all: PlanNode[]) =>
  all
    .filter((n) => n['Node Type'] === 'Seq Scan')
    .map((n) => n['Relation Name']);
const sorts = (all: PlanNode[]) =>
  all.filter(
    (n) => n['Node Type'] === 'Sort' || n['Node Type'] === 'Incremental Sort',
  );

const normalise = (text: string) => text.replace(/\s+/g, ' ');
const sourceContains = (file: string, fragment: string) =>
  normalise(
    readFileSync(new URL(`../../src/modules/${file}`, import.meta.url), 'utf8'),
  ).includes(normalise(fragment));

let hotUser: string;
let hotConversation: string;
let hotCourse: string;

beforeAll(async () => {
  await resetData(pool);
  // 300 users
  await pool.query(`INSERT INTO users (email, full_name, status, password_hash, email_verified_at)
    SELECT 'u' || g || '@example.test', 'User ' || g, 'ACTIVE', 'x', now() FROM generate_series(1, 300) g`);
  hotUser = (
    await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE email = 'u1@example.test'",
    )
  ).rows[0].id;

  // 90 000 notifications, 10% unread, spread over the users
  await pool.query(`INSERT INTO notifications (user_id, type, read_at, created_at)
    SELECT (SELECT id FROM users WHERE email = 'u' || (1 + g % 300) || '@example.test'), 'ENROLLMENT_REQUESTED',
           CASE WHEN g % 10 = 0 THEN NULL ELSE now() - interval '1 day' END, now() - (g || ' seconds')::interval
      FROM generate_series(1, 90000) g`);

  // conversations: one of 30 000 messages and 60 more of 1 000
  const c = await pool.query<{ id: string }>(
    `INSERT INTO conversations (type, title, created_by)
    SELECT 'GROUP', 'Group ' || g, $1 FROM generate_series(0, 60) g RETURNING id`,
    [hotUser],
  );
  hotConversation = c.rows[0].id;
  // members first (a message needs its sender to be a member): every user in a third of the conversations, a fifth of the memberships
  // ended, the sender of all the messages always an active member
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role, left_at)
    SELECT c.id, u.id, 'MEMBER', CASE WHEN random() < 0.2 AND u.id <> $1 THEN now() ELSE NULL END
      FROM conversations c JOIN users u ON (abs(hashtext(c.id::text || u.id::text)) % 3 = 0 OR u.id = $1)`,
    [hotUser],
  );
  await pool.query(
    `INSERT INTO messages (conversation_id, seq, sender_id, body, client_id)
    SELECT c.id, s, $1, 'message ' || s, gen_random_uuid()
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM conversations) c
      CROSS JOIN LATERAL generate_series(1, CASE WHEN c.n = 1 THEN 30000 ELSE 1000 END) s`,
    [hotUser],
  );
  await pool.query(
    `UPDATE conversations c SET last_seq = (SELECT max(seq) FROM messages m WHERE m.conversation_id = c.id)`,
  );
  // 600 published courses with 300 enrollments each is too slow; 400 courses x 75 enrollments, almost all completed
  await pool.query(`INSERT INTO categories (name, slug) VALUES ('Cat', 'cat')`);
  await pool.query(`INSERT INTO courses (title, summary, status, enrollment_policy, category_id, first_published_at)
    SELECT 'Course ' || g, 'A summary that is long enough', 'PUBLISHED', 'OPEN', (SELECT id FROM categories LIMIT 1), now()
      FROM generate_series(1, 400) g`);
  hotCourse = (
    await pool.query<{ id: string }>(
      'SELECT id FROM courses ORDER BY id LIMIT 1',
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO sections (course_id, title, position) SELECT id, 'S', 0 FROM courses`,
  );
  await pool.query(`INSERT INTO lessons (course_id, section_id, title, position, status, first_published_at)
    SELECT s.course_id, s.id, 'L' || p, p, 'PUBLISHED', now() FROM sections s CROSS JOIN generate_series(0, 4) p`);
  await pool.query(`INSERT INTO enrollments (course_id, user_id, status, first_activated_at, completed_at)
    SELECT c.id, u.id, 'ACTIVE', now(), CASE WHEN random() < 0.98 THEN now() ELSE NULL END
      FROM courses c JOIN users u ON (abs(hashtext(c.id::text || u.id::text)) % 4 = 0)`);

  // 20 000 old, unreferenced files, and a few referenced ones
  await pool.query(
    `INSERT INTO file_assets (uploaded_by, kind, storage_key, original_name, mime_type, size_bytes, created_at)
    SELECT $1, 'AVATAR', 'files/' || gen_random_uuid(), 'f.png', 'image/png', 10, now() - interval '3 days' FROM generate_series(1, 20000)`,
    [hotUser],
  );
  await pool.query(
    `UPDATE users u SET avatar_file_id = f.id FROM (SELECT id FROM file_assets ORDER BY id LIMIT 50) f WHERE u.email = 'u7@example.test'`,
  );

  // 1 500 file blocks referencing files, so the reference index of content blocks is a real choice for the planner
  await pool.query(
    `INSERT INTO content_blocks (lesson_id, position, type, file_id)
    SELECT l.id, 0, 'FILE', f.id
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM lessons LIMIT 1500) l
      JOIN (SELECT id, row_number() OVER (ORDER BY id DESC) AS rn FROM file_assets LIMIT 1500) f USING (rn)`,
  );
  for (const table of [
    'users',
    'notifications',
    'conversations',
    'messages',
    'conversation_members',
    'courses',
    'sections',
    'lessons',
    'enrollments',
    'file_assets',
    'content_blocks',
    'lesson_completions',
  ])
    await pool.query(`ANALYZE ${table}`);
}, 180000);
afterAll(async () => {
  await resetData(pool);
  await pool.end();
});

describe('unread notifications', () => {
  it('the service text is the one checked here', () => {
    expect(
      sourceContains(
        'notifications/services/notifications.service.ts',
        'SELECT count(*)::int AS n FROM notifications WHERE user_id = ${userId}::uuid AND read_at IS NULL',
      ),
    ).toBe(true);
  });
  it('the badge count uses the partial index of unread notifications, with no table scan', async () => {
    const all = await plan(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1::uuid AND read_at IS NULL',
      [hotUser],
    );
    expect(usesIndex(all, 'notifications_user_unread_idx')).toBe(true);
    expect(seqScans(all)).toEqual([]);
  });
});

describe('message history by seq', () => {
  const HISTORY = `SELECT m.id, m.seq, m.body FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = $1::uuid AND ($2::int IS NULL OR m.seq < $2::int) AND ($3::int IS NULL OR m.seq > $3::int)
    ORDER BY CASE WHEN $4 THEN m.seq END ASC, m.seq DESC LIMIT 51`;
  it('the service text is the one checked here', () => {
    expect(
      sourceContains(
        'chat/services/messages.service.ts',
        'WHERE m.conversation_id = ${conversationId}::uuid',
      ),
    ).toBe(true);
    expect(
      sourceContains('chat/services/messages.service.ts', 'LIMIT ${limit + 1}'),
    ).toBe(true);
  });
  it.each([
    ['the newest page', [null, null, false]],
    ['an older page (before=20000)', [20000, null, false]],
    ['a newer page (after=100)', [null, 100, true]],
  ])(
    '%s is read from the (conversation, seq) index, in order, without sorting the conversation',
    async (_name, [before, after, ascending]) => {
      const all = await plan(HISTORY, [
        hotConversation,
        before,
        after,
        ascending,
      ]);
      expect(usesIndex(all, 'messages_conversation_id_seq_key')).toBe(true);
      expect(seqScans(all).filter((r) => r === 'messages')).toEqual([]);
      // a sort node is acceptable only over the at-most-51 rows of one page, never over the conversation (30 000 messages here)
      for (const sort of sorts(all)) {
        const child = (sort.Plans ?? [])[0];
        expect([name, child?.['Plan Rows'] ?? 0]).toEqual([
          name,
          expect.any(Number),
        ]);
        expect(child?.['Plan Rows'] ?? 0).toBeLessThanOrEqual(200);
      }
    },
  );
});

describe('active members', () => {
  it('the service text is the one checked here', () => {
    expect(
      sourceContains(
        'chat/services/conversations.service.ts',
        'WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND left_at IS NULL',
      ),
    ).toBe(true);
    expect(
      sourceContains(
        'chat/services/chat-delivery.service.ts',
        'WHERE m.conversation_id = ${conversationId}::uuid AND m.left_at IS NULL',
      ),
    ).toBe(true);
  });
  it('the conversations of a user come from the partial index of active memberships', async () => {
    const all = await plan(
      'SELECT conversation_id FROM conversation_members WHERE user_id = $1::uuid AND left_at IS NULL',
      [hotUser],
    );
    expect(usesIndex(all, 'conversation_members_active_user_idx')).toBe(true);
    expect(seqScans(all)).toEqual([]);
  });
  it('the membership check and the recipients of a conversation use the primary key, not a scan', async () => {
    const one = await plan(
      'SELECT role FROM conversation_members WHERE conversation_id = $1::uuid AND user_id = $2::uuid AND left_at IS NULL',
      [hotConversation, hotUser],
    );
    expect(usesIndex(one, 'conversation_members_pkey')).toBe(true);
    const all = await plan(
      'SELECT user_id FROM conversation_members m WHERE m.conversation_id = $1::uuid AND m.left_at IS NULL',
      [hotConversation],
    );
    expect(usesIndex(all, 'conversation_members_pkey')).toBe(true);
    expect(seqScans(all)).toEqual([]);
  });
});

describe('completion recheck', () => {
  it('the service text is the one checked here', () => {
    expect(
      sourceContains(
        'progress/services/completion.service.ts',
        "WHERE e.course_id = ${courseId}::uuid AND e.status = 'ACTIVE' AND e.completed_at IS NULL",
      ),
    ).toBe(true);
    expect(
      sourceContains(
        'progress/services/completion.service.ts',
        "WHERE e.status = 'ACTIVE' AND e.completed_at IS NULL",
      ),
    ).toBe(true);
  });
  it('the nightly sweep finds the courses with an ACTIVE incomplete enrollment through the partial index', async () => {
    const all = await plan(`SELECT DISTINCT e.course_id FROM enrollments e
      WHERE e.status = 'ACTIVE' AND e.completed_at IS NULL
        AND EXISTS (SELECT 1 FROM lessons l WHERE l.course_id = e.course_id AND l.status = 'PUBLISHED') ORDER BY e.course_id`);
    expect(usesIndex(all, 'enrollments_active_incomplete_idx')).toBe(true);
    expect(seqScans(all).filter((r) => r === 'enrollments')).toEqual([]);
  });
  it('rechecking one course reads its incomplete enrollments, its published lessons and their completions by index', async () => {
    const all = await plan(
      `UPDATE enrollments e SET completed_at = now(), updated_at = now()
      WHERE e.course_id = $1::uuid AND e.status = 'ACTIVE' AND e.completed_at IS NULL
        AND EXISTS (SELECT 1 FROM lessons l WHERE l.course_id = e.course_id AND l.status = 'PUBLISHED')
        AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.course_id = e.course_id AND l.status = 'PUBLISHED'
              AND NOT EXISTS (SELECT 1 FROM lesson_completions lc WHERE lc.enrollment_id = e.id AND lc.lesson_id = l.id)) RETURNING e.id`,
      [hotCourse],
    );
    expect(
      usesIndex(all, 'enrollments_active_incomplete_idx') ||
        usesIndex(all, 'enrollments_course_id_status_idx'),
    ).toBe(true);
    expect(usesIndex(all, 'lessons_published_course_idx')).toBe(true);
    expect(
      seqScans(all).filter((r) => r === 'enrollments' || r === 'lessons'),
    ).toEqual([]);
  });
});

describe('the file-reference check', () => {
  const ORPHANS = `SELECT f.id, f.storage_key FROM file_assets f
    WHERE f.created_at < now() - interval '24 hours'
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.cover_file_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM content_blocks b WHERE b.file_id = f.id)
    ORDER BY f.created_at, f.id LIMIT 100`;
  it('the service text is the one checked here', () => {
    expect(
      sourceContains(
        'files/services/file-cleanup.service.ts',
        'AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)',
      ),
    ).toBe(true);
    expect(
      sourceContains(
        'files/services/file-cleanup.service.ts',
        'AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.cover_file_id = f.id)',
      ),
    ).toBe(true);
    expect(
      sourceContains(
        'files/services/file-cleanup.service.ts',
        'AND NOT EXISTS (SELECT 1 FROM content_blocks b WHERE b.file_id = f.id)',
      ),
    ).toBe(true);
  });
  it('each of the three references is checked through its own index, never by scanning the referencing table', async () => {
    const all = await plan(ORPHANS);
    expect(
      seqScans(all).filter(
        (r) => r === 'users' || r === 'courses' || r === 'content_blocks',
      ),
    ).toEqual([]);
    expect(usesIndex(all, 'users_avatar_file_id_idx')).toBe(true);
    expect(usesIndex(all, 'courses_cover_file_id_idx')).toBe(true);
    expect(usesIndex(all, 'content_blocks_file_id_key')).toBe(true);
  });
  it('deleting one file (the reference checks of the foreign keys) is answered by the same indexes', async () => {
    for (const [table, column, index] of [
      ['users', 'avatar_file_id', 'users_avatar_file_id_idx'],
      ['courses', 'cover_file_id', 'courses_cover_file_id_idx'],
      ['content_blocks', 'file_id', 'content_blocks_file_id_key'],
    ]) {
      const all = await plan(
        `SELECT 1 FROM ${table} WHERE ${column} = $1::uuid`,
        ['018f0000-0000-7000-8000-0000000000aa'],
      );
      expect([table, usesIndex(all, index)]).toEqual([table, true]);
    }
  });
});
