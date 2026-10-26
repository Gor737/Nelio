import { Injectable } from '@nestjs/common';
import { assertCourseMutable } from '../../../common/access/index.js';
import type { CourseRelationship } from '../../../common/constants/permission-matrix.js';
import { ApiException } from '../../../common/filters/index.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { AuditWriter } from '../../../infrastructure/audit/index.js';
import {
  PrismaService,
  TransactionService,
  type Tx,
  lockRow,
} from '../../../infrastructure/database/index.js';
import { CourseTagsService } from '../../catalog/index.js';
import { CourseChannelService } from '../../chat/index.js';
import { OutlineService } from '../../content/index.js';
import { FilesService } from '../../files/index.js';
import type {
  CatalogPageDto,
  CatalogQueryDto,
  CourseDetailDto,
  CourseTeacherDto,
  CreateCourseDto,
  TagRefDto,
  TeachingCoursesPageDto,
  UpdateCourseDto,
} from '../dto/courses.dto.js';
import {
  COURSE_FROM,
  COURSE_SELECT,
  type CourseRow,
  readCourse,
  toCard,
} from './course-reader.js';

const fail = (field: string, message: string): ApiException =>
  new ApiException('VALIDATION_FAILED', {
    errors: [{ field, messages: [message] }],
  });

/** A safe `tsquery` from free text: only letters, digits and combining marks survive, so no tsquery syntax can be injected. The last word also matches as a prefix. */
export function toPrefixTsQuery(text: string): string | null {
  const words = (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}\p{M}]+/gu) ?? []
  ).slice(0, 8);
  if (words.length === 0) return null;
  return words
    .map((word, i) => (i === words.length - 1 ? `${word}:*` : word))
    .join(' & ');
}

/**
 * Courses (Decisions 11, 14, 15, 61-63, 88, 118-121, 134): create, settings, tags, the lifecycle, the public catalog and the course page.
 *
 * Every lifecycle transition takes the Course row exclusively (Course-X) and then reads the state, so two transitions (or a publish and an
 * enrollment) never interleave; the transition is a conditional change from a known state and writes its audit row in the same
 * transaction. There is no way back to DRAFT. The Owner is re-checked after the lock, because a transfer can happen between the guard and
 * the lock. A course locked by an Admin cannot be changed by its team (409 `COURSE_ADMIN_LOCKED`, before `COURSE_ARCHIVED`).
 */
