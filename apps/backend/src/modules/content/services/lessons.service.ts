import { Injectable } from '@nestjs/common';
import { assertCourseMutable } from '../../../common/access/index.js';
import type { CourseRelationship } from '../../../common/constants/permission-matrix.js';
import { ApiException } from '../../../common/filters/index.js';
import {
  PrismaService,
  TransactionService,
  type Tx,
  lockRow,
} from '../../../infrastructure/database/index.js';
import { emitAfterCommit } from '../../../infrastructure/events/index.js';
import { CompletionService } from '../../progress/index.js';
import type {
  LessonStatusName,
  LessonStudentDto,
  LessonSummaryDto,
  LessonTeacherDto,
} from '../dto/content.dto.js';
import {
  isTeacherRelationship,
  visibleLessonWhere,
} from '../visible-lessons.js';
import { readBlocks } from './block-reader.js';
import { reorderFullList } from './reorder.js';

interface LessonRow {
  id: string;
  section_id: string;
  title: string;
  position: number;
  status: LessonStatusName;
  first_published_at: Date | null;
}

const toSummary = (row: LessonRow): LessonSummaryDto => ({
  id: row.id,
  sectionId: row.section_id,
  title: row.title,
  position: row.position,
  status: row.status,
  firstPublishedAt: row.first_published_at,
});

/**
 * Lessons: reads, edits and the lifecycle (Decisions 9, 19, 20, 69, 122).
 *
 * Lifecycle (conditional updates from a known state, under Course-X then the Lesson row):
 *   DRAFT -> PUBLISHED (publish), ARCHIVED -> PUBLISHED (publish), PUBLISHED -> DRAFT (unpublish), PUBLISHED -> ARCHIVED (archive).
 *   Anything else is 409 `INVALID_STATE_TRANSITION`. Publishing needs at least one block. Unpublish and archive re-check course
 *   completion inside the same Course-X transaction (`recheckCourse`); publishing never needs a recheck. The first publication of a
 *   lesson sets `first_published_at` and notifies the active students (after commit).
 *
 * Permanent deletion (approved 2026-10-26): only a lesson that is not published, was never published and has no completions.
 */
