import { Injectable } from '@nestjs/common';
import { pageWindow } from '../../../common/dto/page-query.dto.js';
import { ApiException } from '../../../common/filters/index.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { AuditWriter } from '../../../infrastructure/audit/index.js';
import {
  PrismaService,
  type Tx,
  lockRow,
} from '../../../infrastructure/database/index.js';
import { emitAfterCommit } from '../../../infrastructure/events/index.js';
import {
  LessonsService,
  type LessonTeacherDto,
  OutlineService,
  type OutlineDto,
} from '../../content/index.js';
import { FilesService } from '../../files/index.js';
import {
  AdminCourseDetailDto,
  AdminCourseItemDto,
  AdminCoursesPageDto,
  AdminCoursesQueryDto,
} from '../dto/course-admin.dto.js';
import {
  COURSE_FROM,
  COURSE_SELECT,
  type CourseRow,
  readCourse,
} from './course-reader.js';
import { CoursesService } from './courses.service.js';

/** LIKE special characters in the Admin's search words are literals. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

type AdminRow = CourseRow & { active_students: number; total?: number };

/**
 * What an Admin does to a course (Decisions 133, 134, 138, 141): the list and the page for Admins, and the three takedown transitions.
 * Every transition takes the Course row exclusively (Course-X), exactly like the Owner's lifecycle, and the lock is the only thing that
 * decides a race between the two (an Owner's restore and an Admin's lock end with a locked course in either order). The `*InTx` methods
 * are what the Admin module composes; this service never opens a transaction of its own for a write.
 */
