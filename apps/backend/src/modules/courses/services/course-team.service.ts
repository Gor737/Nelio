import { Injectable } from '@nestjs/common';
import { ApiException } from '../../../common/filters/index.js';
import { AuditWriter } from '../../../infrastructure/audit/index.js';
import {
  PrismaService,
  TransactionService,
  type Tx,
  lockRow,
} from '../../../infrastructure/database/index.js';
import { emitAfterCommit } from '../../../infrastructure/events/index.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { CourseChannelService } from '../../chat/index.js';

type Db = Pick<PrismaClient, '$queryRaw'>;

const conflict = (message: string) =>
  new ApiException('RESOURCE_CONFLICT', { message });

/**
 * The teaching team of a course: Assistants, ownership transfer, and `ownsCourses` (Decisions 6, 10, 14, 37, 45, 61, 72).
 *
 * Team operations work in ANY course status (also archived and Admin-locked): the people responsible for a course must be changeable
 * exactly when it is in trouble. Lock order is User (ascending), then the Course row exclusively. The Owner is re-read after the lock.
 * "Exactly one Owner" is the partial unique index plus demote-first: the old Owner becomes an Assistant BEFORE the new Owner is promoted.
 * A person cannot be a teacher and an ACTIVE or PENDING student of the same course (Decision 72), and only an ACTIVE Teacher can join the team.
 *
 * The `*InTx` methods are the primitives Admin composes in its own transaction (an Admin transfers on behalf of an unreachable Owner:
 * `actorIsOwner: false`); the plain methods open the transaction for the Owner's own endpoints.
 */
