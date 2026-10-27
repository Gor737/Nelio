import { Injectable, Logger } from '@nestjs/common';
import {
  PrismaService,
  TransactionService,
  type Tx,
  lockRow,
} from '../../../infrastructure/database/index.js';
import { emitAfterCommit } from '../../../infrastructure/events/index.js';

export interface ChannelSyncResult {
  readonly added: number;
  readonly removed: number;
}

/**
 * The narrow API Courses and Enrollments use for the general channel of a course (Decisions 24, 25, 28, 29, 87). Channel membership is
 * stored in `conversation_members` rows and changes in the SAME transaction as the enrollment or teaching change that causes it; the
 * caller passes its `tx` and holds the Course lock. Every operation is idempotent and a no-op for a course that has no channel yet
 * (a course gets its channel on first publish). The members are the Owner, the Assistants and the ACTIVE students; a student who
 * returns reuses their old row and sees the whole history.
 */
@Injectable()
export class CourseChannelService {
  private readonly logger = new Logger(CourseChannelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
  ) {}

  /** Creates the channel of a course once (a second call returns the same one) and makes its members match the course. */
  async createForCourse(tx: Tx, courseId: string): Promise<string> {
    const created = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO conversations (type, course_id) VALUES ('COURSE_CHANNEL', ${courseId}::uuid)
      ON CONFLICT (course_id) DO NOTHING RETURNING id`;
    let id = created[0]?.id;
    if (!id) {
      const existing = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM conversations WHERE course_id = ${courseId}::uuid`;
      id = existing[0].id;
    }
    await this.syncCourse(tx, courseId);
    return id;
  }

  /** Adds a user to the channel (or brings a former member back). Returns whether the membership changed. */
  async addMember(tx: Tx, courseId: string, userId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ conversation_id: string }[]>`
      INSERT INTO conversation_members (conversation_id, user_id)
      SELECT c.id, ${userId}::uuid FROM conversations c WHERE c.course_id = ${courseId}::uuid
      ON CONFLICT (conversation_id, user_id)
      DO UPDATE SET left_at = NULL, joined_at = now() WHERE conversation_members.left_at IS NOT NULL
      RETURNING conversation_id`;
    if (rows.length === 0) return false;
    emitAfterCommit(tx, 'conversation.added', {
      conversationId: rows[0].conversation_id,
      userId,
    });
    return true;
  }

  /** Ends a user's membership of the channel (their row stays; history stays). Returns whether the membership changed. */
  async endMembership(
    tx: Tx,
    courseId: string,
    userId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ conversation_id: string }[]>`
      UPDATE conversation_members m SET left_at = now()
        FROM conversations c
       WHERE c.id = m.conversation_id AND c.course_id = ${courseId}::uuid
         AND m.user_id = ${userId}::uuid AND m.left_at IS NULL
      RETURNING m.conversation_id`;
    if (rows.length === 0) return false;
    this.announceEnd(tx, rows[0].conversation_id, userId, courseId);
    return true;
  }

  /**
   * Makes the channel's members exactly the course's people: Owner, Assistants and ACTIVE students. Missing ones are added (or brought
   * back), extra ones are ended. Correct state is left untouched, so it is safe to run at any time. The caller holds the Course lock.
   */
  async syncCourse(tx: Tx, courseId: string): Promise<ChannelSyncResult> {
    const channel = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM conversations WHERE course_id = ${courseId}::uuid`;
    if (channel.length === 0) return { added: 0, removed: 0 };
    const conversationId = channel[0].id;
    const added = await tx.$queryRaw<{ user_id: string }[]>`
      WITH desired AS (
        SELECT user_id FROM course_teachers WHERE course_id = ${courseId}::uuid
        UNION
        SELECT user_id FROM enrollments WHERE course_id = ${courseId}::uuid AND status = 'ACTIVE')
      INSERT INTO conversation_members (conversation_id, user_id)
      SELECT ${conversationId}::uuid, user_id FROM desired
      ON CONFLICT (conversation_id, user_id)
      DO UPDATE SET left_at = NULL, joined_at = now() WHERE conversation_members.left_at IS NOT NULL
      RETURNING user_id`;
    const removed = await tx.$queryRaw<{ user_id: string }[]>`
      UPDATE conversation_members m SET left_at = now()
       WHERE m.conversation_id = ${conversationId}::uuid AND m.left_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM course_teachers t WHERE t.course_id = ${courseId}::uuid AND t.user_id = m.user_id)
         AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.course_id = ${courseId}::uuid AND e.user_id = m.user_id AND e.status = 'ACTIVE')
      RETURNING m.user_id`;
    for (const row of added)
      emitAfterCommit(tx, 'conversation.added', {
        conversationId,
        userId: row.user_id,
      });
    for (const row of removed)
      this.announceEnd(tx, conversationId, row.user_id, courseId);
    return { added: added.length, removed: removed.length };
  }

  /**
   * The nightly safety net (Decision 162): re-syncs every course that has a channel, each in its own short transaction under Course-X.
   * Scheduled nightly by `ChannelReconcileJob`. Logs only when it repaired something. One course failing does not stop the others.
   */
  async reconcileAll(): Promise<ChannelSyncResult & { courses: number }> {
    const courses = await this.prisma.$queryRaw<{ course_id: string }[]>`
      SELECT course_id FROM conversations WHERE course_id IS NOT NULL ORDER BY course_id`;
    let added = 0;
    let removed = 0;
    for (const { course_id: courseId } of courses) {
      try {
        const result = await this.transactions.run(async (tx) => {
          if (!(await lockRow(tx, 'course', courseId, 'NO_KEY_UPDATE')))
            return { added: 0, removed: 0 };
          return this.syncCourse(tx, courseId);
        });
        added += result.added;
        removed += result.removed;
      } catch (error) {
        this.logger.error(
          `channel reconcile failed for one course: ${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }
    if (added + removed > 0)
      this.logger.warn({ event: 'channel_reconcile_repaired', added, removed });
    return { added, removed, courses: courses.length };
  }

  private announceEnd(
    tx: Tx,
    conversationId: string,
    userId: string,
    courseId: string,
  ): void {
    emitAfterCommit(tx, 'conversation.removed', { conversationId, userId });
    emitAfterCommit(tx, 'membership.ended', {
      userId,
      courseId,
      conversationId,
    });
  }
}
