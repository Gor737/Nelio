// Factories for schema group G4 (enrollments, invitations, lesson completions): direct INSERTs through the pool.
import type { Queryable } from './database.js';

export type EnrollmentStatusName =
  'PENDING' | 'ACTIVE' | 'LEFT' | 'REJECTED' | 'REMOVED';

export interface EnrollmentOverrides {
  status?: EnrollmentStatusName;
  decidedBy?: string | null;
  decidedAt?: Date | null;
  firstActivatedAt?: Date | null;
  leftAt?: Date | null;
  lastVisitedLessonId?: string | null;
  lastVisitedAt?: Date | null;
  completedAt?: Date | null;
}

/** An enrollment of `userId` in `courseId`. Defaults to ACTIVE with first_activated_at set (a valid state). */
export async function createEnrollment(
  q: Queryable,
  courseId: string,
  userId: string,
  overrides: EnrollmentOverrides = {},
): Promise<string> {
  const status = overrides.status ?? 'ACTIVE';
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO enrollments (course_id, user_id, status, decided_by, decided_at, first_activated_at, left_at,
                              last_visited_lesson_id, last_visited_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      courseId,
      userId,
      status,
      overrides.decidedBy ?? null,
      overrides.decidedAt ?? null,
      'firstActivatedAt' in overrides
        ? overrides.firstActivatedAt
        : status === 'ACTIVE'
          ? new Date()
          : null,
      overrides.leftAt ?? null,
      overrides.lastVisitedLessonId ?? null,
      overrides.lastVisitedAt ?? null,
      overrides.completedAt ?? null,
    ],
  );
  return rows[0].id;
}

export async function createInvitation(
  q: Queryable,
  courseId: string,
  invitedUserId: string,
  invitedBy: string,
  overrides: {
    status?: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED';
    expiresAt?: Date;
  } = {},
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO invitations (course_id, invited_user_id, invited_by, status, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      courseId,
      invitedUserId,
      invitedBy,
      overrides.status ?? 'PENDING',
      overrides.expiresAt ?? new Date(Date.now() + 7 * 24 * 3600 * 1000),
    ],
  );
  return rows[0].id;
}

/** A completion row with exactly the given ids; `courseId` is explicit so cross-course rows can be tried. */
export async function createCompletion(
  q: Queryable,
  enrollmentId: string,
  lessonId: string,
  courseId: string,
): Promise<void> {
  await q.query(
    'INSERT INTO lesson_completions (enrollment_id, lesson_id, course_id) VALUES ($1, $2, $3)',
    [enrollmentId, lessonId, courseId],
  );
}
