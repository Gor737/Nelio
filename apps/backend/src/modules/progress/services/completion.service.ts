import { Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../../../common/filters/index.js';
import {
  type Tx,
  TransactionService,
  PrismaService,
  lockRow,
} from '../../../infrastructure/database/index.js';
import { type ProgressSummary, ProgressQueries } from './progress-queries.js';

export interface LessonCompletionResult {
  readonly lessonId: string;
  /** When this lesson was first marked complete (the same on every repeat). */
  readonly completedAt: Date;
  /** True only for the call whose conditional update set `Enrollment.completed_at` (exactly one caller ever sees it). */
  readonly courseCompleted: boolean;
  readonly progress: ProgressSummary;
}

/**
 * Lesson completion and course completion (Decisions 12, 126; docs/architecture.md section 15, "Completion architecture").
 *
 * Course completion is a permanent `Enrollment.completed_at` snapshot, set automatically and never cleared. It requires at least one
 * published lesson and an ACTIVE enrollment that has completed every lesson published at that moment. The snapshot is written by ONE
 * conditional update (`WHERE completed_at IS NULL`), so when several transactions reach the finish together exactly one gets a row back.
 *
 * Why Course-S (marking) and Course-X (lesson publish/unpublish/archive) matter: a student who marks the last lesson while a teacher
 * unpublishes the one lesson they had not finished would each see a state in which the course is not complete, and nobody would ever
 * re-check. Course-S and Course-X exclude each other, so one of the two runs entirely first and the second sees its result (Bug 1).
 *
 * The `recheck*` methods run inside the caller's transaction and expect the caller to hold the Course lock already (S or X); they are the
 * calls Content makes on unpublish/archive and Enrollments makes when an enrollment becomes ACTIVE.
 */
@Injectable()
export class CompletionService {
  private readonly logger = new Logger(CompletionService.name);

  constructor(
    private readonly transactions: TransactionService,
    private readonly prisma: PrismaService,
    private readonly queries: ProgressQueries,
  ) {}

  /**
   * Marks a lesson complete for the student `userId`. Idempotent and permanent (there is no un-complete).
   * Lock order: Course row FOR SHARE (Course-S), then the Enrollment row FOR NO KEY UPDATE (it is read in the same statement, so the
   * status is the one after any concurrent removal committed).
   *
   * The Enrollment lock is exclusive on purpose, not the FOR SHARE of the transaction catalog: two marks by the same student share
   * the lock, and then (a) the one that completes the course cannot upgrade it while the other waits for its uncommitted completion row
   * (a deadlock), and (b) two marks of the last two lessons would each miss the other's uncommitted row, leaving a finished course
   * unmarked. FOR NO KEY UPDATE serializes one student's marks, does not block the foreign-key check of the completion insert, and
   * never delays another student.
   *
   * - the student has no enrollment, or it is not ACTIVE (for example removed a moment ago): 403 FORBIDDEN;
   * - the lesson does not exist, is not in this course, or is not PUBLISHED: 404 NOT_FOUND (a student never learns about drafts).
   */
  async markComplete(
    userId: string,
    courseId: string,
    lessonId: string,
  ): Promise<LessonCompletionResult> {
    return this.transactions.run(async (tx) => {
      if (!(await lockRow(tx, 'course', courseId, 'SHARE')))
        throw new ApiException('NOT_FOUND');
      const enrollments = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM enrollments
         WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid FOR NO KEY UPDATE`;
      const enrollment = enrollments[0];
      if (!enrollment || enrollment.status !== 'ACTIVE')
        throw new ApiException('FORBIDDEN');

      const lessons = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM lessons
         WHERE id = ${lessonId}::uuid AND course_id = ${courseId}::uuid AND status = 'PUBLISHED'`;
      if (lessons.length === 0) throw new ApiException('NOT_FOUND');

      await tx.$executeRaw`
        INSERT INTO lesson_completions (enrollment_id, lesson_id, course_id)
        VALUES (${enrollment.id}::uuid, ${lessonId}::uuid, ${courseId}::uuid)
        ON CONFLICT (enrollment_id, lesson_id) DO NOTHING`;
      const done = await tx.$queryRaw<{ completed_at: Date }[]>`
        SELECT completed_at FROM lesson_completions
         WHERE enrollment_id = ${enrollment.id}::uuid AND lesson_id = ${lessonId}::uuid`;

      const courseCompleted = await this.recheckEnrollment(tx, enrollment.id);
      const progress = await this.queries.summary(enrollment.id, tx);
      return {
        lessonId,
        completedAt: done[0].completed_at,
        courseCompleted,
        progress: progress as ProgressSummary,
      };
    });
  }

  /**
   * Completes the enrollment if it qualifies; returns whether THIS call completed it (the conditional update's row count).
   * Qualifies: ACTIVE, not completed yet, at least one published lesson, and every published lesson completed. The caller holds the
   * Course lock.
   */
  async recheckEnrollment(tx: Tx, enrollmentId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE enrollments e SET completed_at = now(), updated_at = now()
       WHERE e.id = ${enrollmentId}::uuid AND e.status = 'ACTIVE' AND e.completed_at IS NULL
         AND EXISTS (SELECT 1 FROM lessons l WHERE l.course_id = e.course_id AND l.status = 'PUBLISHED')
         AND NOT EXISTS (
           SELECT 1 FROM lessons l
            WHERE l.course_id = e.course_id AND l.status = 'PUBLISHED'
              AND NOT EXISTS (SELECT 1 FROM lesson_completions lc WHERE lc.enrollment_id = e.id AND lc.lesson_id = l.id))
      RETURNING e.id`;
    return rows.length === 1;
  }

  /**
   * The same check for every ACTIVE, incomplete enrollment of one course, in one statement (after a lesson was unpublished or archived).
   * Returns the ids of the enrollments completed by this call. The caller holds the Course lock (X after an unpublish).
   */
  async recheckCourse(tx: Tx, courseId: string): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE enrollments e SET completed_at = now(), updated_at = now()
       WHERE e.course_id = ${courseId}::uuid AND e.status = 'ACTIVE' AND e.completed_at IS NULL
         AND EXISTS (SELECT 1 FROM lessons l WHERE l.course_id = e.course_id AND l.status = 'PUBLISHED')
         AND NOT EXISTS (
           SELECT 1 FROM lessons l
            WHERE l.course_id = e.course_id AND l.status = 'PUBLISHED'
              AND NOT EXISTS (SELECT 1 FROM lesson_completions lc WHERE lc.enrollment_id = e.id AND lc.lesson_id = l.id))
      RETURNING e.id`;
    return rows.map((r) => r.id);
  }

  /**
   * The nightly full recheck (safety net for a path that forgot a trigger): every course that has an ACTIVE incomplete enrollment is
   * re-checked in its own short transaction under Course-S (scheduled nightly by `CompletionRecheckJob`). Logs when it repaired something. One course failing is
   * logged and does not stop the others.
   */
  async recheckAllCourses(): Promise<{
    coursesChecked: number;
    enrollmentsCompleted: number;
  }> {
    const courses = await this.prisma.$queryRaw<{ course_id: string }[]>`
      SELECT DISTINCT e.course_id FROM enrollments e
       WHERE e.status = 'ACTIVE' AND e.completed_at IS NULL
         AND EXISTS (SELECT 1 FROM lessons l WHERE l.course_id = e.course_id AND l.status = 'PUBLISHED')
       ORDER BY e.course_id`;
    let coursesChecked = 0;
    let enrollmentsCompleted = 0;
    for (const { course_id: courseId } of courses) {
      try {
        const completed = await this.transactions.run(async (tx) => {
          if (!(await lockRow(tx, 'course', courseId, 'SHARE'))) return [];
          return this.recheckCourse(tx, courseId);
        });
        coursesChecked += 1;
        enrollmentsCompleted += completed.length;
      } catch (error) {
        this.logger.error(
          `completion recheck failed for one course: ${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }
    if (enrollmentsCompleted > 0)
      this.logger.warn({
        event: 'completion_recheck_repaired',
        enrollmentsCompleted,
      });
    return { coursesChecked, enrollmentsCompleted };
  }
}
