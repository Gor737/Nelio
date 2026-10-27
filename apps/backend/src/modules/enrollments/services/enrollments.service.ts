import { Injectable } from '@nestjs/common';
import { ApiException } from '../../../common/filters/index.js';
import {
  PrismaService,
  TransactionService,
} from '../../../infrastructure/database/index.js';
import { FilesService } from '../../files/index.js';
import { ProgressQueries } from '../../progress/index.js';
import type {
  EnrollmentDto,
  MyEnrollmentsPageDto,
  StudentProgressDto,
  StudentsPageDto,
} from '../dto/enrollments.dto.js';
import { EnrollmentMachine } from './enrollment-machine.service.js';
import type {
  EnrollmentAction,
  EnrollmentStatusName,
} from './enrollment-transitions.js';

interface EnrollmentRow {
  id: string;
  course_id: string;
  status: EnrollmentStatusName;
  completed_at: Date | null;
  last_visited_lesson_id: string | null;
  last_visited_at: Date | null;
}

/**
 * Student and teacher actions on enrollments and the lists built on them (Decisions 8, 22, 40, 70, 123, 124, 142). Every change goes through
 * `EnrollmentMachine`, which asks the one allowed-transition function first. Lists show names and avatars, never an email address, and
 * get their progress for a whole page in ONE statement (`ProgressQueries.summaries`).
 */
