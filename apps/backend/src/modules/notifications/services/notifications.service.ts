import { Injectable } from '@nestjs/common';
import { COUNT_LIMITS } from '../../../common/constants/limits.js';
import { ApiException } from '../../../common/filters/index.js';
import { PrismaService } from '../../../infrastructure/database/index.js';
import type {
  NotificationsPageDto,
  UnreadCountDto,
} from '../dto/notification.dto.js';
import {
  type NotificationRow,
  toNotificationDto,
} from '../mappers/notification.mapper.js';

/** A user's own notifications. Every query is scoped by `user_id` taken from the token: someone else's notification is simply not there. */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Newest first, by cursor: `cursor` is the id of the last item of the previous page. The order is (created_at, id) descending, the
   * position of the cursor row is read in the same statement, so no timestamp is round-tripped through JSON.
   */
  async list(
    userId: string,
    options: { cursor?: string; limit?: number; unread?: boolean },
  ): Promise<NotificationsPageDto> {
    const limit = options.limit ?? COUNT_LIMITS.CURSOR_PAGE_SIZE_DEFAULT;
    const cursor = options.cursor ?? null;
    const unreadOnly = options.unread === true;
    const rows = await this.prisma.$queryRaw<NotificationRow[]>`
      SELECT n.id, n.type, n.course_id, n.actor_id, a.full_name AS actor_name, n.data, n.read_at, n.created_at
        FROM notifications n
        LEFT JOIN users a ON a.id = n.actor_id
       WHERE n.user_id = ${userId}::uuid
         AND (${unreadOnly}::boolean = false OR n.read_at IS NULL)
         AND (${cursor}::uuid IS NULL OR (n.created_at, n.id) < (
               SELECT c.created_at, c.id FROM notifications c WHERE c.id = ${cursor}::uuid AND c.user_id = ${userId}::uuid))
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    return {
      items: page.map(toNotificationDto),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** The badge number. Uses the partial index of unread notifications per user. */
  async unreadCount(userId: string): Promise<UnreadCountDto> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notifications WHERE user_id = ${userId}::uuid AND read_at IS NULL`;
    return { count: rows[0]?.n ?? 0 };
  }

  /** Idempotent: reading an already read notification succeeds and keeps its first `read_at`. Not yours, or not there: 404. */
  async markRead(userId: string, notificationId: string): Promise<void> {
    const updated = await this.prisma.$executeRaw`
      UPDATE notifications SET read_at = now()
       WHERE id = ${notificationId}::uuid AND user_id = ${userId}::uuid AND read_at IS NULL`;
    if (updated > 0) return;
    const exists = await this.prisma.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM notifications WHERE id = ${notificationId}::uuid AND user_id = ${userId}::uuid`;
    if (exists.length === 0) throw new ApiException('NOT_FOUND');
  }

  /** Marks every unread notification of the user as read; returns how many changed. */
  async markAllRead(userId: string): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE notifications SET read_at = now() WHERE user_id = ${userId}::uuid AND read_at IS NULL`;
  }
}
