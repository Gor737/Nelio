import { Injectable } from '@nestjs/common';
import { ApiException } from '../../../common/filters/index.js';
import { AuditWriter } from '../../../infrastructure/audit/index.js';
import { type Tx, lockRow } from '../../../infrastructure/database/index.js';
import { emitAfterCommit } from '../../../infrastructure/events/index.js';
import { CourseChannelService } from '../../chat/index.js';
import { CompletionService } from '../../progress/index.js';
import {
  ADDS_ACCESS,
  type EnrollmentAction,
  type EnrollmentStatusName,
  type PolicyName,
  nextEnrollmentStatus,
} from './enrollment-transitions.js';

export interface CourseContext {
  readonly status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  readonly policy: PolicyName;
  readonly locked: boolean;
}

export interface EnrollmentRow {
  id: string;
  status: EnrollmentStatusName;
}

export interface AppliedTransition {
  readonly enrollmentId: string;
  readonly from: EnrollmentStatusName | null;
  readonly to: EnrollmentStatusName;
}

/**
 * Carries out ONE enrollment transition (Decisions 8, 27, 70, 123, 142; architecture section 15). The order is always:
 * Course-S (FOR SHARE) -> the student's Enrollment row (FOR NO KEY UPDATE) -> the change -> channel membership -> completion recheck,
 * in the caller's transaction. Course-S is shared by every student action and excluded by every Course-X (publish, archive, add Assistant,
 * unpublish a lesson), which is what makes "add Assistant versus enroll" a race with exactly one winner and keeps a completion from getting
 * stuck. The Enrollment row is the per-student mutex.
 */
@Injectable()
export class EnrollmentMachine {
  constructor(
    private readonly channels: CourseChannelService,
    private readonly completion: CompletionService,
    private readonly audit: AuditWriter,
  ) {}

  /** Course-S, then the state of the course AFTER the lock. 404 for a course that does not exist. */
  async lockCourse(tx: Tx, courseId: string): Promise<CourseContext> {
    if (!(await lockRow(tx, 'course', courseId, 'SHARE')))
      throw new ApiException('NOT_FOUND');
    const rows = await tx.$queryRaw<
      {
        status: CourseContext['status'];
        enrollment_policy: PolicyName;
        locked_by_admin_at: Date | null;
      }[]
    >`SELECT status, enrollment_policy, locked_by_admin_at FROM courses WHERE id = ${courseId}::uuid`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    return {
      status: rows[0].status,
      policy: rows[0].enrollment_policy,
      locked: rows[0].locked_by_admin_at !== null,
    };
  }

