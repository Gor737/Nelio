// Factories for schema group G5 (conversations, members, messages, reports): direct INSERTs through the pool, no service code.
import { randomUUID } from 'node:crypto';
import type { Queryable } from './database.js';
import { unique } from './factories.js';

/** A bare conversation row; pass any combination of columns to build valid or invalid shapes. */
export async function createConversation(
  q: Queryable,
  overrides: {
    type: 'DIRECT' | 'GROUP' | 'COURSE_CHANNEL';
    title?: string | null;
    courseId?: string | null;
    createdBy?: string | null;
  },
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    'INSERT INTO conversations (type, title, course_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [
      overrides.type,
      overrides.title ?? null,
      overrides.courseId ?? null,
      overrides.createdBy ?? null,
    ],
  );
  return rows[0].id;
}

export async function addMember(
  q: Queryable,
  conversationId: string,
  userId: string,
  overrides: { role?: 'MEMBER' | 'ADMIN'; leftAt?: Date | null } = {},
): Promise<void> {
  await q.query(
    'INSERT INTO conversation_members (conversation_id, user_id, role, left_at) VALUES ($1, $2, $3, $4)',
    [
      conversationId,
      userId,
      overrides.role ?? 'MEMBER',
      overrides.leftAt ?? null,
    ],
  );
}

/** The two ids in the order the CHECK requires (user_a_id < user_b_id). */
export const orderedPair = (x: string, y: string): [string, string] =>
  x < y ? [x, y] : [y, x];

export async function createDirectRow(
  q: Queryable,
  conversationId: string,
  userAId: string,
  userBId: string,
): Promise<void> {
  await q.query(
    'INSERT INTO direct_conversations (conversation_id, user_a_id, user_b_id) VALUES ($1, $2, $3)',
    [conversationId, userAId, userBId],
  );
}

/** A complete DM: conversation, ordered pair row and both members. */
export async function createDirectConversation(
  q: Queryable,
  userX: string,
  userY: string,
): Promise<string> {
  const id = await createConversation(q, { type: 'DIRECT', createdBy: userX });
  const [a, b] = orderedPair(userX, userY);
  await createDirectRow(q, id, a, b);
  await addMember(q, id, userX);
  await addMember(q, id, userY);
  return id;
}

/** A group with its creator as ADMIN and the other users as MEMBERs. */
export async function createGroup(
  q: Queryable,
  creatorId: string,
  memberIds: string[] = [],
  title = `Group ${unique()}`,
): Promise<string> {
  const id = await createConversation(q, {
    type: 'GROUP',
    title,
    createdBy: creatorId,
  });
  await addMember(q, id, creatorId, { role: 'ADMIN' });
  for (const m of memberIds) await addMember(q, id, m);
  return id;
}

export const createChannel = (q: Queryable, courseId: string) =>
  createConversation(q, { type: 'COURSE_CHANNEL', courseId });

export interface MessageOverrides {
  seq?: number;
  body?: string;
  clientId?: string;
  deletedAt?: Date | null;
  deletedBy?: string | null;
}

/** A message with an explicit or next `seq`. It does not touch conversations.last_seq (tests that need it set it themselves). */
export async function createMessage(
  q: Queryable,
  conversationId: string,
  senderId: string,
  overrides: MessageOverrides = {},
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, seq, sender_id, body, client_id, deleted_at, deleted_by)
     VALUES ($1,
             COALESCE($2::int, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = $1)),
             $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      conversationId,
      overrides.seq ?? null,
      senderId,
      overrides.body ?? 'hello',
      overrides.clientId ?? randomUUID(),
      overrides.deletedAt ?? null,
      overrides.deletedBy ?? null,
    ],
  );
  return rows[0].id;
}

export interface ReportOverrides {
  targetType: 'MESSAGE' | 'USER';
  messageId?: string | null;
  targetUserId?: string | null;
  snapshot?: unknown;
  reason?: 'SPAM' | 'HARASSMENT' | 'INAPPROPRIATE' | 'OTHER';
  description?: string | null;
  status?: 'OPEN' | 'DISMISSED' | 'ACTIONED';
  reviewedBy?: string | null;
  reviewedAt?: Date | null;
  resolutionNote?: string | null;
}

/** A report with exactly the given columns (no target defaults), so invalid target shapes can be tried. */
export async function createReport(
  q: Queryable,
  reporterId: string,
  overrides: ReportOverrides,
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO reports (reporter_id, target_type, message_id, target_user_id, reason, description, message_snapshot,
                          status, reviewed_by, reviewed_at, resolution_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) RETURNING id`,
    [
      reporterId,
      overrides.targetType,
      overrides.messageId ?? null,
      overrides.targetUserId ?? null,
      overrides.reason ?? 'SPAM',
      overrides.description ?? null,
      overrides.snapshot === undefined
        ? null
        : JSON.stringify(overrides.snapshot),
      overrides.status ?? 'OPEN',
      overrides.reviewedBy ?? null,
      overrides.reviewedAt ?? null,
      overrides.resolutionNote ?? null,
    ],
  );
  return rows[0].id;
}

export const reportMessage = (
  q: Queryable,
  reporterId: string,
  messageId: string,
  overrides: Partial<ReportOverrides> = {},
) =>
  createReport(q, reporterId, {
    targetType: 'MESSAGE',
    messageId,
    snapshot: { body: 'hello' },
    ...overrides,
  });

export const reportUser = (
  q: Queryable,
  reporterId: string,
  targetUserId: string,
  overrides: Partial<ReportOverrides> = {},
) =>
  createReport(q, reporterId, {
    targetType: 'USER',
    targetUserId,
    ...overrides,
  });
