// Factories for schema group G2 (catalog, courses, notifications): direct INSERTs through the pool, no ORM and no service code,
// so a test can build any state, including states the application would refuse.
import type { Queryable } from './database.js';
import { unique } from './factories.js';

export async function createCategory(
  q: Queryable,
  overrides: { name?: string; slug?: string } = {},
): Promise<string> {
  const n = unique();
  const { rows } = await q.query<{ id: string }>(
    'INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id',
    [overrides.name ?? `Category ${n}`, overrides.slug ?? `category-${n}`],
  );
  return rows[0].id;
}

export async function createTag(
  q: Queryable,
  overrides: { name?: string; slug?: string } = {},
): Promise<string> {
  const n = unique();
  const { rows } = await q.query<{ id: string }>(
    'INSERT INTO tags (name, slug) VALUES ($1, $2) RETURNING id',
    [overrides.name ?? `Tag ${n}`, overrides.slug ?? `tag-${n}`],
  );
  return rows[0].id;
}

export type CourseStatusName = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type EnrollmentPolicyName =
  'OPEN' | 'APPROVAL_REQUIRED' | 'INVITATION_ONLY';

export interface CourseOverrides {
  title?: string;
  summary?: string | null;
  description?: string | null;
  status?: CourseStatusName;
  enrollmentPolicy?: EnrollmentPolicyName;
  categoryId?: string | null;
  coverFileId?: string | null;
  firstPublishedAt?: Date | null;
  archivedAt?: Date | null;
  lockedByAdminAt?: Date | null;
}

/** A bare course row, no teachers. Defaults to a valid DRAFT. Pass fields to build any state, valid or not. */
export async function createCourse(
  q: Queryable,
  overrides: CourseOverrides = {},
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO courses (title, summary, description, status, enrollment_policy, category_id, cover_file_id,
                          first_published_at, archived_at, locked_by_admin_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      overrides.title ?? `Course ${unique()}`,
      overrides.summary ?? null,
      overrides.description ?? null,
      overrides.status ?? 'DRAFT',
      overrides.enrollmentPolicy ?? 'OPEN',
      overrides.categoryId ?? null,
      overrides.coverFileId ?? null,
      overrides.firstPublishedAt ?? null,
      overrides.archivedAt ?? null,
      overrides.lockedByAdminAt ?? null,
    ],
  );
  return rows[0].id;
}

/** A PUBLISHED course with a category and a summary, the minimum the CHECKs allow. */
export async function createPublishedCourse(
  q: Queryable,
  overrides: CourseOverrides = {},
): Promise<string> {
  return createCourse(q, {
    status: 'PUBLISHED',
    summary: 'A summary that is long enough',
    categoryId: overrides.categoryId ?? (await createCategory(q)),
    firstPublishedAt: new Date(),
    ...overrides,
  });
}

export async function addCourseTeacher(
  q: Queryable,
  courseId: string,
  userId: string,
  role: 'OWNER' | 'ASSISTANT',
  addedBy: string = userId,
): Promise<void> {
  await q.query(
    'INSERT INTO course_teachers (course_id, user_id, role, added_by) VALUES ($1, $2, $3, $4)',
    [courseId, userId, role, addedBy],
  );
}

export async function createNotification(
  q: Queryable,
  userId: string,
  overrides: {
    type?: string;
    courseId?: string | null;
    actorId?: string | null;
    readAt?: Date | null;
    data?: unknown;
  } = {},
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO notifications (user_id, type, course_id, actor_id, read_at, data)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [
      userId,
      overrides.type ?? 'ENROLLMENT_REQUESTED',
      overrides.courseId ?? null,
      overrides.actorId ?? null,
      overrides.readAt ?? null,
      JSON.stringify(overrides.data ?? {}),
    ],
  );
  return rows[0].id;
}