@Injectable()
export class CourseAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    private readonly files: FilesService,
    private readonly courses: CoursesService,
    private readonly outlines: OutlineService,
    private readonly lessons: LessonsService,
  ) {}

  private readonly url = (key: string | null): string | null =>
    key ? this.files.publicUrl(key) : null;

  // ------------------------------------------------------------------ reads

  async list(query: AdminCoursesQueryDto): Promise<AdminCoursesPageDto> {
    const { page, pageSize, offset } = pageWindow(query);
    const q = query.q ? `%${escapeLike(query.q)}%` : null;
    const rows = await this.prisma.$queryRaw<AdminRow[]>`
      SELECT ${COURSE_SELECT},
             (SELECT count(*)::int FROM enrollments e WHERE e.course_id = c.id AND e.status = 'ACTIVE') AS active_students,
             count(*) OVER ()::int AS total
        ${COURSE_FROM}
       WHERE (${q}::text IS NULL OR c.title ILIKE ${q}::text ESCAPE '\\')
         AND (${query.status ?? null}::text IS NULL OR c.status::text = ${query.status ?? null}::text)
         AND (${query.enrollmentPolicy ?? null}::text IS NULL OR c.enrollment_policy::text = ${query.enrollmentPolicy ?? null}::text)
         AND (${query.locked ?? null}::boolean IS NULL OR (c.locked_by_admin_at IS NOT NULL) = ${query.locked ?? null}::boolean)
         AND (${query.categoryId ?? null}::uuid IS NULL OR c.category_id = ${query.categoryId ?? null}::uuid)
         AND (${query.teacherId ?? null}::uuid IS NULL OR EXISTS (
               SELECT 1 FROM course_teachers x WHERE x.course_id = c.id AND x.user_id = ${query.teacherId ?? null}::uuid))
       ORDER BY c.created_at DESC, c.id
       LIMIT ${pageSize} OFFSET ${offset}`;
    return {
      items: rows.map((row) => this.toItem(row)),
      page,
      pageSize,
      total: rows[0]?.total ?? 0,
    };
  }

  async get(courseId: string): Promise<AdminCourseDetailDto> {
    const rows = await this.prisma.$queryRaw<AdminRow[]>`
      SELECT ${COURSE_SELECT},
             (SELECT count(*)::int FROM enrollments e WHERE e.course_id = c.id AND e.status = 'ACTIVE') AS active_students
        ${COURSE_FROM} WHERE c.id = ${courseId}::uuid`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    return Object.assign(this.toItem(rows[0]), {
      summary: rows[0].summary,
      description: rows[0].description,
      teachers: await this.courses.teachers(courseId),
    });
  }

  /**
   * Read-only review of the content (Decision 138): the teachers' outline and a lesson of any status, also in a locked course. Nothing
   * is written and nothing is audited. The Admin sees what an Owner sees; no course role is involved.
   */
  async outline(courseId: string): Promise<OutlineDto> {
    await this.get(courseId); // 404 for an unknown course
    return this.outlines.outline(courseId, 'OWNER');
  }

  async lesson(courseId: string, lessonId: string): Promise<LessonTeacherDto> {
    return (await this.lessons.get(
      courseId,
      lessonId,
      'OWNER',
    )) as LessonTeacherDto;
  }

  // ------------------------------------------------------------------ takedown

  /**
   * `lock`: PUBLISHED or ARCHIVED -> ARCHIVED with `locked_by_admin_at` (an already archived course stays archived and gets the lock). A
   * draft has nothing to take down (409 `INVALID_STATE_TRANSITION`); a locked course is 409 `COURSE_ALREADY_LOCKED`. The Owner and the
   * Assistants are told after the commit, with the reason.
   */
  async lockInTx(
    tx: Tx,
    input: { courseId: string; actorId: string; reason: string },
  ): Promise<void> {
    const course = await this.lockedRead(tx, input.courseId);
    if (course.locked_by_admin_at !== null)
      throw new ApiException('COURSE_ALREADY_LOCKED');
    if (course.status === 'DRAFT')
      throw new ApiException('INVALID_STATE_TRANSITION', {
        message: 'A draft course cannot be locked',
      });
    await tx.$executeRaw`
      UPDATE courses
         SET status = 'ARCHIVED', archived_at = COALESCE(archived_at, now()), locked_by_admin_at = now(), updated_at = now()
       WHERE id = ${input.courseId}::uuid AND locked_by_admin_at IS NULL`;
    await this.record(
      tx,
      input.actorId,
      'COURSE_ADMIN_LOCKED',
      input.courseId,
      {
        reason: input.reason,
        previousStatus: course.status,
      },
    );
    emitAfterCommit(tx, 'course.admin-locked', {
      courseId: input.courseId,
      lockedBy: input.actorId,
      reason: input.reason,
    });
  }

  /** `unlock`: clears the lock and leaves the course ARCHIVED; the Owner can then restore it. 409 `COURSE_NOT_LOCKED` when it is not locked. */
  async unlockInTx(
    tx: Tx,
    input: { courseId: string; actorId: string },
  ): Promise<void> {
    const course = await this.lockedRead(tx, input.courseId);
    if (course.locked_by_admin_at === null)
      throw new ApiException('COURSE_NOT_LOCKED');
    await tx.$executeRaw`
      UPDATE courses SET locked_by_admin_at = NULL, updated_at = now()
       WHERE id = ${input.courseId}::uuid AND locked_by_admin_at IS NOT NULL`;
    await this.record(
      tx,
      input.actorId,
      'COURSE_ADMIN_UNLOCKED',
      input.courseId,
    );
  }

  /** `restore`: clears the lock and publishes the course again (Decision 134: only an Admin restores a locked course). */
  async restoreInTx(
    tx: Tx,
    input: { courseId: string; actorId: string },
  ): Promise<void> {
    const course = await this.lockedRead(tx, input.courseId);
    if (course.locked_by_admin_at === null)
      throw new ApiException('COURSE_NOT_LOCKED');
    await tx.$executeRaw`
      UPDATE courses SET status = 'PUBLISHED', archived_at = NULL, locked_by_admin_at = NULL, updated_at = now()
       WHERE id = ${input.courseId}::uuid AND locked_by_admin_at IS NOT NULL`;
    await this.record(
      tx,
      input.actorId,
      'COURSE_ADMIN_RESTORED',
      input.courseId,
    );
  }

  // ------------------------------------------------------------------ helpers

  /** Course-X, then the state read AFTER the lock (an Owner's restore or an earlier Admin action is visible now). */
  private async lockedRead(tx: Tx, courseId: string): Promise<CourseRow> {
    if (!(await lockRow(tx, 'course', courseId, 'NO_KEY_UPDATE')))
      throw new ApiException('NOT_FOUND');
    const course = await readCourse(tx, courseId);
    if (!course) throw new ApiException('NOT_FOUND');
    return course;
  }

  private record(
    tx: Tx,
    actorId: string,
    action:
      'COURSE_ADMIN_LOCKED' | 'COURSE_ADMIN_UNLOCKED' | 'COURSE_ADMIN_RESTORED',
    courseId: string,
    metadata: Prisma.InputJsonObject = {},
  ): Promise<void> {
    return this.audit.record(tx, {
      actorId,
      action,
      targetType: 'COURSE',
      targetId: courseId,
      metadata,
    });
  }

  private toItem(row: AdminRow): AdminCourseItemDto {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      enrollmentPolicy: row.enrollment_policy,
      category: row.category_id
        ? {
            id: row.category_id,
            name: row.category_name as string,
            slug: row.category_slug as string,
          }
        : null,
      owner: {
        id: row.owner_id,
        fullName: row.owner_name,
        avatarUrl: this.url(row.owner_key),
      },
      lockedByAdminAt: row.locked_by_admin_at,
      archivedAt: row.archived_at,
      firstPublishedAt: row.first_published_at,
      createdAt: row.created_at,
      activeStudents: row.active_students,
    };
  }
}
