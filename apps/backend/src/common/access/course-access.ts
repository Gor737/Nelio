import type { CourseRelationship } from '../constants/permission-matrix.js';

export type CourseStatusValue = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type EnrollmentPolicyValue =
  'OPEN' | 'APPROVAL_REQUIRED' | 'INVITATION_ONLY';

/** The columns of a course that decide who may see it (docs/architecture.md section 12). */
export interface CourseSummary {
  readonly id: string;
  readonly status: CourseStatusValue;
  readonly enrollmentPolicy: EnrollmentPolicyValue;
  readonly lockedByAdminAt: Date | null;
}

/** What a user is to a course, together with the course state that visibility depends on. */
export interface CourseAccess {
  readonly course: CourseSummary;
  readonly relationship: CourseRelationship;
}

/**
 * - `VISIBLE`: the caller may know the course exists and see it (what they may DO is decided by the role check and the service).
 * - `NOT_FOUND`: the caller may not know the course exists -> 404.
 * - `LOCKED`: an Admin locked the course and the caller is a student of it -> 403 `COURSE_ADMIN_LOCKED` (Decision 136).
 */
export type CourseVisibility = 'VISIBLE' | 'NOT_FOUND' | 'LOCKED';

/**
 * The 404-versus-403 table of Decisions 119, 121 and 136 as one pure function, so that it can be tested exhaustively.
 *
 *   Owner / Assistant   always visible, in every status, locked or not (they keep management visibility).
 *   Locked course       ACTIVE / LEFT / PENDING student -> LOCKED; everyone else -> NOT_FOUND (anonymous, never enrolled,
 *                       rejected, invitee, removed). Admins use `/admin`, not these routes.
 *   ACTIVE / LEFT       PUBLISHED and ARCHIVED are visible (a LEFT student still sees an INVITATION_ONLY page); DRAFT is not.
 *   PENDING             a PUBLISHED course only; once archived the request stays but the course is no longer visible.
 *   INVITEE             a PUBLISHED course only (an invitation to an archived, locked or draft course is not visible).
 *   REMOVED / REJECTED / NONE   like any visitor: only a PUBLISHED course whose policy is OPEN or APPROVAL_REQUIRED is public.
 *                       A REMOVED student keeps no access merely because they were enrolled (Decision 119).
 */
export function decideVisibility({
  course,
  relationship,
}: CourseAccess): CourseVisibility {
  if (relationship === 'OWNER' || relationship === 'ASSISTANT')
    return 'VISIBLE';

  if (course.lockedByAdminAt !== null) {
    return relationship === 'STUDENT_ACTIVE' ||
      relationship === 'STUDENT_LEFT' ||
      relationship === 'STUDENT_PENDING'
      ? 'LOCKED'
      : 'NOT_FOUND';
  }

  const published = course.status === 'PUBLISHED';
  switch (relationship) {
    case 'STUDENT_ACTIVE':
    case 'STUDENT_LEFT':
      return course.status === 'DRAFT' ? 'NOT_FOUND' : 'VISIBLE';
    case 'STUDENT_PENDING':
    case 'INVITEE':
      return published ? 'VISIBLE' : 'NOT_FOUND';
    case 'REMOVED':
    case 'REJECTED':
    case 'NONE':
      return published && course.enrollmentPolicy !== 'INVITATION_ONLY'
        ? 'VISIBLE'
        : 'NOT_FOUND';
  }
}
