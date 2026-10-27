import { Injectable } from '@nestjs/common';
import { COUNT_LIMITS } from '../../../common/constants/limits.js';
import { pageWindow } from '../../../common/dto/page-query.dto.js';
import { ApiException } from '../../../common/filters/index.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { AuditWriter } from '../../../infrastructure/audit/index.js';
import {
  PrismaService,
  TransactionService,
  type Tx,
} from '../../../infrastructure/database/index.js';
import type { ReportReason } from '../dto/moderation.dto.js';
import {
  AdminReportDetailDto,
  AdminReportItemDto,
  AdminReportsPageDto,
  ContextMessageDto,
  type ReportQueueQueryDto,
  ReportContextDto,
  type ReportStatusName,
  type ReportTargetTypeName,
} from '../dto/report-queue.dto.js';

interface ItemRow {
  id: string;
  target_type: ReportTargetTypeName;
  reason: ReportReason;
  status: ReportStatusName;
  created_at: Date;
  reporter_id: string;
  reporter_name: string;
  message_id: string | null;
  conversation_id: string | null;
  author_id: string | null;
  author_name: string | null;
  message_deleted: boolean | null;
  target_user_id: string | null;
  target_user_name: string | null;
}

interface DetailRow extends ItemRow {
  description: string | null;
  message_snapshot: string | null;
  reviewed_by: string | null;
  reviewer_name: string | null;
  reviewed_at: Date | null;
  resolution_note: string | null;
  open_siblings: number;
}

const ITEM_COLUMNS = Prisma.sql`
  r.id, r.target_type, r.reason, r.status, r.created_at,
  rep.id AS reporter_id, rep.full_name AS reporter_name,
  m.id AS message_id, m.conversation_id, au.id AS author_id, au.full_name AS author_name, (m.deleted_at IS NOT NULL) AS message_deleted,
  tu.id AS target_user_id, tu.full_name AS target_user_name`;

const ITEM_FROM = Prisma.sql`
  FROM reports r
  JOIN users rep ON rep.id = r.reporter_id
  LEFT JOIN messages m ON m.id = r.message_id
  LEFT JOIN users au ON au.id = m.sender_id
  LEFT JOIN users tu ON tu.id = r.target_user_id`;

/**
 * Handling reports, the Moderation half (Decisions 77, 78, 132). The queue and the detail never include the conversation; `context` shows
 * the reported message with about ten messages each side, and each viewing is audited in the same transaction as the read. Closing a report
 * is a primitive the Admin composes: Admin first deletes the message through Chat (Conversation, then Message), THEN calls `closeInTx`,
 * which locks the Reports of that message in ascending id order (the global lock order: Message before Report, docs/architecture.md section 15).
 */
