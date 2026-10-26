import { Injectable } from '@nestjs/common';
import { TIME_LIMITS } from '../../../common/constants/limits.js';
import { PrismaService } from '../../../infrastructure/database/index.js';

const DELETE_BATCH = 1000;

/**
 * Retention: a notification that was READ more than 90 days ago is deleted (Decision 75). Unread ones are never deleted, and a recently
 * read old notification stays until 90 days after it was read. A callable method; the nightly schedule is wired in M13. Deletes in
 * batches so one run never holds a long lock.
 */
@Injectable()
export class NotificationRetention {
  constructor(private readonly prisma: PrismaService) {}

  async purgeOldRead(
    retentionDays: number = TIME_LIMITS.NOTIFICATION_RETENTION_DAYS,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM notifications WHERE id IN (
          SELECT id FROM notifications
           WHERE read_at IS NOT NULL AND read_at < now() - make_interval(days => ${retentionDays}::int)
           LIMIT ${DELETE_BATCH})`;
      total += deleted;
      if (deleted < DELETE_BATCH) return total;
    }
  }
}
