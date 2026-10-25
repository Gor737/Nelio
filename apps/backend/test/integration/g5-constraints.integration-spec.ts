// M7 constraint tests for schema group G5 (Conversation, DirectConversation, ConversationMember, Message, Report) against a real
// PostgreSQL database built from the migration files. Every hand-written object (Decision 102) has a test that tries to break it.
import { randomUUID } from 'node:crypto';
import { TEXT_LIMITS } from '../../src/common/constants/limits.js';
import { createPool, resetData } from '../support/database.js';
import { createAdmin, createUser } from '../support/factories.js';
import { createCourse } from '../support/factories-courses.js';
import {
  addMember,
  createChannel,
  createConversation,
  createDirectConversation,
  createDirectRow,
  createGroup,
  createMessage,
  createReport,
  orderedPair,
  reportMessage,
  reportUser,
} from '../support/factories-chat.js';
import { SQLSTATE, sqlError } from '../support/sql.js';

describe('G5 schema (real PostgreSQL, built from migrations)', () => {
  const pool = createPool();
  beforeEach(() => resetData(pool));
  afterAll(() => pool.end());

  const indexDef = async (name: string) =>
    (
      await pool.query<{ d: string }>(
        'SELECT indexdef AS d FROM pg_indexes WHERE schemaname = $1 AND indexname = $2',
        ['public', name],
      )
    ).rows[0]?.d;
  const count = async (table: string) =>
    (await pool.query(`SELECT 1 FROM ${table}`)).rowCount;
  const edge = (n: number) => 'x'.repeat(n);

  /** A group with a creator and two members, and one message by the creator. */
  async function chat() {
    const [creator, member, outsider] = [
      await createUser(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    const conversation = await createGroup(pool, creator.id, [member.id]);
    const message = await createMessage(pool, conversation, creator.id);
    return { creator, member, outsider, conversation, message };
  }

  describe('structure', () => {
    it('has the five G5 tables and the enums', async () => {
      const tables = (
        await pool.query<{ n: string }>(
          "SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'",
        )
      ).rows.map((r) => r.n);
      for (const t of [
        'conversation_members',
        'conversations',
        'direct_conversations',
        'messages',
        'reports',
      ])
        expect(tables).toContain(t);
      const enums = await pool.query<{ t: string; v: string }>(
        `SELECT t.typname AS t, e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname IN ('conversation_type', 'conversation_member_role', 'report_target_type', 'report_reason', 'report_status')
         ORDER BY t.typname, e.enumsortorder`,
      );
      const of = (t: string) =>
        enums.rows.filter((r) => r.t === t).map((r) => r.v);
      expect(of('conversation_type')).toEqual([
        'DIRECT',
        'GROUP',
        'COURSE_CHANNEL',
      ]);
      expect(of('conversation_member_role')).toEqual(['MEMBER', 'ADMIN']);
      expect(of('report_target_type')).toEqual(['MESSAGE', 'USER']);
      expect(of('report_reason')).toEqual([
        'SPAM',
        'HARASSMENT',
        'INAPPROPRIATE',
        'OTHER',
      ]);
      expect(of('report_status')).toEqual(['OPEN', 'DISMISSED', 'ACTIONED']);
    });
  });

  // ---- Conversation -------------------------------------------------------------------------------------------------------

  describe('Conversation', () => {
    it('a second channel for the same course is rejected; a channel for another course is fine', async () => {
      const course = await createCourse(pool);
      await createChannel(pool, course);
      expect(await sqlError(createChannel(pool, course))).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'conversations_course_id_key',
      });
      await createChannel(pool, await createCourse(pool));
    });

    it.each([
      ['DIRECT with a title', { type: 'DIRECT', title: 'x' }],
      ['DIRECT with a course', { type: 'DIRECT', course: true }],
      ['GROUP without a title', { type: 'GROUP' }],
      ['GROUP with a course', { type: 'GROUP', title: 'x', course: true }],
      ['COURSE_CHANNEL without a course', { type: 'COURSE_CHANNEL' }],
      [
        'COURSE_CHANNEL with a title',
        { type: 'COURSE_CHANNEL', title: 'x', course: true },
      ],
    ] as const)('%s is rejected', async (_label, shape) => {
      const courseId = 'course' in shape ? await createCourse(pool) : null;
      expect(
        await sqlError(
          createConversation(pool, {
            type: shape.type,
            title: 'title' in shape ? shape.title : null,
            courseId,
          }),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'conversations_type_shape',
      });
    });

    it('accepts the three valid shapes', async () => {
      const user = await createUser(pool);
      await createConversation(pool, { type: 'DIRECT', createdBy: user.id });
      await createConversation(pool, {
        type: 'GROUP',
        title: 'Study group',
        createdBy: user.id,
      });
      await createChannel(pool, await createCourse(pool));
    });

    it('group title length follows TEXT_LIMITS.GROUP_TITLE (boundaries on both sides)', async () => {
      const { min, max } = TEXT_LIMITS.GROUP_TITLE;
      const group = (title: string) =>
        createConversation(pool, { type: 'GROUP', title });
      await group(edge(min));
      await group(edge(max));
      expect(await sqlError(group(''))).toMatchObject({
        constraint: 'conversations_title_length',
      });
      expect(await sqlError(group(edge(max + 1)))).toMatchObject({
        constraint: 'conversations_title_length',
      });
    });

    it('last_seq starts at 0 and cannot go negative', async () => {
      const id = await createConversation(pool, { type: 'DIRECT' });
      const { rows } = await pool.query(
        'SELECT last_seq FROM conversations WHERE id = $1',
        [id],
      );
      expect(rows[0].last_seq).toBe(0);
      expect(
        await sqlError(
          pool.query('UPDATE conversations SET last_seq = -1 WHERE id = $1', [
            id,
          ]),
        ),
      ).toMatchObject({
        constraint: 'conversations_last_seq_nonneg',
      });
    });

    it('a course that has a channel cannot be deleted (RESTRICT)', async () => {
      const course = await createCourse(pool);
      await createChannel(pool, course);
      expect(
        await sqlError(
          pool.query('DELETE FROM courses WHERE id = $1', [course]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.RESTRICT_VIOLATION,
      });
    });

    it('a conversation that has messages cannot be deleted (RESTRICT); an empty one is deleted with its members and pair (CASCADE)', async () => {
      const { conversation } = await chat();
      expect(
        await sqlError(
          pool.query('DELETE FROM conversations WHERE id = $1', [conversation]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.RESTRICT_VIOLATION,
      });
      const [x, y] = [await createUser(pool), await createUser(pool)];
      const dm = await createDirectConversation(pool, x.id, y.id);
      await pool.query('DELETE FROM conversations WHERE id = $1', [dm]);
      expect(
        (
          await pool.query(
            'SELECT 1 FROM direct_conversations WHERE conversation_id = $1',
            [dm],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query(
            'SELECT 1 FROM conversation_members WHERE conversation_id = $1',
            [dm],
          )
        ).rowCount,
      ).toBe(0);
    });
  });

  // ---- DirectConversation -------------------------------------------------------------------------------------------------

  describe('DirectConversation', () => {
    it('the pair is stored ordered: (A, B) is accepted and (B, A) is rejected', async () => {
      const [x, y] = [await createUser(pool), await createUser(pool)];
      const [a, b] = orderedPair(x.id, y.id);
      const conversation = await createConversation(pool, { type: 'DIRECT' });
      expect(
        await sqlError(createDirectRow(pool, conversation, b, a)),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'direct_conversations_ordered_pair',
      });
      await createDirectRow(pool, conversation, a, b);
    });

    it('a second DM for the same pair is rejected, in either order', async () => {
      const [x, y] = [await createUser(pool), await createUser(pool)];
      await createDirectConversation(pool, x.id, y.id);
      const [a, b] = orderedPair(x.id, y.id);
      const second = await createConversation(pool, { type: 'DIRECT' });
      expect(await sqlError(createDirectRow(pool, second, a, b))).toMatchObject(
        {
          sqlstate: SQLSTATE.UNIQUE_VIOLATION,
          constraint: 'direct_conversations_user_a_id_user_b_id_key',
        },
      );
      const third = await createConversation(pool, { type: 'DIRECT' });
      expect(await sqlError(createDirectRow(pool, third, b, a))).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
      });
    });

    it('a DM with oneself is rejected (a < b is strict)', async () => {
      const user = await createUser(pool);
      const conversation = await createConversation(pool, { type: 'DIRECT' });
      expect(
        await sqlError(createDirectRow(pool, conversation, user.id, user.id)),
      ).toMatchObject({
        constraint: 'direct_conversations_ordered_pair',
      });
    });

    it('a user in a DM cannot be deleted (RESTRICT)', async () => {
      const [x, y] = [await createUser(pool), await createUser(pool)];
      await createDirectConversation(pool, x.id, y.id);
      expect(
        await sqlError(pool.query('DELETE FROM users WHERE id = $1', [x.id])),
      ).toMatchObject({
        sqlstate: SQLSTATE.RESTRICT_VIOLATION,
      });
    });
  });

  // ---- ConversationMember -------------------------------------------------------------------------------------------------

  describe('ConversationMember', () => {
    it('the same user twice in one conversation is rejected', async () => {
      const { conversation, member } = await chat();
      expect(
        await sqlError(addMember(pool, conversation, member.id)),
      ).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'conversation_members_pkey',
      });
    });

    it('defaults: role MEMBER, last_read_seq 0, not muted, joined now, not left', async () => {
      const { conversation, member } = await chat();
      const { rows } = await pool.query(
        'SELECT role, last_read_seq, is_muted, left_at, joined_at IS NOT NULL AS joined FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversation, member.id],
      );
      expect(rows[0]).toEqual({
        role: 'MEMBER',
        last_read_seq: 0,
        is_muted: false,
        left_at: null,
        joined: true,
      });
    });

    it('a member who sent messages cannot be removed as a row (RESTRICT): leaving sets left_at instead', async () => {
      const { conversation, creator } = await chat();
      expect(
        await sqlError(
          pool.query(
            'DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
            [conversation, creator.id],
          ),
        ),
      ).toMatchObject({ sqlstate: SQLSTATE.RESTRICT_VIOLATION });
      await pool.query(
        'UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2',
        [conversation, creator.id],
      );
    });

    it('a member who sent nothing can be removed', async () => {
      const { conversation, member } = await chat();
      await pool.query(
        'DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversation, member.id],
      );
    });
  });

  // ---- Message ------------------------------------------------------------------------------------------------------------

  describe('Message', () => {
    it('a message from a user who was never a member is rejected (composite foreign key to ConversationMember)', async () => {
      const { conversation, outsider } = await chat();
      expect(
        await sqlError(createMessage(pool, conversation, outsider.id)),
      ).toMatchObject({
        sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION,
        constraint: 'messages_conversation_id_sender_id_fkey',
      });
    });

    it('a member of ANOTHER conversation cannot post here', async () => {
      const { conversation } = await chat();
      const [x, y] = [await createUser(pool), await createUser(pool)];
      await createDirectConversation(pool, x.id, y.id);
      expect(
        await sqlError(createMessage(pool, conversation, x.id)),
      ).toMatchObject({
        sqlstate: SQLSTATE.FOREIGN_KEY_VIOLATION,
      });
    });

    it('a former member still has the row, so history stays valid (the service decides who may send)', async () => {
      const { conversation, member } = await chat();
      await createMessage(pool, conversation, member.id);
      await pool.query(
        'UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2',
        [conversation, member.id],
      );
      expect(await count('messages')).toBe(2);
    });

    it('a duplicate seq in one conversation is rejected; the same seq in another conversation is fine', async () => {
      const { conversation, creator } = await chat(); // message seq 1 exists
      expect(
        await sqlError(
          createMessage(pool, conversation, creator.id, { seq: 1 }),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'messages_conversation_id_seq_key',
      });
      const other = await createGroup(pool, creator.id);
      await createMessage(pool, other, creator.id, { seq: 1 });
    });

    it('a duplicate (sender, client_id) is rejected even in another conversation; another sender may reuse the client_id', async () => {
      const { conversation, creator, member } = await chat();
      const clientId = randomUUID();
      await createMessage(pool, conversation, creator.id, { clientId });
      expect(
        await sqlError(
          createMessage(pool, conversation, creator.id, { clientId }),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'messages_sender_id_client_id_key',
      });
      const other = await createGroup(pool, creator.id);
      expect(
        await sqlError(createMessage(pool, other, creator.id, { clientId })),
      ).toMatchObject({
        constraint: 'messages_sender_id_client_id_key',
      });
      await createMessage(pool, conversation, member.id, { clientId });
    });

    it('a rolled-back duplicate send leaves no seq gap: the failed insert is undone with its transaction', async () => {
      const { conversation, creator } = await chat();
      const clientId = randomUUID();
      await createMessage(pool, conversation, creator.id, { clientId, seq: 2 });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await expect(
          client.query(
            'INSERT INTO messages (conversation_id, seq, sender_id, body, client_id) VALUES ($1, 3, $2, $3, $4)',
            [conversation, creator.id, 'dup', clientId],
          ),
        ).rejects.toMatchObject({ code: SQLSTATE.UNIQUE_VIOLATION });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      const { rows } = await pool.query(
        'SELECT array_agg(seq ORDER BY seq) AS s FROM messages WHERE conversation_id = $1',
        [conversation],
      );
      expect(rows[0].s).toEqual([1, 2]);
    });

    it('body length follows TEXT_LIMITS.MESSAGE_BODY: min and max accepted, empty and max+1 rejected', async () => {
      const { conversation, creator } = await chat();
      const { min, max } = TEXT_LIMITS.MESSAGE_BODY;
      await createMessage(pool, conversation, creator.id, { body: edge(min) });
      await createMessage(pool, conversation, creator.id, { body: edge(max) });
      expect(
        await sqlError(
          createMessage(pool, conversation, creator.id, { body: '' }),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'messages_body_length',
      });
      expect(
        await sqlError(
          createMessage(pool, conversation, creator.id, {
            body: edge(max + 1),
          }),
        ),
      ).toMatchObject({
        constraint: 'messages_body_length',
      });
    });

    it('deleted_at and deleted_by are set together; a soft-deleted message keeps its text', async () => {
      const { conversation, creator, message } = await chat();
      expect(
        await sqlError(
          pool.query('UPDATE messages SET deleted_at = now() WHERE id = $1', [
            message,
          ]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.CHECK_VIOLATION,
        constraint: 'messages_deleted_pair',
      });
      expect(
        await sqlError(
          pool.query('UPDATE messages SET deleted_by = $1 WHERE id = $2', [
            creator.id,
            message,
          ]),
        ),
      ).toMatchObject({
        constraint: 'messages_deleted_pair',
      });
      await pool.query(
        'UPDATE messages SET deleted_at = now(), deleted_by = $1 WHERE id = $2',
        [creator.id, message],
      );
      const { rows } = await pool.query(
        'SELECT body FROM messages WHERE id = $1',
        [message],
      );
      expect(rows[0].body).toBe('hello');
      expect(conversation).toBeDefined();
    });

    it('the user who deleted a message cannot be deleted (RESTRICT)', async () => {
      const { creator, message } = await chat();
      const moderator = await createAdmin(pool);
      await pool.query(
        'UPDATE messages SET deleted_at = now(), deleted_by = $1 WHERE id = $2',
        [moderator.id, message],
      );
      expect(
        await sqlError(
          pool.query('DELETE FROM users WHERE id = $1', [moderator.id]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.RESTRICT_VIOLATION,
      });
      expect(creator).toBeDefined();
    });
  });

  // ---- Report -------------------------------------------------------------------------------------------------------------

  describe('Report target shape', () => {
    it('accepts a message report with a snapshot and a user report without one', async () => {
      const { creator, member, message } = await chat();
      await reportMessage(pool, member.id, message);
      await reportUser(pool, member.id, creator.id);
    });

    it('rejects a report with two targets, with none, with a target that does not match target_type, or with a wrong snapshot', async () => {
      const { creator, member, message } = await chat();
      const shapeError = async (promise: Promise<unknown>) =>
        expect(await sqlError(promise)).toMatchObject({
          sqlstate: SQLSTATE.CHECK_VIOLATION,
          constraint: 'reports_target_shape',
        });
      await shapeError(
        createReport(pool, member.id, {
          targetType: 'MESSAGE',
          messageId: message,
          targetUserId: creator.id,
          snapshot: {},
        }),
      ); // two targets
      await shapeError(
        createReport(pool, member.id, {
          targetType: 'USER',
          messageId: message,
          targetUserId: creator.id,
        }),
      ); // two targets
      await shapeError(
        createReport(pool, member.id, { targetType: 'MESSAGE', snapshot: {} }),
      ); // none
      await shapeError(createReport(pool, member.id, { targetType: 'USER' })); // none
      await shapeError(
        createReport(pool, member.id, {
          targetType: 'USER',
          messageId: message,
        }),
      ); // message target on a USER report
      await shapeError(
        createReport(pool, member.id, {
          targetType: 'MESSAGE',
          targetUserId: creator.id,
          snapshot: {},
        }),
      ); // user target on a MESSAGE report
      await shapeError(
        createReport(pool, member.id, {
          targetType: 'MESSAGE',
          messageId: message,
        }),
      ); // MESSAGE without snapshot
      await shapeError(
        createReport(pool, member.id, {
          targetType: 'USER',
          targetUserId: creator.id,
          snapshot: {},
        }),
      ); // USER with snapshot
    });

    it('reviewed_by and reviewed_at are set together', async () => {
      const { creator, member } = await chat();
      const admin = await createAdmin(pool);
      expect(
        await sqlError(
          reportUser(pool, member.id, creator.id, { reviewedBy: admin.id }),
        ),
      ).toMatchObject({
        constraint: 'reports_reviewed_pair',
      });
      expect(
        await sqlError(
          reportUser(pool, member.id, creator.id, { reviewedAt: new Date() }),
        ),
      ).toMatchObject({
        constraint: 'reports_reviewed_pair',
      });
      await reportUser(pool, member.id, creator.id, {
        status: 'DISMISSED',
        reviewedBy: admin.id,
        reviewedAt: new Date(),
      });
    });

    it('description and resolution note lengths follow TEXT_LIMITS (1-1000), and may be NULL', async () => {
      const { creator, member } = await chat();
      const admin = await createAdmin(pool);
      const max = TEXT_LIMITS.REPORT_DESCRIPTION.max;
      await reportUser(pool, member.id, creator.id, { description: edge(max) });
      expect(
        await sqlError(
          reportUser(pool, admin.id, creator.id, { description: '' }),
        ),
      ).toMatchObject({
        constraint: 'reports_description_length',
      });
      expect(
        await sqlError(
          reportUser(pool, admin.id, creator.id, {
            description: edge(max + 1),
          }),
        ),
      ).toMatchObject({
        constraint: 'reports_description_length',
      });
      expect(
        await sqlError(
          reportUser(pool, admin.id, creator.id, {
            status: 'ACTIONED',
            reviewedBy: admin.id,
            reviewedAt: new Date(),
            resolutionNote: edge(TEXT_LIMITS.REPORT_RESOLUTION_NOTE.max + 1),
          }),
        ),
      ).toMatchObject({ constraint: 'reports_resolution_note_length' });
    });
  });

  describe('Report duplicates', () => {
    it('a second OPEN report of the same message by the same reporter is rejected', async () => {
      const { member, message } = await chat();
      await reportMessage(pool, member.id, message);
      expect(
        await sqlError(
          reportMessage(pool, member.id, message, { reason: 'HARASSMENT' }),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'reports_open_message_unique',
      });
    });

    it('a second OPEN report of the same user by the same reporter is rejected', async () => {
      const { creator, member } = await chat();
      await reportUser(pool, member.id, creator.id);
      expect(
        await sqlError(reportUser(pool, member.id, creator.id)),
      ).toMatchObject({
        sqlstate: SQLSTATE.UNIQUE_VIOLATION,
        constraint: 'reports_open_user_unique',
      });
    });

    it('a new report is accepted after the previous one was resolved (DISMISSED or ACTIONED)', async () => {
      const { creator, member, message } = await chat();
      const admin = await createAdmin(pool);
      const resolved = {
        status: 'DISMISSED' as const,
        reviewedBy: admin.id,
        reviewedAt: new Date(),
      };
      await reportMessage(pool, member.id, message, resolved);
      await reportMessage(pool, member.id, message); // a new OPEN one
      await reportUser(pool, member.id, creator.id, {
        ...resolved,
        status: 'ACTIONED',
      });
      await reportUser(pool, member.id, creator.id);
    });

    it('different reporters may each have an OPEN report on the same target', async () => {
      const { creator, member, outsider, message } = await chat();
      await reportMessage(pool, member.id, message);
      await reportMessage(pool, outsider.id, message);
      await reportUser(pool, member.id, creator.id);
      await reportUser(pool, outsider.id, creator.id);
    });

    it('resolving an OPEN report through UPDATE frees the slot for a new one', async () => {
      const { member, message } = await chat();
      const admin = await createAdmin(pool);
      const id = await reportMessage(pool, member.id, message);
      await pool.query(
        "UPDATE reports SET status = 'ACTIONED', reviewed_by = $1, reviewed_at = now() WHERE id = $2",
        [admin.id, id],
      );
      await reportMessage(pool, member.id, message);
    });
  });

  describe('Report delete behavior', () => {
    it('a reported message cannot be deleted (RESTRICT)', async () => {
      const { member, message } = await chat();
      await reportMessage(pool, member.id, message);
      expect(
        await sqlError(
          pool.query('DELETE FROM messages WHERE id = $1', [message]),
        ),
      ).toMatchObject({
        sqlstate: SQLSTATE.RESTRICT_VIOLATION,
      });
    });

    it('the reporter, the reported user and the reviewer cannot be deleted (RESTRICT)', async () => {
      const { creator, member } = await chat();
      const admin = await createAdmin(pool);
      await reportUser(pool, member.id, creator.id, {
        status: 'DISMISSED',
        reviewedBy: admin.id,
        reviewedAt: new Date(),
      });
      for (const user of [member, creator, admin])
        expect(
          await sqlError(
            pool.query('DELETE FROM users WHERE id = $1', [user.id]),
          ),
        ).toMatchObject({
          sqlstate: SQLSTATE.RESTRICT_VIOLATION,
        });
    });
  });

  // ---- indexes ------------------------------------------------------------------------------------------------------------

  describe('indexes', () => {
    it('have the documented definitions', async () => {
      expect(await indexDef('conversation_members_active_user_idx')).toMatch(
        /\(user_id\) WHERE \(left_at IS NULL\)/,
      );
      expect(await indexDef('reports_open_message_unique')).toMatch(
        /UNIQUE INDEX .*\(reporter_id, message_id\) WHERE \(\(status = 'OPEN'::report_status\) AND \(message_id IS NOT NULL\)\)/,
      );
      expect(await indexDef('reports_open_user_unique')).toMatch(
        /UNIQUE INDEX .*\(reporter_id, target_user_id\) WHERE \(\(status = 'OPEN'::report_status\) AND \(target_user_id IS NOT NULL\)\)/,
      );
      expect(await indexDef('reports_status_created_at_idx')).toContain(
        '(status, created_at)',
      );
      expect(await indexDef('reports_message_id_idx')).toContain(
        '(message_id)',
      );
      expect(await indexDef('reports_target_user_id_idx')).toContain(
        '(target_user_id)',
      );
      expect(await indexDef('messages_conversation_id_seq_key')).toMatch(
        /UNIQUE INDEX .*\(conversation_id, seq\)/,
      );
      expect(await indexDef('messages_sender_id_client_id_key')).toMatch(
        /UNIQUE INDEX .*\(sender_id, client_id\)/,
      );
    });

    it('the active-member partial index is used for "my conversations"', async () => {
      const user = await createUser(pool);
      for (let i = 0; i < 20; i++) {
        const group = await createGroup(pool, (await createUser(pool)).id);
        await addMember(pool, group, user.id, {
          leftAt: i % 2 ? new Date() : null,
        });
      }
      await pool.query('ANALYZE conversation_members');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(
          'EXPLAIN SELECT conversation_id FROM conversation_members WHERE user_id = $1 AND left_at IS NULL',
          [user.id],
        );
        expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
          'conversation_members_active_user_idx',
        );
        await client.query('ROLLBACK');
      } finally {
        client.release(true);
      }
    });
  });
});
