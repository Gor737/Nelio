import { Injectable, Logger } from '@nestjs/common';
import { COUNT_LIMITS } from '../../../common/constants/limits.js';
import type { NotificationType } from '../../../common/constants/notification-types.js';
import { PrismaService } from '../../../infrastructure/database/index.js';
import { RealtimeService } from '../../../infrastructure/realtime/index.js';
import { toNotificationDto } from '../mappers/notification.mapper.js';

export interface NewNotification {
  readonly type: NotificationType;
  readonly recipientIds: readonly string[];
  readonly courseId?: string | null;
  readonly actorId?: string | null;
  /** The display snapshot (plain JSON). */
  readonly data?: Record<string, string | number | boolean | null>;
}

/** The Socket.IO event a new notification is pushed as (docs/architecture.md section 14). */
export const NOTIFICATION_PUSH_EVENT = 'notification:new';

/**
 * Writes notification rows for a set of recipients and pushes them live. Called after the business transaction committed (from the event
 * listener), never inside one. A recipient list is written in chunks of `NOTIFICATION_FANOUT_CHUNK` rows, each chunk one statement; a chunk
 * that fails is logged and the next chunk still runs (a lost notification is not repaired: every event has a visible state elsewhere).
 * The push is best effort: it can never fail the write or the caller.
 */
@Injectable()
export class NotificationWriter {
  private readonly logger = new Logger(NotificationWriter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Returns the number of rows written. Recipients that do not exist (or were repeated) are skipped. */
  async write(notification: NewNotification): Promise<number> {
    const recipients = [...new Set(notification.recipientIds)];
    if (recipients.length === 0) return 0;
    const actorName = await this.actorName(notification.actorId ?? null);
    let written = 0;
    for (
      let start = 0;
      start < recipients.length;
      start += COUNT_LIMITS.NOTIFICATION_FANOUT_CHUNK
    ) {
      const chunk = recipients.slice(
        start,
        start + COUNT_LIMITS.NOTIFICATION_FANOUT_CHUNK,
      );
      try {
        written += await this.insertChunk(notification, chunk, actorName);
      } catch (error) {
        this.logger.error({
          event: 'notification_chunk_failed',
          type: notification.type,
          recipients: chunk.length,
          error: error instanceof Error ? error.name : 'error',
        });
      }
    }
    return written;
  }

  private async insertChunk(
    notification: NewNotification,
    userIds: string[],
    actorName: string | null,
  ): Promise<number> {
    const courseId = notification.courseId ?? null;
    const actorId = notification.actorId ?? null;
    const data = JSON.stringify(notification.data ?? {});
    const rows = await this.prisma.$queryRaw<
      { id: string; user_id: string; created_at: Date }[]
    >`
      INSERT INTO notifications (user_id, type, course_id, actor_id, data)
      SELECT u.id, ${notification.type}::notification_type, ${courseId}::uuid, ${actorId}::uuid, ${data}::jsonb
        FROM users u WHERE u.id = ANY(${userIds}::uuid[])
      RETURNING id, user_id, created_at`;
    for (const row of rows) {
      this.push(row.user_id, {
        id: row.id,
        type: notification.type,
        course_id: courseId,
        actor_id: actorId,
        actor_name: actorName,
        data: notification.data ?? {},
        read_at: null,
        created_at: row.created_at,
      });
    }
    return rows.length;
  }

  private push(
    userId: string,
    row: Parameters<typeof toNotificationDto>[0],
  ): void {
    try {
      this.realtime.emitToUser(
        userId,
        NOTIFICATION_PUSH_EVENT,
        toNotificationDto(row),
      );
    } catch (error) {
      this.logger.warn({
        event: 'notification_push_failed',
        error: error instanceof Error ? error.name : 'error',
      });
    }
  }

  private async actorName(actorId: string | null): Promise<string | null> {
    if (actorId === null) return null;
    const rows = await this.prisma.$queryRaw<{ full_name: string }[]>`
      SELECT full_name FROM users WHERE id = ${actorId}::uuid`;
    return rows[0]?.full_name ?? null;
  }
}