@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly files: FilesService,
    private readonly tags: CourseTagsService,
    private readonly channels: CourseChannelService,
    private readonly audit: AuditWriter,
    private readonly outline: OutlineService,
  ) {}

  private readonly url = (key: string | null): string | null =>
    key ? this.files.publicUrl(key) : null;

  // ------------------------------------------------------------------ create and settings

  /**
   * Creates a DRAFT course owned by the caller. Locks the caller's own User row (User-S) and re-checks that they are an ACTIVE Teacher after
   * the lock, so revoking the Teacher role cannot interleave with creating a course (revocation takes User-X).
   */
  async create(
    userId: string,
    input: CreateCourseDto,
  ): Promise<CourseDetailDto> {
    const id = await this.transactions.run(async (tx) => {
      if (!(await lockRow(tx, 'user', userId, 'SHARE')))
        throw new ApiException('NOT_FOUND');
      const teacher = await tx.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM user_roles r JOIN users u ON u.id = r.user_id
         WHERE r.user_id = ${userId}::uuid AND r.role = 'TEACHER' AND r.status = 'ACTIVE' AND u.status = 'ACTIVE'`;
      if (teacher.length === 0) throw new ApiException('TEACHER_NOT_APPROVED');
      if (input.categoryId) await this.requireCategory(tx, input.categoryId);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO courses (title, summary, description, enrollment_policy, category_id)
        VALUES (${input.title}, ${input.summary ?? null}, ${input.description ?? null},
                ${input.enrollmentPolicy}::enrollment_policy, ${input.categoryId ?? null}::uuid)
        RETURNING id`;
      await tx.$executeRaw`
        INSERT INTO course_teachers (course_id, user_id, role, added_by)
        VALUES (${rows[0].id}::uuid, ${userId}::uuid, 'OWNER', ${userId}::uuid)`;
      return rows[0].id;
    });
    return this.detail(id, 'OWNER');
  }

  /**
   * Changes settings (Owner only). A published or archived course must keep its category and summary (the database CHECK would reject it;
   * the answer here is a clear 400). The cover must be a COURSE_COVER you uploaded. 409 `COURSE_ADMIN_LOCKED` / `COURSE_ARCHIVED` first.
   */
  async update(
    actorId: string,
    courseId: string,
    input: UpdateCourseDto,
  ): Promise<CourseDetailDto> {
    await this.transactions.run(async (tx) => {
      await assertCourseMutable(tx, courseId);
      const current = await readCourse(tx, courseId);
      if (!current) throw new ApiException('NOT_FOUND');
      const next = {
        summary: input.summary !== undefined ? input.summary : current.summary,
        categoryId:
          input.categoryId !== undefined
            ? input.categoryId
            : current.category_id,
      };
      if (current.status !== 'DRAFT') {
        if (next.summary === null)
          throw fail('summary', 'A published course needs a summary');
        if (next.categoryId === null)
          throw fail('categoryId', 'A published course needs a category');
      }
      if (input.categoryId) await this.requireCategory(tx, input.categoryId);
      if (typeof input.coverFileId === 'string') {
        const file = await tx.$queryRaw<{ kind: string }[]>`
          SELECT kind FROM file_assets WHERE id = ${input.coverFileId}::uuid AND uploaded_by = ${actorId}::uuid`;
        if (file.length === 0) throw new ApiException('NOT_FOUND');
        if (file[0].kind !== 'COURSE_COVER')
          throw fail('coverFileId', 'The file must be a course cover');
      }
      const sets: Prisma.Sql[] = [];
      if (input.title !== undefined)
        sets.push(Prisma.sql`title = ${input.title}`);
      if (input.enrollmentPolicy !== undefined)
        sets.push(
          Prisma.sql`enrollment_policy = ${input.enrollmentPolicy}::enrollment_policy`,
        );
      if (input.summary !== undefined)
        sets.push(Prisma.sql`summary = ${input.summary}`);
      if (input.description !== undefined)
        sets.push(Prisma.sql`description = ${input.description}`);
      if (input.categoryId !== undefined)
        sets.push(Prisma.sql`category_id = ${input.categoryId}::uuid`);
      if (input.coverFileId !== undefined)
        sets.push(Prisma.sql`cover_file_id = ${input.coverFileId}::uuid`);
      if (sets.length === 0) return;
      const updated = await tx.$executeRaw`
        UPDATE courses SET ${Prisma.join(sets)}, updated_at = now()
         WHERE id = ${courseId}::uuid
           AND EXISTS (SELECT 1 FROM course_teachers WHERE course_id = ${courseId}::uuid AND user_id = ${actorId}::uuid AND role = 'OWNER')`;
      if (updated === 0) throw new ApiException('FORBIDDEN');
    });
    return this.detail(courseId, 'OWNER');
  }

  /** Replaces the course's tags (Owner only) through the Catalog module's normalization (cap 10, concurrent-safe). */
  async setTags(
    actorId: string,
    courseId: string,
    names: string[],
  ): Promise<TagRefDto[]> {
    return this.transactions.run(async (tx) => {
      await assertCourseMutable(tx, courseId);
      await this.requireOwner(tx, courseId, actorId);
      const tags = await this.tags.setCourseTags(tx, courseId, names);
      return tags.map((t) => ({ id: t.id, name: t.name, slug: t.slug }));
    });
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * DRAFT -> PUBLISHED. Needs a category, a summary and at least one PUBLISHED lesson (409 `INVALID_STATE_TRANSITION` with what is missing).
   * The first publication sets `first_published_at` and creates the general channel with its members; a second publish (or a concurrent
   * one) finds the course already published.
   */
  async publish(actorId: string, courseId: string): Promise<CourseDetailDto> {
    await this.transactions.run(async (tx) => {
      const course = await this.lockForTransition(tx, courseId, actorId);
      if (course.status !== 'DRAFT')
        throw new ApiException('INVALID_STATE_TRANSITION', {
          message:
            course.status === 'ARCHIVED'
              ? 'An archived course is restored, not published'
              : 'The course is already published',
        });
      const missing: string[] = [];
      if (!course.summary) missing.push('a summary');
      if (!course.category_id) missing.push('a category');
      const lessons = await tx.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM lessons WHERE course_id = ${courseId}::uuid AND status = 'PUBLISHED' LIMIT 1`;
      if (lessons.length === 0) missing.push('at least one published lesson');
      if (missing.length > 0)
        throw new ApiException('INVALID_STATE_TRANSITION', {
          message: `To publish the course it needs ${missing.join(', ')}`,
        });
      await tx.$executeRaw`
        UPDATE courses SET status = 'PUBLISHED', first_published_at = COALESCE(first_published_at, now()), archived_at = NULL, updated_at = now()
         WHERE id = ${courseId}::uuid AND status = 'DRAFT'`;
      await this.channels.createForCourse(tx, courseId);
      await this.record(tx, actorId, 'COURSE_PUBLISHED', courseId);
    });
    return this.detail(courseId, 'OWNER');
  }

  /** PUBLISHED -> ARCHIVED. No new enrollments; students keep their data; pending requests are left as they are. */
  async archive(actorId: string, courseId: string): Promise<CourseDetailDto> {
    await this.transactions.run(async (tx) => {
      const course = await this.lockForTransition(tx, courseId, actorId);
      if (course.status !== 'PUBLISHED')
        throw new ApiException('INVALID_STATE_TRANSITION', {
          message: `A ${course.status} course cannot be archived`,
        });
      await tx.$executeRaw`
        UPDATE courses SET status = 'ARCHIVED', archived_at = now(), updated_at = now() WHERE id = ${courseId}::uuid AND status = 'PUBLISHED'`;
      await this.record(tx, actorId, 'COURSE_ARCHIVED', courseId);
    });
    return this.detail(courseId, 'OWNER');
  }

  /** ARCHIVED -> PUBLISHED. A course an Admin locked is 409 `COURSE_ADMIN_LOCKED`: only an Admin can restore it (Decision 134). */
  async restore(actorId: string, courseId: string): Promise<CourseDetailDto> {
    await this.transactions.run(async (tx) => {
      const course = await this.lockForTransition(tx, courseId, actorId);
      if (course.status !== 'ARCHIVED')
        throw new ApiException('INVALID_STATE_TRANSITION', {
          message: `A ${course.status} course cannot be restored`,
        });
      await tx.$executeRaw`
        UPDATE courses SET status = 'PUBLISHED', archived_at = NULL, updated_at = now() WHERE id = ${courseId}::uuid AND status = 'ARCHIVED'`;
      await this.record(tx, actorId, 'COURSE_RESTORED', courseId);
    });
    return this.detail(courseId, 'OWNER');
  }

  /**
   * Permanent deletion, only for a course that was NEVER published (Decision 88; Decision 15 stays as the second safety net through the
   * RESTRICT foreign keys, which answer a loud 409). Lessons first, then sections, then the course, in one transaction under Course-X.
   */
  async delete(actorId: string, courseId: string): Promise<void> {
    await this.transactions.run(async (tx) => {
      const course = await this.lockForTransition(tx, courseId, actorId);
      if (course.first_published_at !== null)
        throw new ApiException('INVALID_STATE_TRANSITION', {
          message:
            'A course that was published can only be archived, never deleted',
        });
      await this.record(tx, actorId, 'COURSE_DELETED', courseId, {
        title: course.title,
      });
      await tx.$executeRaw`DELETE FROM lessons WHERE course_id = ${courseId}::uuid`;
      await tx.$executeRaw`DELETE FROM sections WHERE course_id = ${courseId}::uuid`;
      await tx.$executeRaw`DELETE FROM courses WHERE id = ${courseId}::uuid`;
    });
  }

  // ------------------------------------------------------------------ reads

  /** The course page. Who may see it was decided by the guard (404/403); `relationship` is what the caller is to the course. */
  async detail(
    courseId: string,
    relationship: CourseRelationship,
  ): Promise<CourseDetailDto> {
    const row = await readCourse(this.prisma, courseId);
    if (!row) throw new ApiException('NOT_FOUND');
    const teacher = relationship === 'OWNER' || relationship === 'ASSISTANT';
    const detail: CourseDetailDto = Object.assign(toCard(row, this.url), {
      description: row.description,
      status: row.status,
      archivedAt: row.archived_at,
      viewer: { relationship },
      createdAt: row.created_at,
    });
    if (teacher) detail.lockedByAdmin = row.locked_by_admin_at !== null;
    return detail;
  }

  async teachers(courseId: string): Promise<CourseTeacherDto[]> {
    const rows = await this.prisma.$queryRaw<
      {
        user_id: string;
        full_name: string;
        role: 'OWNER' | 'ASSISTANT';
        storage_key: string | null;
      }[]
    >`
      SELECT t.user_id, u.full_name, t.role, f.storage_key
        FROM course_teachers t JOIN users u ON u.id = t.user_id LEFT JOIN file_assets f ON f.id = u.avatar_file_id
       WHERE t.course_id = ${courseId}::uuid
       ORDER BY (t.role = 'OWNER') DESC, t.created_at, t.user_id`;
    return rows.map((r) => ({
      id: r.user_id,
      fullName: r.full_name,
      avatarUrl: this.url(r.storage_key),
      role: r.role,
    }));
  }

  syllabus(courseId: string) {
    return this.outline.syllabus(courseId);
  }

  /**
   * The public catalog (Decision 63): PUBLISHED courses with an OPEN or APPROVAL_REQUIRED policy that are not locked by an Admin;
   * INVITATION_ONLY courses never appear. Full-text search uses the `simple` configuration (no stemming, so Armenian, Russian and English
   * work the same), matches every word and treats the last one as a prefix. Filters: category, tag slug, policy. Sort and paging are whitelisted.
   */
  async catalog(query: CatalogQueryDto): Promise<CatalogPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const tsquery = query.q ? toPrefixTsQuery(query.q) : null;
    if (query.q && !tsquery) return { items: [], page, pageSize, total: 0 };
    const sort = query.sort ?? (tsquery ? 'relevance' : 'newest');
    const order =
      sort === 'title'
        ? Prisma.sql`c.title ASC, c.id`
        : sort === 'relevance' && tsquery
          ? Prisma.sql`ts_rank(c.search_vector, to_tsquery('simple', ${tsquery})) DESC, c.first_published_at DESC, c.id`
          : Prisma.sql`c.first_published_at DESC, c.id`;
    const rows = await this.prisma.$queryRaw<(CourseRow & { total: number })[]>`
      SELECT ${COURSE_SELECT}, count(*) OVER ()::int AS total ${COURSE_FROM}
       WHERE c.status = 'PUBLISHED' AND c.enrollment_policy IN ('OPEN', 'APPROVAL_REQUIRED') AND c.locked_by_admin_at IS NULL
         AND (${tsquery}::text IS NULL OR c.search_vector @@ to_tsquery('simple', ${tsquery}))
         AND (${query.categoryId ?? null}::uuid IS NULL OR c.category_id = ${query.categoryId ?? null}::uuid)
         AND (${query.enrollmentPolicy ?? null}::text IS NULL OR c.enrollment_policy::text = ${query.enrollmentPolicy ?? null}::text)
         AND (${query.tag ?? null}::text IS NULL OR EXISTS (
               SELECT 1 FROM course_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.course_id = c.id AND t.slug = ${query.tag ?? null}::text))
       ORDER BY ${order}
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    return {
      items: rows.map((r) => toCard(r, this.url)),
      page,
      pageSize,
      total: rows[0]?.total ?? 0,
    };
  }

  /** The courses I teach (as Owner or Assistant), in any status, newest first. */
  async teaching(
    userId: string,
    window: { page: number; pageSize: number; offset: number },
  ): Promise<TeachingCoursesPageDto> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        title: string;
        status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
        role: 'OWNER' | 'ASSISTANT';
        enrollment_policy: 'OPEN' | 'APPROVAL_REQUIRED' | 'INVITATION_ONLY';
        cover_key: string | null;
        locked_by_admin_at: Date | null;
        first_published_at: Date | null;
        total: number;
      }[]
    >`
      SELECT c.id, c.title, c.status, t.role, c.enrollment_policy, f.storage_key AS cover_key, c.locked_by_admin_at, c.first_published_at,
             count(*) OVER ()::int AS total
        FROM course_teachers t JOIN courses c ON c.id = t.course_id LEFT JOIN file_assets f ON f.id = c.cover_file_id
       WHERE t.user_id = ${userId}::uuid
       ORDER BY c.created_at DESC, c.id
       LIMIT ${window.pageSize} OFFSET ${window.offset}`;
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        role: r.role,
        enrollmentPolicy: r.enrollment_policy,
        coverUrl: this.url(r.cover_key),
        lockedByAdmin: r.locked_by_admin_at !== null,
        firstPublishedAt: r.first_published_at,
      })),
      page: window.page,
      pageSize: window.pageSize,
      total: rows[0]?.total ?? 0,
    };
  }

  // ------------------------------------------------------------------ helpers

  /** Course-X, then the state: not locked by an Admin (409 `COURSE_ADMIN_LOCKED`) and the actor is STILL the Owner (403). */
  private async lockForTransition(
    tx: Tx,
    courseId: string,
    actorId: string,
  ): Promise<CourseRow> {
    if (!(await lockRow(tx, 'course', courseId, 'NO_KEY_UPDATE')))
      throw new ApiException('NOT_FOUND');
    const course = await readCourse(tx, courseId);
    if (!course) throw new ApiException('NOT_FOUND');
    await this.requireOwner(tx, courseId, actorId);
    if (course.locked_by_admin_at !== null)
      throw new ApiException('COURSE_ADMIN_LOCKED', { status: 409 });
    return course;
  }

  private async requireOwner(
    tx: Tx,
    courseId: string,
    userId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM course_teachers WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid AND role = 'OWNER'`;
    if (rows.length === 0) throw new ApiException('FORBIDDEN');
  }

  private async requireCategory(tx: Tx, categoryId: string): Promise<void> {
    const rows = await tx.$queryRaw<
      { one: number }[]
    >`SELECT 1 AS one FROM categories WHERE id = ${categoryId}::uuid`;
    if (rows.length === 0) throw fail('categoryId', 'Unknown category');
  }

  private record(
    tx: Tx,
    actorId: string,
    action:
      | 'COURSE_PUBLISHED'
      | 'COURSE_ARCHIVED'
      | 'COURSE_RESTORED'
      | 'COURSE_DELETED',
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
}
