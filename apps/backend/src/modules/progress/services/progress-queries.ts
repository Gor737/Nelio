import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infrastructure/database/index.js';

/** Anything that can run a raw query: the `PrismaService` and a transaction client both fit. */
export type ProgressDb = Pick<PrismaClient, '$queryRaw'>;

/**
 * The live progress of one enrollment (Decisions 12, 126): counts over the lessons that are PUBLISHED right now. It is never stored.
 * `percent` is separate from `Enrollment.completed_at` (the permanent completion snapshot): a student can be completed with a percent
 * below 100 after new lessons were published.
 */
export interface ProgressSummary {
  readonly enrollmentId: string;
  readonly completedLessons: number;
  readonly totalLessons: number;
  readonly percent: number;
}

/** Whole percent, rounded DOWN, so a student with an unfinished lesson never shows 100. No published lesson is 0. */
export function percentOf(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.floor((Math.min(completed, total) * 100) / total);
}

/** Progress reads. Every method is exactly one SQL statement, whatever the number of enrollments (docs/architecture.md section 13). */
@Injectable()
export class ProgressQueries {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The progress of many enrollments in ONE statement (a teacher's student list, the student's own summary). Enrollments that do not
   * exist are absent from the result. Only completions of lessons that are published now count, and only published lessons are counted.
   */
  async summaries(
    enrollmentIds: readonly string[],
    db: ProgressDb = this.prisma,
  ): Promise<Map<string, ProgressSummary>> {
    const result = new Map<string, ProgressSummary>();
    if (enrollmentIds.length === 0) return result;
    const rows = await db.$queryRaw<
      { enrollment_id: string; completed: number; total: number }[]
    >`
      SELECT e.id AS enrollment_id,
             (SELECT count(*)::int FROM lesson_completions lc
                JOIN lessons l ON l.id = lc.lesson_id AND l.status = 'PUBLISHED'
               WHERE lc.enrollment_id = e.id) AS completed,
             (SELECT count(*)::int FROM lessons l
               WHERE l.course_id = e.course_id AND l.status = 'PUBLISHED') AS total
        FROM enrollments e
       WHERE e.id = ANY(${[...enrollmentIds]}::uuid[])`;
    for (const row of rows) {
      result.set(row.enrollment_id, {
        enrollmentId: row.enrollment_id,
        completedLessons: row.completed,
        totalLessons: row.total,
        percent: percentOf(row.completed, row.total),
      });
    }
    return result;
  }

  async summary(
    enrollmentId: string,
    db: ProgressDb = this.prisma,
  ): Promise<ProgressSummary | null> {
    return (await this.summaries([enrollmentId], db)).get(enrollmentId) ?? null;
  }

  /** The ids of the lessons this enrollment has completed (one statement), for marking the outline. */
  async completedLessonIds(
    enrollmentId: string,
    db: ProgressDb = this.prisma,
  ): Promise<string[]> {
    const rows = await db.$queryRaw<{ lesson_id: string }[]>`
      SELECT lesson_id FROM lesson_completions WHERE enrollment_id = ${enrollmentId}::uuid ORDER BY completed_at, lesson_id`;
    return rows.map((r) => r.lesson_id);
  }
}
