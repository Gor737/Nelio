import { Injectable } from '@nestjs/common';
import { ApiException } from '../../../common/filters/index.js';
import { TransactionService } from '../../../infrastructure/database/index.js';
import { MessagesService } from '../../chat/index.js';
import {
  type AdminReportDetailDto,
  type AdminReportsPageDto,
  type ReportContextDto,
  type ReportQueueQueryDto,
  ReportQueueService,
} from '../../moderation/index.js';

/**
 * Admin: report handling (Decisions 77, 132; Bug 2 of the lock catalog). Resolving a report that deletes a message touches two modules, so
 * Admin orders the locks: Chat deletes the message (Conversation, then Message), and only THEN Moderation locks the Reports of that message
 * in ascending id order. Because every resolution of the same message queues up on the Message first, two resolutions never wait on each
 * other's Reports; the second one finds its report already closed and gets 409 `REPORT_ALREADY_RESOLVED`.
 */
@Injectable()
export class AdminReportsService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly reports: ReportQueueService,
    private readonly messages: MessagesService,
  ) {}

  list(query: ReportQueueQueryDto): Promise<AdminReportsPageDto> {
    return this.reports.list(query);
  }

  get(reportId: string): Promise<AdminReportDetailDto> {
    return this.reports.get(reportId);
  }

  context(actorId: string, reportId: string): Promise<ReportContextDto> {
    return this.reports.context(actorId, reportId);
  }

  async dismiss(
    actorId: string,
    reportId: string,
    note?: string,
  ): Promise<AdminReportDetailDto> {
    await this.transactions.run(async (tx) => {
      const report = await this.reports.peek(tx, reportId);
      if (report.status !== 'OPEN')
        throw new ApiException('REPORT_ALREADY_RESOLVED');
      await this.reports.closeInTx(tx, {
        reportId,
        actorId,
        outcome: 'DISMISSED',
        note,
        withSiblings: false,
      });
    });
    return this.reports.get(reportId);
  }

  /** Marks the report ACTIONED; with `deleteMessage` the reported message is deleted and every OPEN report about it is closed together. */
  async action(
    actorId: string,
    reportId: string,
    input: { note?: string; deleteMessage?: boolean },
  ): Promise<AdminReportDetailDto> {
    const deleteMessage = input.deleteMessage === true;
    await this.transactions.run(async (tx) => {
      const report = await this.reports.peek(tx, reportId);
      if (report.status !== 'OPEN')
        throw new ApiException('REPORT_ALREADY_RESOLVED');
      if (deleteMessage) {
        if (report.messageId === null)
          throw new ApiException('VALIDATION_FAILED', {
            message: 'A report about a user has no message to delete',
          });
        await this.messages.deleteAsModeratorInTx(tx, {
          messageId: report.messageId,
          actorId,
          reportId,
        });
      }
      await this.reports.closeInTx(tx, {
        reportId,
        actorId,
        outcome: 'ACTIONED',
        note: input.note,
        withSiblings: deleteMessage,
        messageDeleted: deleteMessage,
      });
    });
    return this.reports.get(reportId);
  }
}