@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly machine: EnrollmentMachine,
    private readonly progress: ProgressQueries,
    private readonly files: FilesService,
  ) {}

  private readonly url = (key: string | null): string | null =>
    key ? this.files.publicUrl(key) : null;

  private run(
    courseId: string,
    userId: string,
    action: EnrollmentAction,
    actorId?: string,
  ) {
    return this.transactions.run(async (tx) => {
      const course = await this.machine.lockCourse(tx, courseId);
      return this.machine.apply(tx, course, {
        courseId,
        userId,
        action,
        actorId,
      });
    });
  }

  /** Enroll, or return after leaving or being rejected, under the course's CURRENT policy. */
  async enroll(userId: string, courseId: string): Promise<EnrollmentDto> {
    await this.run(courseId, userId, 'ENROLL');
    return this.mine(userId, courseId);
  }

  /** Leave, or cancel a pending request. Allowed in any course status, also archived and Admin-locked (Decision 142). */
  async leave(userId: string, courseId: string): Promise<void> {
    await this.run(courseId, userId, 'LEAVE');
  }

  async approve(
    actorId: string,
    courseId: string,
    studentId: string,
  ): Promise<void> {
    await this.run(courseId, studentId, 'APPROVE', actorId);
  }

  async reject(
    actorId: string,
    courseId: string,
    studentId: string,
  ): Promise<void> {
    await this.run(courseId, studentId, 'REJECT', actorId);
  }

  /** Owner (and Admin, through Admin endpoints): allowed in any course status. Completions are kept. */
  async remove(
    actorId: string,
    courseId: string,
    studentId: string,
  ): Promise<void> {
    await this.run(courseId, studentId, 'REMOVE', actorId);
  }

  /** Owner (and Admin): REMOVED -> ACTIVE with the old progress; refused on an archived or locked course. */
  async reinstate(
    actorId: string,
    courseId: string,
    studentId: string,
  ): Promise<void> {
    await this.run(courseId, studentId, 'REINSTATE', actorId);
  }

  /** My own enrollment with its summary. `completedAt` and `percent` are separate (Decision 126). 404 without an enrollment. */
  async mine(userId: string, courseId: string): Promise<EnrollmentDto> {
    const rows = await this.prisma.$queryRaw<EnrollmentRow[]>`
      SELECT id, course_id, status, completed_at, last_visited_lesson_id, last_visited_at
        FROM enrollments WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    const summary = await this.progress.summary(rows[0].id);
    return this.toDto(rows[0], summary);
  }

  /** The lesson to continue from (Decision 22). It must be a published lesson of this course; the pointer is only written for an ACTIVE student. */
  async setLastVisited(
    userId: string,
    courseId: string,
    lessonId: string,
  ): Promise<void> {
    const updated = await this.prisma.$executeRaw`
      UPDATE enrollments SET last_visited_lesson_id = ${lessonId}::uuid, last_visited_at = now(), updated_at = now()
       WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid AND status = 'ACTIVE'
         AND EXISTS (SELECT 1 FROM lessons l WHERE l.id = ${lessonId}::uuid AND l.course_id = ${courseId}::uuid AND l.status = 'PUBLISHED')`;
    if (updated === 0) {
      const own = await this.prisma.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM enrollments WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid AND status = 'ACTIVE'`;
      throw new ApiException(own.length === 0 ? 'FORBIDDEN' : 'NOT_FOUND');
    }
  }

  /** "My courses": my enrollments (default ACTIVE and PENDING) with their progress, one statement for the page's progress. */
  async myEnrollments(
    userId: string,
    query: { status?: EnrollmentStatusName },
    window: { page: number; pageSize: number; offset: number },
  ): Promise<MyEnrollmentsPageDto> {
    const rows = await this.prisma.$queryRaw<
      (EnrollmentRow & {
        title: string;
        course_status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
        cover_key: string | null;
        total: number;
      })[]
    >`
      SELECT e.id, e.course_id, e.status, e.completed_at, e.last_visited_lesson_id, e.last_visited_at,
             c.title, c.status AS course_status, f.storage_key AS cover_key, count(*) OVER ()::int AS total
        FROM enrollments e JOIN courses c ON c.id = e.course_id LEFT JOIN file_assets f ON f.id = c.cover_file_id
       WHERE e.user_id = ${userId}::uuid
         AND (CASE WHEN ${query.status ?? null}::text IS NULL THEN e.status IN ('ACTIVE', 'PENDING') ELSE e.status::text = ${query.status ?? null}::text END)
         AND c.locked_by_admin_at IS NULL
       ORDER BY e.updated_at DESC, e.id
       LIMIT ${window.pageSize} OFFSET ${window.offset}`;
    const summaries = await this.progress.summaries(rows.map((r) => r.id));
    return {
      items: rows.map((r) =>
        Object.assign(this.toDto(r, summaries.get(r.id) ?? null), {
          courseTitle: r.title,
          courseStatus: r.course_status,
          coverUrl: this.url(r.cover_key),
        }),
      ),
      page: window.page,
      pageSize: window.pageSize,
      total: rows[0]?.total ?? 0,
    };
  }

  /** The students of a course for its teachers (default ACTIVE and PENDING), with progress, no email. */
  async students(
    courseId: string,
    query: { status?: EnrollmentStatusName },
    window: { page: number; pageSize: number; offset: number },
  ): Promise<StudentsPageDto> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        user_id: string;
        full_name: string;
        storage_key: string | null;
        status: EnrollmentStatusName;
        completed_at: Date | null;
        total: number;
      }[]
    >`
      SELECT e.id, e.user_id, u.full_name, f.storage_key, e.status, e.completed_at, count(*) OVER ()::int AS total
        FROM enrollments e JOIN users u ON u.id = e.user_id LEFT JOIN file_assets f ON f.id = u.avatar_file_id
       WHERE e.course_id = ${courseId}::uuid
         AND (CASE WHEN ${query.status ?? null}::text IS NULL THEN e.status IN ('ACTIVE', 'PENDING') ELSE e.status::text = ${query.status ?? null}::text END)
       ORDER BY u.full_name, e.id
       LIMIT ${window.pageSize} OFFSET ${window.offset}`;
    const summaries = await this.progress.summaries(rows.map((r) => r.id));
    return {
      items: rows.map((r) => ({
        student: {
          id: r.user_id,
          fullName: r.full_name,
          avatarUrl: this.url(r.storage_key),
        },
        status: r.status,
        completedAt: r.completed_at,
        progress: this.progressOf(summaries.get(r.id) ?? null),
      })),
      page: window.page,
      pageSize: window.pageSize,
      total: rows[0]?.total ?? 0,
    };
  }

  async studentProgress(
    courseId: string,
    studentId: string,
  ): Promise<StudentProgressDto> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        full_name: string;
        storage_key: string | null;
        status: EnrollmentStatusName;
        completed_at: Date | null;
      }[]
    >`
      SELECT e.id, u.full_name, f.storage_key, e.status, e.completed_at
        FROM enrollments e JOIN users u ON u.id = e.user_id LEFT JOIN file_assets f ON f.id = u.avatar_file_id
       WHERE e.course_id = ${courseId}::uuid AND e.user_id = ${studentId}::uuid`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    const r = rows[0];
    return {
      student: {
        id: studentId,
        fullName: r.full_name,
        avatarUrl: this.url(r.storage_key),
      },
      status: r.status,
      completedAt: r.completed_at,
      progress: this.progressOf(await this.progress.summary(r.id)),
      completedLessonIds: await this.progress.completedLessonIds(r.id),
    };
  }

  private toDto(
    row: EnrollmentRow,
    summary: Awaited<ReturnType<ProgressQueries['summary']>>,
  ): EnrollmentDto {
    return {
      courseId: row.course_id,
      status: row.status,
      completedAt: row.completed_at,
      lastVisitedLessonId: row.last_visited_lesson_id,
      lastVisitedAt: row.last_visited_at,
      progress: this.progressOf(summary),
    };
  }

  private progressOf(summary: Awaited<ReturnType<ProgressQueries['summary']>>) {
    return {
      completedLessons: summary?.completedLessons ?? 0,
      totalLessons: summary?.totalLessons ?? 0,
      percent: summary?.percent ?? 0,
    };
  }
}