@Injectable()
export class LessonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly completion: CompletionService,
  ) {}

  /** A lesson with its blocks. Teachers see any status; an ACTIVE student only a published lesson (anything else is 404). */
  async get(
    courseId: string,
    lessonId: string,
    relationship: CourseRelationship,
  ): Promise<LessonTeacherDto | LessonStudentDto> {
    const visible = visibleLessonWhere(relationship, 'l');
    const rows = await this.prisma.$queryRaw<LessonRow[]>`
      SELECT l.id, l.section_id, l.title, l.position, l.status, l.first_published_at
        FROM lessons l
       WHERE l.id = ${lessonId}::uuid AND l.course_id = ${courseId}::uuid AND ${visible}`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    const blocks = await readBlocks(this.prisma, lessonId);
    const row = rows[0];
    if (isTeacherRelationship(relationship))
      return Object.assign(toSummary(row), { blocks });
    return {
      id: row.id,
      sectionId: row.section_id,
      title: row.title,
      position: row.position,
      blocks,
    };
  }

  /** Appends a DRAFT lesson to the section. The Section row is locked, so parallel appends get different positions. */
  async create(
    courseId: string,
    sectionId: string,
    title: string,
  ): Promise<LessonSummaryDto> {
    return this.transactions.run(async (tx) => {
      const section = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM sections WHERE id = ${sectionId}::uuid AND course_id = ${courseId}::uuid FOR NO KEY UPDATE`;
      if (section.length === 0) throw new ApiException('NOT_FOUND');
      await assertCourseMutable(tx, courseId);
      const rows = await tx.$queryRaw<LessonRow[]>`
        INSERT INTO lessons (course_id, section_id, title, position)
        VALUES (${courseId}::uuid, ${sectionId}::uuid, ${title},
                (SELECT COALESCE(MAX(position) + 1, 0) FROM lessons WHERE section_id = ${sectionId}::uuid))
        RETURNING id, section_id, title, position, status, first_published_at`;
      return toSummary(rows[0]);
    });
  }

  async rename(
    courseId: string,
    lessonId: string,
    title: string,
  ): Promise<LessonSummaryDto> {
    const found = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM lessons WHERE id = ${lessonId}::uuid AND course_id = ${courseId}::uuid`;
    if (found.length === 0) throw new ApiException('NOT_FOUND');
    await assertCourseMutable(this.prisma, courseId);
    const rows = await this.prisma.$queryRaw<LessonRow[]>`
      UPDATE lessons SET title = ${title}, updated_at = now()
       WHERE id = ${lessonId}::uuid AND course_id = ${courseId}::uuid
      RETURNING id, section_id, title, position, status, first_published_at`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    return toSummary(rows[0]);
  }

  /**
   * Moves a lesson to the end of another section of the SAME course. A section or lesson of another course is 404 (the ids are not part
   * of this course). Course-X, then the target Section row, so it cannot interleave with an append to that section.
   */
  async move(
    courseId: string,
    lessonId: string,
    targetSectionId: string,
  ): Promise<LessonSummaryDto> {
    return this.transactions.run(async (tx) => {
      if (!(await lockRow(tx, 'course', courseId, 'NO_KEY_UPDATE')))
        throw new ApiException('NOT_FOUND');
      const target = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM sections WHERE id = ${targetSectionId}::uuid AND course_id = ${courseId}::uuid FOR NO KEY UPDATE`;
      const lesson = await this.lockLesson(tx, courseId, lessonId);
      if (target.length === 0 || !lesson) throw new ApiException('NOT_FOUND');
      await assertCourseMutable(tx, courseId);
      const rows = await tx.$queryRaw<LessonRow[]>`
        UPDATE lessons SET section_id = ${targetSectionId}::uuid, updated_at = now(),
               position = (SELECT COALESCE(MAX(position) + 1, 0) FROM lessons WHERE section_id = ${targetSectionId}::uuid)
         WHERE id = ${lessonId}::uuid AND course_id = ${courseId}::uuid
        RETURNING id, section_id, title, position, status, first_published_at`;
      return toSummary(rows[0]);
    });
  }

  async reorder(
    courseId: string,
    sectionId: string,
    ids: readonly string[],
  ): Promise<void> {
    await this.transactions.run(async (tx) => {
      const section = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM sections WHERE id = ${sectionId}::uuid AND course_id = ${courseId}::uuid FOR NO KEY UPDATE`;
      if (section.length === 0) throw new ApiException('NOT_FOUND');
      await assertCourseMutable(tx, courseId);
      await reorderFullList(tx, 'lessons', sectionId, ids);
    });
  }

  publish(courseId: string, lessonId: string): Promise<LessonSummaryDto> {
    return this.transition(
      courseId,
      lessonId,
      ['DRAFT', 'ARCHIVED'],
      'PUBLISHED',
    );
  }

  unpublish(courseId: string, lessonId: string): Promise<LessonSummaryDto> {
    return this.transition(courseId, lessonId, ['PUBLISHED'], 'DRAFT');
  }

  archive(courseId: string, lessonId: string): Promise<LessonSummaryDto> {
    return this.transition(courseId, lessonId, ['PUBLISHED'], 'ARCHIVED');
  }

  /**
   * Permanent deletion, under the Lesson row. Refused (409 `INVALID_STATE_TRANSITION`) while the lesson is published, if it was ever
   * published (`first_published_at` is set), or if any student completed it. A student who completed it is also stopped by the
   * `RESTRICT` foreign key, which is the safety net behind the check.
   */
  async delete(courseId: string, lessonId: string): Promise<void> {
    await this.transactions.run(async (tx) => {
      const lesson = await this.lockLesson(tx, courseId, lessonId);
      if (!lesson) throw new ApiException('NOT_FOUND');
      await assertCourseMutable(tx, courseId);
      if (lesson.status === 'PUBLISHED')
        throw new ApiException('INVALID_STATE_TRANSITION', {
          message: 'A published lesson cannot be deleted; unpublish it first',
        });
      if (lesson.first_published_at !== null)
        throw new ApiException('INVALID_STATE_TRANSITION', {
          message:
            'A lesson that was published once cannot be deleted; archive it instead',
        });
      const completions = await tx.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM lesson_completions WHERE lesson_id = ${lessonId}::uuid LIMIT 1`;
      if (completions.length > 0)
        throw new ApiException('INVALID_STATE_TRANSITION', {
          message: 'A lesson that students completed cannot be deleted',
        });
      await tx.$executeRaw`DELETE FROM lessons WHERE id = ${lessonId}::uuid`;
    });
  }

  private async transition(
    courseId: string,
    lessonId: string,
    from: readonly LessonStatusName[],
    to: LessonStatusName,
  ): Promise<LessonSummaryDto> {
    return this.transactions.run(async (tx) => {
      // Course-X first (this is what keeps a student's "mark complete", which holds Course-S, from interleaving), then the Lesson row.
      if (!(await lockRow(tx, 'course', courseId, 'NO_KEY_UPDATE')))
        throw new ApiException('NOT_FOUND');
      const lesson = await this.lockLesson(tx, courseId, lessonId);
      if (!lesson) throw new ApiException('NOT_FOUND');
      await assertCourseMutable(tx, courseId);
      if (!from.includes(lesson.status))
        throw new ApiException('INVALID_STATE_TRANSITION', {
          message: `A ${lesson.status} lesson cannot become ${to}`,
        });
      if (to === 'PUBLISHED') {
        const blocks = await tx.$queryRaw<{ one: number }[]>`
          SELECT 1 AS one FROM content_blocks WHERE lesson_id = ${lessonId}::uuid LIMIT 1`;
        if (blocks.length === 0)
          throw new ApiException('INVALID_STATE_TRANSITION', {
            message: 'A lesson needs at least one block to be published',
          });
      }
      const rows = await tx.$queryRaw<LessonRow[]>`
        UPDATE lessons
           SET status = ${to}::lesson_status,
               first_published_at = CASE WHEN ${to} = 'PUBLISHED' THEN COALESCE(first_published_at, now()) ELSE first_published_at END,
               updated_at = now()
         WHERE id = ${lessonId}::uuid AND course_id = ${courseId}::uuid AND status = ${lesson.status}::lesson_status
        RETURNING id, section_id, title, position, status, first_published_at`;
      if (rows.length === 0) throw new ApiException('INVALID_STATE_TRANSITION');
      if (to === 'PUBLISHED' && lesson.first_published_at === null) {
        emitAfterCommit(tx, 'lesson.first-published', { courseId, lessonId });
      }
      if (to !== 'PUBLISHED') await this.completion.recheckCourse(tx, courseId);
      return toSummary(rows[0]);
    });
  }

  /** The lesson of THIS course, locked `FOR NO KEY UPDATE` (the state read after the lock is the state the change runs against). */
  private async lockLesson(
    tx: Tx,
    courseId: string,
    lessonId: string,
  ): Promise<LessonRow | null> {
    const rows = await tx.$queryRaw<LessonRow[]>`
      SELECT id, section_id, title, position, status, first_published_at FROM lessons
       WHERE id = ${lessonId}::uuid AND course_id = ${courseId}::uuid FOR NO KEY UPDATE`;
    return rows[0] ?? null;
  }
}
