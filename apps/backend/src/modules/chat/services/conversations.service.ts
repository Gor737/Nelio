import { Injectable } from '@nestjs/common';
import { COUNT_LIMITS } from '../../../common/constants/limits.js';
import { ApiException } from '../../../common/filters/index.js';
import {
  PrismaService,
  TransactionService,
  type Tx,
  isUniqueViolation,
} from '../../../infrastructure/database/index.js';
import { emitAfterCommit } from '../../../infrastructure/events/index.js';
import { FilesService } from '../../files/index.js';
import {
  BlockService,
  MEMBERS_UNAVAILABLE_MESSAGE,
} from '../../moderation/index.js';
import type { ConversationDto, ConversationsPageDto } from '../dto/chat.dto.js';
import { type ChatDb, readConversations } from './conversation-reader.js';

/** The ids among `ids` that are ACTIVE (not suspended) users. */
export async function activeUserIds(
  db: ChatDb,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM users WHERE id = ANY(${[...ids]}::uuid[]) AND status = 'ACTIVE'`;
  return new Set(rows.map((r) => r.id));
}

/** Locks the Conversation row (the mutex of its membership and its message sequence) and returns its type. 404 when it does not exist. */
export async function lockConversation(
  tx: Tx,
  conversationId: string,
): Promise<{
  type: 'DIRECT' | 'GROUP' | 'COURSE_CHANNEL';
  courseId: string | null;
}> {
  const rows = await tx.$queryRaw<
    { type: 'DIRECT' | 'GROUP' | 'COURSE_CHANNEL'; course_id: string | null }[]
  >`SELECT type, course_id FROM conversations WHERE id = ${conversationId}::uuid FOR NO KEY UPDATE`;
  if (rows.length === 0) throw new ApiException('NOT_FOUND');
  return { type: rows[0].type, courseId: rows[0].course_id };
}

/** The caller's ACTIVE membership of a conversation, read after the conversation lock; a non-member or a former member is 404. */
export async function requireMember(
  db: ChatDb,
  conversationId: string,
  userId: string,
): Promise<{ role: 'MEMBER' | 'ADMIN' }> {
  const rows = await db.$queryRaw<{ role: 'MEMBER' | 'ADMIN' }[]>`
    SELECT role FROM conversation_members
     WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND left_at IS NULL`;
  if (rows.length === 0) throw new ApiException('NOT_FOUND');
  return rows[0];
}

/**
 * Conversations: get-or-create a direct conversation, create a group, read one, list mine, rename, mute (Decisions 26, 80, 83, 84, 131).
 * A non-member and a former member always get 404, never 403, so nothing leaks about conversations you are not in.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly blocks: BlockService,
    private readonly files: FilesService,
  ) {}

  private readonly avatarUrl = (key: string | null): string | null =>
    key ? this.files.publicUrl(key) : null;

  /** One conversation as `userId` sees it (they must be an active member). Used by the REST routes and by the real-time layer. */
  async getFor(
    userId: string,
    conversationId: string,
    db: ChatDb = this.prisma,
  ): Promise<ConversationDto> {
    const { items } = await readConversations(db, userId, {
      conversationId,
      avatarUrl: this.avatarUrl,
    });
    if (items.length === 0) throw new ApiException('NOT_FOUND');
    return items[0];
  }

  async list(
    userId: string,
    window: { page: number; pageSize: number; offset: number },
  ): Promise<ConversationsPageDto> {
    const { items, total } = await readConversations(this.prisma, userId, {
      visibleOnly: true,
      limit: window.pageSize,
      offset: window.offset,
      avatarUrl: this.avatarUrl,
    });
    return { items, page: window.page, pageSize: window.pageSize, total };
  }

  /**
   * Get-or-create the direct conversation with `otherId`. A block in either direction is 403 `CANNOT_MESSAGE_USER`, the same answer
   * whoever blocked whom. A suspended or unknown user is 404. The pair is stored ordered (`user_a_id < user_b_id`) with a unique
   * constraint, so two first DMs at the same moment make one conversation: the loser's unique violation is handled OUTSIDE the failed
   * transaction by reloading (Decision 80). The conversation is hidden from `GET /me/conversations` until its first message.
   */
  async openDirect(userId: string, otherId: string): Promise<ConversationDto> {
    if (userId === otherId)
      throw new ApiException('VALIDATION_FAILED', {
        message: 'You cannot start a conversation with yourself',
      });
    if (!(await activeUserIds(this.prisma, [otherId])).has(otherId))
      throw new ApiException('NOT_FOUND');
    if (await this.blocks.isBlockedEitherWay(userId, otherId))
      throw new ApiException('CANNOT_MESSAGE_USER');
    const [a, b] = userId < otherId ? [userId, otherId] : [otherId, userId];
    let id = await this.directId(a, b);
    if (!id) {
      try {
        id = await this.transactions.run(async (tx) => {
          const rows = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO conversations (type, created_by) VALUES ('DIRECT', ${userId}::uuid) RETURNING id`;
          const created = rows[0].id;
          await tx.$executeRaw`
            INSERT INTO direct_conversations (conversation_id, user_a_id, user_b_id)
            VALUES (${created}::uuid, ${a}::uuid, ${b}::uuid)`;
          await tx.$executeRaw`
            INSERT INTO conversation_members (conversation_id, user_id)
            VALUES (${created}::uuid, ${a}::uuid), (${created}::uuid, ${b}::uuid)`;
          return created;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        id = await this.directId(a, b);
        if (!id) throw error;
      }
    }
    return this.getFor(userId, id);
  }

  /**
   * Creates a group: the creator is its admin. Everyone else must exist, be active and not have blocked the creator (Decision 84); if
   * anyone cannot be added the answer is the neutral 409 `MEMBERS_UNAVAILABLE` and nothing is created. At most 50 members with the creator.
   */
  async createGroup(
    userId: string,
    title: string,
    memberIds: readonly string[],
  ): Promise<ConversationDto> {
    const others = [...new Set(memberIds.map((id) => id.toLowerCase()))].filter(
      (id) => id !== userId,
    );
    if (others.length + 1 > COUNT_LIMITS.GROUP_MEMBERS_MAX)
      throw new ApiException('VALIDATION_FAILED', {
        errors: [
          {
            field: 'memberIds',
            messages: [
              `A group has at most ${COUNT_LIMITS.GROUP_MEMBERS_MAX} members including you`,
            ],
          },
        ],
      });
    const id = await this.transactions.run(async (tx) => {
      const active = await activeUserIds(tx, others);
      if (active.size !== others.length)
        throw new ApiException('MEMBERS_UNAVAILABLE', {
          message: MEMBERS_UNAVAILABLE_MESSAGE,
        });
      await this.blocks.assertCanAdd(userId, others, tx);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO conversations (type, title, created_by) VALUES ('GROUP', ${title}, ${userId}::uuid) RETURNING id`;
      const created = rows[0].id;
      await tx.$executeRaw`
        INSERT INTO conversation_members (conversation_id, user_id, role)
        VALUES (${created}::uuid, ${userId}::uuid, 'ADMIN')`;
      if (others.length > 0) {
        await tx.$executeRaw`
          INSERT INTO conversation_members (conversation_id, user_id)
          SELECT ${created}::uuid, u FROM unnest(${others}::uuid[]) AS u`;
      }
      for (const member of [userId, ...others])
        emitAfterCommit(tx, 'conversation.added', {
          conversationId: created,
          userId: member,
        });
      return created;
    });
    return this.getFor(userId, id);
  }

  /** Rename a group (group admins only; a direct conversation or a course channel has no title of its own). */
  async rename(
    userId: string,
    conversationId: string,
    title: string,
  ): Promise<ConversationDto> {
    await this.transactions.run(async (tx) => {
      const conversation = await lockConversation(tx, conversationId);
      const me = await requireMember(tx, conversationId, userId);
      if (conversation.type !== 'GROUP')
        throw new ApiException('INVALID_STATE_TRANSITION', {
          message: 'Only a group can be renamed',
        });
      if (me.role !== 'ADMIN') throw new ApiException('FORBIDDEN');
      await tx.$executeRaw`
        UPDATE conversations SET title = ${title}, updated_at = now() WHERE id = ${conversationId}::uuid`;
      emitAfterCommit(tx, 'conversation.updated', { conversationId });
    });
    return this.getFor(userId, conversationId);
  }

  /** Mute or unmute for myself, in any conversation I am an active member of. */
  async setMuted(
    userId: string,
    conversationId: string,
    isMuted: boolean,
  ): Promise<ConversationDto> {
    const updated = await this.prisma.$executeRaw`
      UPDATE conversation_members SET is_muted = ${isMuted}
       WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND left_at IS NULL`;
    if (updated === 0) throw new ApiException('NOT_FOUND');
    return this.getFor(userId, conversationId);
  }

  /** The channel of a course, for a member of it. A course without a channel (never published) or a non-member: 404. */
  async channelOfCourse(
    userId: string,
    courseId: string,
  ): Promise<ConversationDto> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM conversations WHERE course_id = ${courseId}::uuid`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    return this.getFor(userId, rows[0].id);
  }

  private async directId(a: string, b: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ conversation_id: string }[]>`
      SELECT conversation_id FROM direct_conversations WHERE user_a_id = ${a}::uuid AND user_b_id = ${b}::uuid`;
    return rows[0]?.conversation_id ?? null;
  }
}