@Injectable()
export class CourseTeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly channels: CourseChannelService,
    private readonly audit: AuditWriter,
  ) {}

  /** Does the user own any course, in any status? (Revoking the Teacher role or suspending an Owner needs the answer to be no: Decisions 10, 45.) */
  async ownsCourses(userId: string, db: Db = this.prisma): Promise<boolean> {
    const rows = await db.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM course_teachers WHERE user_id = ${userId}::uuid AND role = 'OWNER' LIMIT 1`;
    return rows.length > 0;
  }

  addAssistant(
    actorId: string,
    courseId: string,
    assistantId: string,
  ): Promise<void> {
    return this.transactions.run((tx) =>
      this.addAssistantInTx(tx, {
        courseId,
        assistantId,
        actorId,
        actorIsOwner: true,
      }),
    );
  }

  async addAssistantInTx(
    tx: Tx,
    input: {
      courseId: string;
      assistantId: string;
      actorId: string;
      actorIsOwner: boolean;
    },
  ): Promise<void> {
    const { courseId, assistantId, actorId } = input;
    if (!(await lockRow(tx, 'user', assistantId, 'SHARE')))
      throw new ApiException('NOT_FOUND');
    await this.lockCourse(tx, courseId, input.actorIsOwner ? actorId : null);
    await this.requireEligibleTeacher(tx, assistantId);
    await this.requireNotOnCourse(tx, courseId, assistantId);
    await tx.$executeRaw`
      INSERT INTO course_teachers (course_id, user_id, role, added_by)
      VALUES (${courseId}::uuid, ${assistantId}::uuid, 'ASSISTANT', ${actorId}::uuid)`;
    await this.channels.addMember(tx, courseId, assistantId);
    await this.audit.record(tx, {
      actorId,
      action: 'COURSE_ASSISTANT_ADDED',
      targetType: 'COURSE',
      targetId: courseId,
      metadata: { assistantId },
    });
  }

  /** The Owner removes an Assistant. */
  removeAssistant(
    actorId: string,
    courseId: string,
    assistantId: string,
  ): Promise<void> {
    return this.transactions.run((tx) =>
      this.removeAssistantInTx(tx, {
        courseId,
        assistantId,
        actorId,
        actorIsOwner: true,
      }),
    );
  }

  /** An Assistant leaves the team themselves (the Owner cannot: they transfer ownership first). */
  leaveAsAssistant(userId: string, courseId: string): Promise<void> {
    return this.transactions.run((tx) =>
      this.removeAssistantInTx(tx, {
        courseId,
        assistantId: userId,
        actorId: userId,
        actorIsOwner: false,
      }),
    );
  }

  async removeAssistantInTx(
    tx: Tx,
    input: {
      courseId: string;
      assistantId: string;
      actorId: string;
      actorIsOwner: boolean;
    },
  ): Promise<void> {
    const { courseId, assistantId, actorId } = input;
    await this.lockCourse(tx, courseId, input.actorIsOwner ? actorId : null);
    const removed = await tx.$executeRaw`
      DELETE FROM course_teachers WHERE course_id = ${courseId}::uuid AND user_id = ${assistantId}::uuid AND role = 'ASSISTANT'`;
    if (removed === 0) throw new ApiException('NOT_FOUND');
    await this.channels.endMembership(tx, courseId, assistantId);
    await this.audit.record(tx, {
      actorId,
      action: 'COURSE_ASSISTANT_REMOVED',
      targetType: 'COURSE',
      targetId: courseId,
      metadata: { assistantId, left: actorId === assistantId },
    });
  }

  transferOwnership(
    actorId: string,
    courseId: string,
    newOwnerId: string,
  ): Promise<void> {
    return this.transactions.run((tx) =>
      this.transferOwnershipInTx(tx, {
        courseId,
        newOwnerId,
        actorId,
        actorIsOwner: true,
      }),
    );
  }

  /**
   * Makes `newOwnerId` the Owner and the previous Owner an Assistant, in one transaction: User-S on the new Owner, Course-X, the Owner
   * read AFTER the lock, the old Owner demoted first, then the new Owner promoted (or added). The new Owner is told after the commit.
   */
  async transferOwnershipInTx(
    tx: Tx,
    input: {
      courseId: string;
      newOwnerId: string;
      actorId: string;
      actorIsOwner: boolean;
    },
  ): Promise<void> {
    const { courseId, newOwnerId, actorId } = input;
    if (!(await lockRow(tx, 'user', newOwnerId, 'SHARE')))
      throw new ApiException('NOT_FOUND');
    await this.lockCourse(tx, courseId, input.actorIsOwner ? actorId : null);
    const owner = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM course_teachers WHERE course_id = ${courseId}::uuid AND role = 'OWNER'`;
    if (owner.length === 0) throw new ApiException('NOT_FOUND');
    const previousOwnerId = owner[0].user_id;
    if (previousOwnerId === newOwnerId)
      throw conflict('This person is already the Owner');
    await this.requireEligibleTeacher(tx, newOwnerId);
    const existing = await tx.$queryRaw<{ role: string }[]>`
      SELECT role FROM course_teachers WHERE course_id = ${courseId}::uuid AND user_id = ${newOwnerId}::uuid`;
    if (existing.length === 0)
      await this.requireNotStudent(tx, courseId, newOwnerId);
    // demote first, promote second: the partial unique index allows at most one OWNER at any moment
    await tx.$executeRaw`
      UPDATE course_teachers SET role = 'ASSISTANT' WHERE course_id = ${courseId}::uuid AND user_id = ${previousOwnerId}::uuid`;
    if (existing.length > 0) {
      await tx.$executeRaw`
        UPDATE course_teachers SET role = 'OWNER' WHERE course_id = ${courseId}::uuid AND user_id = ${newOwnerId}::uuid`;
    } else {
      await tx.$executeRaw`
        INSERT INTO course_teachers (course_id, user_id, role, added_by) VALUES (${courseId}::uuid, ${newOwnerId}::uuid, 'OWNER', ${actorId}::uuid)`;
      await this.channels.addMember(tx, courseId, newOwnerId);
    }
    await this.audit.record(tx, {
      actorId,
      action: 'COURSE_OWNERSHIP_TRANSFERRED',
      targetType: 'COURSE',
      targetId: courseId,
      metadata: { previousOwnerId, newOwnerId, onBehalf: !input.actorIsOwner },
    });
    emitAfterCommit(tx, 'course.ownership-transferred', {
      courseId,
      previousOwnerId,
      newOwnerId,
    });
  }

  // ------------------------------------------------------------------ rules

  /** Locks the Course row exclusively and, when `ownerId` is given, requires that person to be the Owner NOW (403 otherwise). */
  private async lockCourse(
    tx: Tx,
    courseId: string,
    ownerId: string | null,
  ): Promise<void> {
    if (!(await lockRow(tx, 'course', courseId, 'NO_KEY_UPDATE')))
      throw new ApiException('NOT_FOUND');
    if (ownerId === null) return;
    const rows = await tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM course_teachers WHERE course_id = ${courseId}::uuid AND user_id = ${ownerId}::uuid AND role = 'OWNER'`;
    if (rows.length === 0) throw new ApiException('FORBIDDEN');
  }

  private async requireEligibleTeacher(tx: Tx, userId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM user_roles r JOIN users u ON u.id = r.user_id
       WHERE r.user_id = ${userId}::uuid AND r.role = 'TEACHER' AND r.status = 'ACTIVE' AND u.status = 'ACTIVE'`;
    if (rows.length === 0)
      throw conflict('The person must be an approved Teacher');
  }

  private async requireNotOnCourse(
    tx: Tx,
    courseId: string,
    userId: string,
  ): Promise<void> {
    const teacher = await tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM course_teachers WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid`;
    if (teacher.length > 0)
      throw conflict('This person already teaches the course');
    await this.requireNotStudent(tx, courseId, userId);
  }

  private async requireNotStudent(
    tx: Tx,
    courseId: string,
    userId: string,
  ): Promise<void> {
    const student = await tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM enrollments
       WHERE course_id = ${courseId}::uuid AND user_id = ${userId}::uuid AND status IN ('ACTIVE', 'PENDING')`;
    if (student.length > 0)
      throw conflict('This person is a student of the course');
  }
}
