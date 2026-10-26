import { Injectable } from '@nestjs/common';
import { assertCourseMutable } from '../../../common/access/index.js';
import { COUNT_LIMITS } from '../../../common/constants/limits.js';
import { ApiException } from '../../../common/filters/index.js';
import { AuditWriter } from '../../../infrastructure/audit/index.js';
import {
  PrismaService,
  TransactionService,
  type Tx,
  isUniqueViolation,
} from '../../../infrastructure/database/index.js';
import { emitAfterCommit } from '../../../infrastructure/events/index.js';
import { BlockService } from '../../moderation/index.js';
import type { HistoryDto, MessageDto } from '../dto/chat.dto.js';
import {
  type ChatDb,
  type MessageRow,
  readMessage,
  toMessageDto,
} from './conversation-reader.js';
import { lockConversation, requireMember } from './conversations.service.js';

export interface SendResult {
  readonly message: MessageDto;
  /** False when this was a repeat of an earlier send with the same client id (nothing was written, no event was emitted). */
  readonly created: boolean;
}

/**
 * Messages (Decisions 32, 41, 42, 81, 82, 85, 86, 131, 154). REST and the socket both call `send`, so they give the same errors and the
 * same idempotency. Everything that changes a conversation starts by locking its row (`FOR NO KEY UPDATE`): that single lock is what makes
 * `seq` contiguous, serializes edits against deletes and leaves, and makes a repeated client id impossible to write twice.
 *
 * A deleted message keeps its row, its `seq` and its text in the database (moderation evidence) but the API returns no text for it.
 * Messages are plain text. Moderator deletions (course Owner or Assistant) are audited.
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly blocks: BlockService,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * Sends a message. In order, all in one transaction under the Conversation lock:
   *   1. the sender is an ACTIVE member (a former member and a non-member are 404);
   *   2. a repeat of the same client id: same conversation and same text returns the original (no new row, no gap in `seq`, no event);
   *      another conversation or another text is 409 `CLIENT_ID_REUSED`;
   *   3. a direct conversation with a block in either direction is 403 `CANNOT_MESSAGE_USER`; a course channel of an archived or locked
   *      course is 409 `COURSE_ARCHIVED` / `COURSE_ADMIN_LOCKED`;
   *   4. `seq` is taken from `last_seq + 1` and the row is inserted; the event is queued for after the commit.
   */
  async send(
    userId: string,
    conversationId: string,
    input: { body: string; clientId: string },
  ): Promise<SendResult> {
    const clientId = input.clientId.toLowerCase();
    try {
      return await this.transactions.run(async (tx) => {
        const conversation = await lockConversation(tx, conversationId);
        const member = await tx.$queryRaw<{ one: number }[]>`
          SELECT 1 AS one FROM conversation_members
           WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND left_at IS NULL FOR SHARE`;
        if (member.length === 0) throw new ApiException('NOT_FOUND');
        const repeat = await this.findRepeat(tx, userId, clientId);
        if (repeat)
          return this.answerRepeat(repeat, conversationId, input.body);
        if (conversation.type === 'DIRECT') {
          const other = await tx.$queryRaw<{ other: string }[]>`
            SELECT user_id AS other FROM conversation_members
             WHERE conversation_id = ${conversationId}::uuid AND user_id <> ${userId}::uuid`;
          if (
            other[0] &&
            (await this.blocks.isBlockedEitherWay(userId, other[0].other, tx))
          )
            throw new ApiException('CANNOT_MESSAGE_USER');
        } else if (
          conversation.type === 'COURSE_CHANNEL' &&
          conversation.courseId
        ) {
          await assertCourseMutable(tx, conversation.courseId);
        }
        const seq = await tx.$queryRaw<{ last_seq: number }[]>`
          UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now(), updated_at = now()
           WHERE id = ${conversationId}::uuid RETURNING last_seq`;
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO messages (conversation_id, seq, sender_id, body, client_id)
          VALUES (${conversationId}::uuid, ${seq[0].last_seq}, ${userId}::uuid, ${input.body}, ${clientId}::uuid)
          RETURNING id`;
        const message = (await readMessage(tx, inserted[0].id)) as MessageDto;
        emitAfterCommit(tx, 'message.created', {
          conversationId,
          messageId: message.id,
          senderId: userId,
          seq: message.seq,
        });
        return { message, created: true };
      });
    } catch (error) {
      // The same client id used in two DIFFERENT conversations at the same moment: the unique key (sender, client id) decides.
      if (!isUniqueViolation(error)) throw error;
      const repeat = await this.findRepeat(this.prisma, userId, clientId);
      if (!repeat) throw error;
      return this.answerRepeat(repeat, conversationId, input.body);
    }
  }

  /**
   * History by `seq`. No cursor: the newest page. `before=N`: the page just older than N. `after=N`: everything after N, oldest first, which
   * is exactly what a client that detected a gap needs. Always returned oldest first. Only an ACTIVE member can read (404 otherwise).
   */
  async history(
    userId: string,
    conversationId: string,
    query: { before?: number; after?: number; limit?: number },
  ): Promise<HistoryDto> {
    if (query.before !== undefined && query.after !== undefined)
      throw new ApiException('VALIDATION_FAILED', {
        message: 'Use either before or after, not both',
      });
    await requireMember(this.prisma, conversationId, userId);
    const limit = query.limit ?? COUNT_LIMITS.CURSOR_PAGE_SIZE_DEFAULT;
    const ascending = query.after !== undefined;
    const rows = await this.prisma.$queryRaw<MessageRow[]>`
      SELECT m.id, m.conversation_id, m.seq, m.sender_id, u.full_name AS sender_name, m.body, m.client_id, m.edited_at, m.deleted_at, m.created_at
        FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ${conversationId}::uuid
         AND (${query.before ?? null}::int IS NULL OR m.seq < ${query.before ?? null}::int)
         AND (${query.after ?? null}::int IS NULL OR m.seq > ${query.after ?? null}::int)
       ORDER BY CASE WHEN ${ascending} THEN m.seq END ASC, m.seq DESC
       LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    if (!ascending) page.reverse();
    return { items: page.map(toMessageDto), hasMore: rows.length > limit };
  }

  /**
   * Edits my own message. Another user's message is 403; a deleted message is 409 (`INVALID_STATE_TRANSITION`); a course channel of an
   * archived or locked course is 409. Only `edited_at` records the edit (Decision 42).
   */
  async edit(
    userId: string,
    conversationId: string,
    messageId: string,
    body: string,
  ): Promise<MessageDto> {
    return this.transactions.run(async (tx) => {
      const conversation = await lockConversation(tx, conversationId);
      await requireMember(tx, conversationId, userId);
      const message = await this.lockMessage(tx, conversationId, messageId);
      if (message.sender_id !== userId) throw new ApiException('FORBIDDEN');
      if (message.deleted_at !== null)
        throw new ApiException('INVALID_STATE_TRANSITION', {
          message: 'A deleted message cannot be edited',
        });
      if (conversation.type === 'COURSE_CHANNEL' && conversation.courseId)
        await assertCourseMutable(tx, conversation.courseId);
      if (message.body !== body) {
        await tx.$executeRaw`UPDATE messages SET body = ${body}, edited_at = now() WHERE id = ${messageId}::uuid`;
        emitAfterCommit(tx, 'message.edited', { conversationId, messageId });
      }
      return (await readMessage(tx, messageId)) as MessageDto;
    });
  }

  /**
   * Soft-deletes a message: its author, or in a course channel the course Owner or an Assistant. Allowed in a read-only (archived or locked)
   * channel, so abuse can always be removed. Deleting twice is a no-op. A moderator's deletion of someone else's message is audited.
   */
  async delete(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    await this.transactions.run(async (tx) => {
      const conversation = await lockConversation(tx, conversationId);
      await requireMember(tx, conversationId, userId);
      const message = await this.lockMessage(tx, conversationId, messageId);
      const own = message.sender_id === userId;
      let moderator = false;
      if (!own) {
        if (conversation.type === 'COURSE_CHANNEL' && conversation.courseId) {
          const teacher = await tx.$queryRaw<{ one: number }[]>`
            SELECT 1 AS one FROM course_teachers
             WHERE course_id = ${conversation.courseId}::uuid AND user_id = ${userId}::uuid`;
          moderator = teacher.length > 0;
        }
        if (!moderator) throw new ApiException('FORBIDDEN');
      }
      if (message.deleted_at !== null) return;
      await tx.$executeRaw`
        UPDATE messages SET deleted_at = now(), deleted_by = ${userId}::uuid WHERE id = ${messageId}::uuid`;
      if (moderator) {
        await this.audit.record(tx, {
          actorId: userId,
          action: 'MESSAGE_DELETED_BY_MODERATOR',
          targetType: 'MESSAGE',
          targetId: messageId,
          metadata: {
            conversationId,
            courseId: conversation.courseId,
            authorId: message.sender_id,
          },
        });
      }
      emitAfterCommit(tx, 'message.deleted', { conversationId, messageId });
    });
  }

  /**
   * Moves my read position forward: `GREATEST(old, seq)`, so it never goes backwards. A position above the conversation's `last_seq` is
   * 400. Other devices of mine are told (`conversation:read`).
   */
  async markRead(
    userId: string,
    conversationId: string,
    seq: number,
  ): Promise<{ lastReadSeq: number }> {
    return this.transactions.run(async (tx) => {
      const rows = await tx.$queryRaw<{ last_read_seq: number }[]>`
        UPDATE conversation_members m SET last_read_seq = GREATEST(m.last_read_seq, ${seq}::int)
          FROM conversations c
         WHERE c.id = m.conversation_id AND m.conversation_id = ${conversationId}::uuid AND m.user_id = ${userId}::uuid
           AND m.left_at IS NULL AND ${seq}::int <= c.last_seq
        RETURNING m.last_read_seq`;
      if (rows.length === 0) {
        await requireMember(tx, conversationId, userId);
        throw new ApiException('VALIDATION_FAILED', {
          errors: [
            {
              field: 'seq',
              messages: [
                'seq cannot be above the last message of the conversation',
              ],
            },
          ],
        });
      }
      emitAfterCommit(tx, 'conversation.read', {
        conversationId,
        userId,
        lastReadSeq: rows[0].last_read_seq,
      });
      return { lastReadSeq: rows[0].last_read_seq };
    });
  }

  private async findRepeat(
    db: ChatDb,
    userId: string,
    clientId: string,
  ): Promise<MessageRow | undefined> {
    const rows = await db.$queryRaw<MessageRow[]>`
      SELECT m.id, m.conversation_id, m.seq, m.sender_id, u.full_name AS sender_name, m.body, m.client_id, m.edited_at, m.deleted_at, m.created_at
        FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.sender_id = ${userId}::uuid AND m.client_id = ${clientId}::uuid`;
    return rows[0];
  }

  private answerRepeat(
    repeat: MessageRow,
    conversationId: string,
    body: string,
  ): SendResult {
    if (repeat.conversation_id !== conversationId || repeat.body !== body)
      throw new ApiException('CLIENT_ID_REUSED');
    return { message: toMessageDto(repeat), created: false };
  }

  private async lockMessage(
    tx: Tx,
    conversationId: string,
    messageId: string,
  ): Promise<{ sender_id: string; body: string; deleted_at: Date | null }> {
    const rows = await tx.$queryRaw<
      { sender_id: string; body: string; deleted_at: Date | null }[]
    >`
      SELECT sender_id, body, deleted_at FROM messages
       WHERE id = ${messageId}::uuid AND conversation_id = ${conversationId}::uuid FOR NO KEY UPDATE`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    return rows[0];
  }
}
