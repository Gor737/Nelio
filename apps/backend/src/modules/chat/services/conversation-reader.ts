import type { PrismaClient } from '../../../generated/prisma/client.js';
import type {
  ConversationDto,
  ConversationTypeName,
  MemberRoleName,
  MessageDto,
} from '../dto/chat.dto.js';

export type ChatDb = Pick<PrismaClient, '$queryRaw'>;

interface ConversationRow {
  id: string;
  type: ConversationTypeName;
  title: string | null;
  course_id: string | null;
  course_title: string | null;
  course_status: string | null;
  course_locked: Date | null;
  created_at: Date;
  last_message_at: Date | null;
  last_seq: number;
  role: MemberRoleName;
  is_muted: boolean;
  last_read_seq: number;
  member_count: number;
  unread: number;
  peer_id: string | null;
  peer_name: string | null;
  peer_key: string | null;
}

/**
 * The conversations `userId` is an ACTIVE member of, as response objects, in ONE statement (unread counts, member counts, the other
 * person of a DM and the read-only flag of a course channel included). `conversationId` limits it to one; `visibleOnly` hides the
 * direct conversations nobody has written in yet (Decision 131: an empty DM exists but is not listed). `avatarUrl` turns a storage key
 * into a public URL (Files owns that).
 */
export async function readConversations(
  db: ChatDb,
  userId: string,
  options: {
    conversationId?: string;
    visibleOnly?: boolean;
    limit?: number;
    offset?: number;
    avatarUrl: (storageKey: string | null) => string | null;
  },
): Promise<{ items: ConversationDto[]; total: number }> {
  const one = options.conversationId ?? null;
  const visibleOnly = options.visibleOnly ?? false;
  const limit = options.limit ?? 1000;
  const offset = options.offset ?? 0;
  const rows = await db.$queryRaw<(ConversationRow & { total: number })[]>`
    SELECT c.id, c.type, c.title, c.course_id, co.title AS course_title, co.status AS course_status,
           co.locked_by_admin_at AS course_locked, c.created_at, c.last_message_at, c.last_seq,
           m.role, m.is_muted, m.last_read_seq,
           (SELECT count(*)::int FROM conversation_members x WHERE x.conversation_id = c.id AND x.left_at IS NULL) AS member_count,
           (SELECT count(*)::int FROM messages g
             WHERE g.conversation_id = c.id AND g.seq > m.last_read_seq AND g.sender_id <> m.user_id AND g.deleted_at IS NULL) AS unread,
           peer.id AS peer_id, peer.full_name AS peer_name, pf.storage_key AS peer_key,
           count(*) OVER ()::int AS total
      FROM conversation_members m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN courses co ON co.id = c.course_id
      LEFT JOIN direct_conversations d ON d.conversation_id = c.id
      LEFT JOIN users peer ON peer.id = CASE WHEN d.conversation_id IS NULL THEN NULL
                                             WHEN d.user_a_id = m.user_id THEN d.user_b_id ELSE d.user_a_id END
      LEFT JOIN file_assets pf ON pf.id = peer.avatar_file_id
     WHERE m.user_id = ${userId}::uuid AND m.left_at IS NULL
       AND (${one}::uuid IS NULL OR c.id = ${one}::uuid)
       AND (${visibleOnly}::boolean = false OR c.type <> 'DIRECT' OR c.last_message_at IS NOT NULL)
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id
     LIMIT ${limit} OFFSET ${offset}`;
  return {
    total: rows[0]?.total ?? 0,
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.type === 'COURSE_CHANNEL' ? r.course_title : r.title,
      courseId: r.course_id,
      peer:
        r.peer_id && r.peer_name
          ? {
              id: r.peer_id,
              fullName: r.peer_name,
              avatarUrl: options.avatarUrl(r.peer_key),
            }
          : null,
      memberCount: r.member_count,
      myRole: r.role,
      isMuted: r.is_muted,
      unreadCount: r.unread,
      lastSeq: r.last_seq,
      lastReadSeq: r.last_read_seq,
      lastMessageAt: r.last_message_at,
      readOnly:
        r.type === 'COURSE_CHANNEL' &&
        (r.course_status === 'ARCHIVED' || r.course_locked !== null),
      createdAt: r.created_at,
    })),
  };
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  sender_id: string;
  sender_name: string;
  body: string;
  client_id: string;
  edited_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
}

export const MESSAGE_COLUMNS = `m.id, m.conversation_id, m.seq, m.sender_id, u.full_name AS sender_name, m.body, m.client_id, m.edited_at, m.deleted_at, m.created_at`;

/** A message as the API shows it. A deleted message keeps its row and its seq but returns no text (Decisions 32, 86). */
export function toMessageDto(row: MessageRow): MessageDto {
  const deleted = row.deleted_at !== null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    sender: { id: row.sender_id, fullName: row.sender_name },
    body: deleted ? null : row.body,
    clientId: row.client_id,
    deleted,
    editedAt: row.edited_at,
    createdAt: row.created_at,
  };
}

export async function readMessage(
  db: ChatDb,
  messageId: string,
): Promise<MessageDto | null> {
  const rows = await db.$queryRaw<MessageRow[]>`
    SELECT m.id, m.conversation_id, m.seq, m.sender_id, u.full_name AS sender_name, m.body, m.client_id, m.edited_at, m.deleted_at, m.created_at
      FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ${messageId}::uuid`;
  return rows[0] ? toMessageDto(rows[0]) : null;
}
