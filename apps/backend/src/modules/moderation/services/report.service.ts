import { Injectable } from '@nestjs/common';
import { ApiException } from '../../../common/filters/index.js';
import {
  PrismaService,
  isUniqueViolation,
} from '../../../infrastructure/database/index.js';
import type { ReportReason, ReportReceiptDto } from '../dto/moderation.dto.js';

interface ReceiptRow {
  id: string;
  created_at: Date;
}

/**
 * Filing reports (Decisions 77, 78). A MESSAGE report stores the body as it was at report time, written by the same statement that
 * checks the reporter may see the message, so later edits or deletes cannot change the evidence. The reporter is never told anything
 * about the target beyond the receipt. Handling reports (list, context, dismiss, action) is Admin work (M12).
 */
@Injectable()
export class ReportService {
  constructor(private readonly prisma: PrismaService) {}

  async reportUser(
    reporterId: string,
    targetId: string,
    input: { reason: ReportReason; description?: string },
  ): Promise<ReportReceiptDto> {
    if (reporterId === targetId)
      throw new ApiException('VALIDATION_FAILED', {
        message: 'You cannot report yourself',
      });
    const found = await this.prisma.$queryRaw<
      { id: string }[]
    >`SELECT id FROM users WHERE id = ${targetId}::uuid`;
    if (found.length === 0) throw new ApiException('NOT_FOUND');
    try {
      const rows = await this.prisma.$queryRaw<ReceiptRow[]>`
        INSERT INTO reports (reporter_id, target_type, target_user_id, reason, description)
        VALUES (${reporterId}::uuid, 'USER', ${targetId}::uuid, ${input.reason}::report_reason, ${input.description ?? null})
        RETURNING id, created_at`;
      return this.receipt(rows[0]);
    } catch (error) {
      throw this.mapDuplicate(error);
    }
  }

  async reportMessage(
    reporterId: string,
    conversationId: string,
    messageId: string,
    input: { reason: ReportReason; description?: string },
  ): Promise<ReportReceiptDto> {
    // The reporter must be an active member of that conversation, and the message must be in it and not deleted: otherwise 404,
    // the same answer as for a message that does not exist (nothing leaks about conversations you are not in).
    const visible = await this.prisma.$queryRaw<{ sender_id: string }[]>`
      SELECT m.sender_id FROM messages m
        JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ${reporterId}::uuid AND cm.left_at IS NULL
       WHERE m.id = ${messageId}::uuid AND m.conversation_id = ${conversationId}::uuid AND m.deleted_at IS NULL`;
    if (visible.length === 0) throw new ApiException('NOT_FOUND');
    if (visible[0].sender_id === reporterId)
      throw new ApiException('VALIDATION_FAILED', {
        message: 'You cannot report your own message',
      });
    try {
      const rows = await this.prisma.$queryRaw<ReceiptRow[]>`
        INSERT INTO reports (reporter_id, target_type, message_id, reason, description, message_snapshot)
        SELECT ${reporterId}::uuid, 'MESSAGE', m.id, ${input.reason}::report_reason, ${input.description ?? null}, m.body
          FROM messages m
          JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ${reporterId}::uuid AND cm.left_at IS NULL
         WHERE m.id = ${messageId}::uuid AND m.conversation_id = ${conversationId}::uuid AND m.deleted_at IS NULL
        RETURNING id, created_at`;
      if (rows.length === 0) throw new ApiException('NOT_FOUND'); // deleted or left between the two statements
      return this.receipt(rows[0]);
    } catch (error) {
      throw this.mapDuplicate(error);
    }
  }

  private receipt(row: ReceiptRow): ReportReceiptDto {
    return { id: row.id, status: 'OPEN', createdAt: row.created_at };
  }

  /** The partial unique indexes allow one OPEN report per reporter and target; a new one is possible once the old one is handled. */
  private mapDuplicate(error: unknown): unknown {
    if (error instanceof ApiException) return error;
    if (isUniqueViolation(error))
      return new ApiException('RESOURCE_CONFLICT', {
        message: 'You have already reported this and it is still open',
      });
    return error;
  }
}
