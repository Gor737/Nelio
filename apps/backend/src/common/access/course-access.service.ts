import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/index.js';
import type { CourseRelationship } from '../constants/permission-matrix.js';
import { ApiException } from '../filters/api-exception.js';
import {
  type CourseAccess,
  type CourseStatusValue,
  type EnrollmentPolicyValue,
  decideVisibility,
} from './course-access.js';

/** Anything that can run a raw query: the `PrismaService` and a transaction client both fit. */
export type CourseAccessDb = Pick<PrismaClient, '$queryRaw'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  id: string;
  status: CourseStatusValue;
  policy: EnrollmentPolicyValue;
  locked_by_admin_at: Date | null;
  teacher_role: 'OWNER' | 'ASSISTANT' | null;
  enrollment_status:
    'PENDING' | 'ACTIVE' | 'LEFT' | 'REJECTED' | 'REMOVED' | null;
  invitation_status: string | null;
  invitation_expires_at: Date | null;
}

/**
 * What a user is to a course (docs/architecture.md section 12, level 2). It reads `Course`, `CourseTeacher`, `Enrollment` and
 * `Invitation` and imports no domain module, so every module can use it. It answers "who" and "may they know it exists"; whether
 * an action is allowed in the course's current state is decided by the owning service inside its transaction (level 3).
 *
 * One statement does the lookup (the course plus, by their unique keys, the caller's teacher, enrollment and invitation rows), so it
 * costs one round trip and is safe on a transaction connection, which must not run statements concurrently.
 *
 * Precedence of the relationship: a teacher row (OWNER / ASSISTANT; a teacher cannot also be a student of the course), then the
 * enrollment status, then a valid invitation, otherwise NONE. A REMOVED or REJECTED student who holds a valid pending invitation
 * is an INVITEE: the invitation is their way back (Decision 119 and the enrollment state machine).
 */
@Injectable()
export class CourseAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's access to the course, or null when the course does not exist (or the id is not a UUID). `userId` null = anonymous. */
  async resolve(
    userId: string | null,
    courseId: string,
    db: CourseAccessDb = this.prisma,
    now: Date = new Date(),
  ): Promise<CourseAccess | null> {
    if (!UUID.test(courseId)) return null;
    if (userId !== null && !UUID.test(userId)) return null;

    // For an anonymous caller the user id is NULL, and a join on `= NULL` matches nothing.
    const rows = await db.$queryRaw<Row[]>`
      SELECT c.id, c.status::text AS status, c.enrollment_policy::text AS policy, c.locked_by_admin_at,
             t.role::text AS teacher_role, e.status::text AS enrollment_status,
             i.status::text AS invitation_status, i.expires_at AS invitation_expires_at
        FROM courses c
        LEFT JOIN course_teachers t ON t.course_id = c.id AND t.user_id = ${userId}::uuid
        LEFT JOIN enrollments e ON e.course_id = c.id AND e.user_id = ${userId}::uuid
        LEFT JOIN invitations i ON i.course_id = c.id AND i.invited_user_id = ${userId}::uuid
       WHERE c.id = ${courseId}::uuid`;
    const row = rows[0];
    if (!row) return null;

    const validInvitation =
      row.invitation_status === 'PENDING' &&
      row.invitation_expires_at !== null &&
      row.invitation_expires_at.getTime() > now.getTime();
    return {
      course: {
        id: row.id,
        status: row.status,
        enrollmentPolicy: row.policy,
        lockedByAdminAt: row.locked_by_admin_at,
      },
      relationship: relationshipOf(
        row.teacher_role ?? undefined,
        row.enrollment_status ?? undefined,
        validInvitation,
      ),
    };
  }

  /**
   * Applies visibility: a course the caller may not know about is a 404, and a course locked by an Admin is a 403
   * `COURSE_ADMIN_LOCKED` for its students. `null` (course missing) is a 404 too, so existence is never revealed.
   */
  assertVisible(access: CourseAccess | null): CourseAccess {
    if (access === null) throw new ApiException('NOT_FOUND');
    const visibility = decideVisibility(access);
    if (visibility === 'NOT_FOUND') throw new ApiException('NOT_FOUND');
    if (visibility === 'LOCKED')
      throw new ApiException('COURSE_ADMIN_LOCKED', { status: 403 });
    return access;
  }

  /** `resolve` + `assertVisible`: the one call a service makes when it needs "this course, as this user may see it". */
  async requireVisible(
    userId: string | null,
    courseId: string,
    db?: CourseAccessDb,
  ): Promise<CourseAccess> {
    return this.assertVisible(await this.resolve(userId, courseId, db));
  }
}

export function relationshipOf(
  teacherRole: 'OWNER' | 'ASSISTANT' | undefined,
  enrollmentStatus:
    'PENDING' | 'ACTIVE' | 'LEFT' | 'REJECTED' | 'REMOVED' | undefined,
  validInvitation: boolean,
): CourseRelationship {
  if (teacherRole) return teacherRole;
  switch (enrollmentStatus) {
    case 'ACTIVE':
      return 'STUDENT_ACTIVE';
    case 'PENDING':
      return 'STUDENT_PENDING';
    case 'LEFT':
      return 'STUDENT_LEFT';
    case 'REMOVED':
      return validInvitation ? 'INVITEE' : 'REMOVED';
    case 'REJECTED':
      return validInvitation ? 'INVITEE' : 'REJECTED';
    case undefined:
      return validInvitation ? 'INVITEE' : 'NONE';
  }
}