  async apply(
    tx: Tx,
    course: CourseContext,
    input: {
      courseId: string;
      userId: string;
      action: EnrollmentAction;
      actorId?: string;
    },
    attempt = 0,
  ): Promise<AppliedTransition> {
    const { courseId, userId, action, actorId } = input;
    if (ADDS_ACCESS.has(action)) this.assertJoinable(course);
    if (
      action === 'ENROLL' ||
      action === 'ACCEPT_INVITATION' ||
      action === 'REINSTATE'
    )
      await this.assertNotTeacher(tx, courseId, userId);

    const rows = await tx.$queryRaw<EnrollmentRow[]>`
      SELECT id, status FROM enrollments WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid FOR NO KEY UPDATE`;
    const row = rows[0] ?? null;
    const from = row?.status ?? null;
    const result = nextEnrollmentStatus(from, action, course.policy);
    if (!result.ok) throw new ApiException(result.code);
    const target = result.to;
    let enrollmentId: string;

    if (row === null) {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO enrollments (course_id, user_id, status, first_activated_at)
        VALUES (${courseId}::uuid, ${userId}::uuid, ${target}::enrollment_status, ${target === 'ACTIVE' ? new Date() : null})
        ON CONFLICT (course_id, user_id) DO NOTHING RETURNING id`;
      // a parallel request created the row between our read and our insert: read again under its lock and decide again (once)
      if (inserted.length === 0 && attempt === 0)
        return this.apply(tx, course, input, 1);
      if (inserted.length === 0) throw new ApiException('RESOURCE_CONFLICT');
      enrollmentId = inserted[0].id;
    } else {
      enrollmentId = row.id;
      const decided =
        actorId !== undefined &&
        (action === 'APPROVE' ||
          action === 'REJECT' ||
          action === 'REMOVE' ||
          action === 'REINSTATE');
      const changed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE enrollments SET
               status = ${target}::enrollment_status,
               first_activated_at = CASE WHEN ${target} = 'ACTIVE' THEN COALESCE(first_activated_at, now()) ELSE first_activated_at END,
               left_at = CASE WHEN ${target} = 'LEFT' THEN now() WHEN ${target} = 'ACTIVE' THEN NULL ELSE left_at END,
               decided_by = CASE WHEN ${decided} THEN ${actorId ?? null}::uuid ELSE decided_by END,
               decided_at = CASE WHEN ${decided} THEN now() ELSE decided_at END,
               updated_at = now()
         WHERE id = ${enrollmentId}::uuid AND status = ${from as string}::enrollment_status
        RETURNING id`;
      if (changed.length === 0)
        throw new ApiException('INVALID_STATE_TRANSITION');
    }

    // every entry into ACTIVE: channel membership upsert, then the completion recheck (a lesson may have been archived while away)
    if (target === 'ACTIVE') {
      await this.channels.addMember(tx, courseId, userId);
      await this.completion.recheckEnrollment(tx, enrollmentId);
    } else if (from === 'ACTIVE') {
      await this.channels.endMembership(tx, courseId, userId);
    }
    await this.announce(tx, {
      courseId,
      userId,
      action,
      actorId,
      from,
      target,
    });
    return { enrollmentId, from, to: target };
  }

  /** Enrolling, approving, reinstating and accepting add access: not on an archived or Admin-locked course (409), not on a draft. */
  assertJoinable(course: CourseContext): void {
    if (course.locked)
      throw new ApiException('COURSE_ADMIN_LOCKED', { status: 409 });
    if (course.status === 'ARCHIVED') throw new ApiException('COURSE_ARCHIVED');
    if (course.status !== 'PUBLISHED')
      throw new ApiException('INVALID_STATE_TRANSITION', {
        message: 'The course is not published',
      });
  }

  /** Decision 72: a teacher of the course cannot also be its student. Read under Course-S, so it is exclusive with adding an Assistant. */
  private async assertNotTeacher(
    tx: Tx,
    courseId: string,
    userId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM course_teachers WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid`;
    if (rows.length > 0)
      throw new ApiException('RESOURCE_CONFLICT', {
        message: 'A teacher of this course cannot also be its student',
      });
  }

  private async announce(
    tx: Tx,
    e: {
      courseId: string;
      userId: string;
      action: EnrollmentAction;
      actorId?: string;
      from: EnrollmentStatusName | null;
      target: EnrollmentStatusName;
    },
  ): Promise<void> {
    const { courseId, userId, actorId } = e;
    if (e.action === 'ENROLL' && e.target === 'PENDING')
      emitAfterCommit(tx, 'enrollment.requested', {
        courseId,
        studentId: userId,
      });
    if ((e.action === 'APPROVE' || e.action === 'REINSTATE') && actorId)
      emitAfterCommit(tx, 'enrollment.approved', {
        courseId,
        studentId: userId,
        decidedBy: actorId,
        reinstated: e.action === 'REINSTATE',
      });
    if (e.action === 'REJECT' && actorId)
      emitAfterCommit(tx, 'enrollment.rejected', {
        courseId,
        studentId: userId,
        decidedBy: actorId,
      });
    if (e.action === 'REMOVE' && actorId) {
      emitAfterCommit(tx, 'enrollment.removed', {
        courseId,
        studentId: userId,
        removedBy: actorId,
      });
      await this.audit.record(tx, {
        actorId,
        action: 'STUDENT_REMOVED',
        targetType: 'COURSE',
        targetId: courseId,
        metadata: { studentId: userId },
      });
    }
    if (e.action === 'REINSTATE' && actorId)
      await this.audit.record(tx, {
        actorId,
        action: 'STUDENT_REINSTATED',
        targetType: 'COURSE',
        targetId: courseId,
        metadata: { studentId: userId },
      });
  }
}