@Injectable()
export class ReportQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly audit: AuditWriter,
  ) {}

  async list(query: ReportQueueQueryDto): Promise<AdminReportsPageDto> {
    const { page, pageSize, offset } = pageWindow(query);
    const status = query.status ?? 'OPEN';
    const order =
      status === 'OPEN'
        ? Prisma.sql`r.created_at ASC, r.id`
        : Prisma.sql`r.reviewed_at DESC, r.id`;
    const rows = await this.prisma.$queryRaw<(ItemRow & { total: number })[]>`
      SELECT ${ITEM_COLUMNS}, count(*) OVER ()::int AS total ${ITEM_FROM}
       WHERE r.status = ${status}::report_status
         AND (${query.targetType ?? null}::text IS NULL OR r.target_type::text = ${query.targetType ?? null}::text)
         AND (${query.reason ?? null}::text IS NULL OR r.reason::text = ${query.reason ?? null}::text)
       ORDER BY ${order}
       LIMIT ${pageSize} OFFSET ${offset}`;
    return {
      items: rows.map((row) => this.toItem(row)),
      page,
      pageSize,
      total: rows[0]?.total ?? 0,
    };
  }

  async get(reportId: string): Promise<AdminReportDetailDto> {
    const rows = await this.prisma.$queryRaw<DetailRow[]>`
      SELECT ${ITEM_COLUMNS}, r.description, r.message_snapshot, r.reviewed_by, rev.full_name AS reviewer_name, r.reviewed_at, r.resolution_note,
             (SELECT count(*)::int FROM reports s
               WHERE s.status = 'OPEN' AND s.id <> r.id
                 AND ((r.message_id IS NOT NULL AND s.message_id = r.message_id) OR (r.target_user_id IS NOT NULL AND s.target_user_id = r.target_user_id))) AS open_siblings
        ${ITEM_FROM}
        LEFT JOIN users rev ON rev.id = r.reviewed_by
       WHERE r.id = ${reportId}::uuid`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    const row = rows[0];
    return Object.assign(this.toItem(row), {
      description: row.description,
      snapshot: row.message_snapshot,
      openSiblings: row.open_siblings,
      reviewedBy: row.reviewed_by
        ? { id: row.reviewed_by, fullName: row.reviewer_name as string }
        : null,
      reviewedAt: row.reviewed_at,
      resolutionNote: row.resolution_note,
    });
  }

  /**
   * The reported message and about ten messages before and after it (Decision 77), never the whole conversation. The audit row
   * `REPORT_CONTEXT_VIEWED` is written in the same transaction as the read, EVERY time; no other report endpoint writes one. The text of a
   * deleted message is never returned. A user report has no message, hence no context (400).
   */
  async context(actorId: string, reportId: string): Promise<ReportContextDto> {
    return this.transactions.run(async (tx) => {
      const found = await tx.$queryRaw<
        {
          message_id: string | null;
          message_snapshot: string | null;
          conversation_id: string | null;
          seq: number | null;
        }[]
      >`
        SELECT r.message_id, r.message_snapshot, m.conversation_id, m.seq
          FROM reports r LEFT JOIN messages m ON m.id = r.message_id WHERE r.id = ${reportId}::uuid`;
      if (found.length === 0) throw new ApiException('NOT_FOUND');
      const report = found[0];
      if (
        report.message_id === null ||
        report.conversation_id === null ||
        report.seq === null
      )
        throw new ApiException('VALIDATION_FAILED', {
          message: 'Only a report about a message has a context',
        });
      const side = COUNT_LIMITS.REPORT_CONTEXT_MESSAGES_EACH_SIDE;
      const rows = await tx.$queryRaw<
        {
          id: string;
          seq: number;
          sender_id: string;
          sender_name: string;
          body: string;
          deleted_at: Date | null;
          created_at: Date;
        }[]
      >`
        SELECT m.id, m.seq, m.sender_id, u.full_name AS sender_name, m.body, m.deleted_at, m.created_at
          FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = ${report.conversation_id}::uuid
           AND m.seq BETWEEN ${report.seq - side} AND ${report.seq + side}
         ORDER BY m.seq ASC`;
      await this.audit.record(tx, {
        actorId,
        action: 'REPORT_CONTEXT_VIEWED',
        targetType: 'REPORT',
        targetId: reportId,
        metadata: {
          messageId: report.message_id,
          conversationId: report.conversation_id,
          shown: rows.length,
        },
      });
      const messages: ContextMessageDto[] = rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        sender: { id: row.sender_id, fullName: row.sender_name },
        body: row.deleted_at === null ? row.body : null,
        deleted: row.deleted_at !== null,
        createdAt: row.created_at,
        reported: row.id === report.message_id,
      }));
      return {
        reportId,
        conversationId: report.conversation_id,
        snapshot: report.message_snapshot ?? '',
        messages,
      };
    });
  }

  /** What the Admin needs to order its locks: the target of the report and its status, read WITHOUT a lock (re-checked under the lock). */
  async peek(
    tx: Tx,
    reportId: string,
  ): Promise<{
    messageId: string | null;
    status: ReportStatusName;
  }> {
    const rows = await tx.$queryRaw<
      { message_id: string | null; status: ReportStatusName }[]
    >`SELECT message_id, status FROM reports WHERE id = ${reportId}::uuid`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    return { messageId: rows[0].message_id, status: rows[0].status };
  }

  /**
   * Closes a report as DISMISSED or ACTIONED. With `withSiblings` (a message report whose message the Admin just deleted) it closes every
   * OPEN report about that message together. The report rows involved are locked in ascending id order (a single statement), so two
   * resolutions of reports of the same message cannot deadlock: the first closes all, the second finds its own report already closed and gets
   * 409 `REPORT_ALREADY_RESOLVED`. The audit row names the siblings that were closed with it.
   */
  async closeInTx(
    tx: Tx,
    input: {
      reportId: string;
      actorId: string;
      outcome: 'DISMISSED' | 'ACTIONED';
      note?: string | null;
      withSiblings: boolean;
      messageDeleted?: boolean;
    },
  ): Promise<{ siblingIds: string[] }> {
    const target = await tx.$queryRaw<{ message_id: string | null }[]>`
      SELECT message_id FROM reports WHERE id = ${input.reportId}::uuid`;
    if (target.length === 0) throw new ApiException('NOT_FOUND');
    const messageId = input.withSiblings ? target[0].message_id : null;
    const locked = await tx.$queryRaw<
      { id: string; status: ReportStatusName }[]
    >`
      SELECT id, status FROM reports
       WHERE id = ${input.reportId}::uuid OR (${messageId}::uuid IS NOT NULL AND message_id = ${messageId}::uuid)
       ORDER BY id FOR NO KEY UPDATE`;
    const own = locked.find((row) => row.id === input.reportId);
    if (!own) throw new ApiException('NOT_FOUND');
    if (own.status !== 'OPEN')
      throw new ApiException('REPORT_ALREADY_RESOLVED');
    const siblingIds = locked
      .filter((row) => row.id !== input.reportId && row.status === 'OPEN')
      .map((row) => row.id);
    const closing = [input.reportId, ...siblingIds];
    await tx.$executeRaw`
      UPDATE reports
         SET status = ${input.outcome}::report_status, reviewed_by = ${input.actorId}::uuid, reviewed_at = now(),
             resolution_note = ${input.note ?? null}, updated_at = now()
       WHERE id = ANY(${closing}::uuid[]) AND status = 'OPEN'`;
    await this.audit.record(tx, {
      actorId: input.actorId,
      action:
        input.outcome === 'DISMISSED' ? 'REPORT_DISMISSED' : 'REPORT_ACTIONED',
      targetType: 'REPORT',
      targetId: input.reportId,
      metadata: {
        note: input.note ?? null,
        messageDeleted: input.messageDeleted ?? false,
        closedSiblings: siblingIds,
      },
    });
    return { siblingIds };
  }

  private toItem(row: ItemRow): AdminReportItemDto {
    return {
      id: row.id,
      targetType: row.target_type,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
      reporter: { id: row.reporter_id, fullName: row.reporter_name },
      message: row.message_id
        ? {
            id: row.message_id,
            conversationId: row.conversation_id as string,
            author: {
              id: row.author_id as string,
              fullName: row.author_name as string,
            },
            deleted: row.message_deleted === true,
          }
        : null,
      targetUser: row.target_user_id
        ? { id: row.target_user_id, fullName: row.target_user_name as string }
        : null,
    };
  }
}
