import { Injectable } from '@nestjs/common';
import { ApiException } from '../../../common/filters/index.js';
import { AuditWriter } from '../../../infrastructure/audit/index.js';
import {
  PrismaService,
  TransactionService,
  isUniqueViolation,
} from '../../../infrastructure/database/index.js';
import { emitAfterCommit } from '../../../infrastructure/events/index.js';
import type {
  ApplicationStatusName,
  TeacherApplicationDto,
} from '../dto/users.dto.js';

interface RoleRow {
  status: Exclude<ApplicationStatusName, 'NONE'>;
  application_message: string | null;
  decision_note: string | null;
  decided_at: Date | null;
}

/**
 * The caller's own Teacher application (Decisions 5, 54, 60, 128). The application is the `TEACHER` row of `user_roles`:
 * `PENDING` while it waits, `ACTIVE` once approved, `REJECTED` or `REVOKED` when an Admin decided against it (both may apply again).
 * Deciding is the Admin's job (M12) through the primitives of `UserAccountService`.
 */
@Injectable()
export class TeacherApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly audit: AuditWriter,
  ) {}

  async get(userId: string): Promise<TeacherApplicationDto> {
    const rows = await this.prisma.$queryRaw<RoleRow[]>`
      SELECT status, application_message, decision_note, decided_at
        FROM user_roles WHERE user_id = ${userId}::uuid AND role = 'TEACHER'`;
    const row = rows[0];
    if (!row)
      return {
        status: 'NONE',
        message: null,
        decisionNote: null,
        decidedAt: null,
      };
    return {
      status: row.status,
      message: row.application_message,
      decisionNote: row.decision_note,
      decidedAt: row.decided_at,
    };
  }

  /**
   * Applies, or applies again after a rejection or revocation.
   * - never applied: a new `PENDING` row (a parallel double submit loses on the primary key and is answered as "already pending");
   * - `REJECTED` / `REVOKED`: one conditional update back to `PENDING`, the decision (note, decided pair) cleared, and the overwritten
   *   message, status and note written to the audit log (Decision 128);
   * - `PENDING`: 409 `APPLICATION_PENDING`; `ACTIVE` (also for an Admin who is a Teacher): 409 `ALREADY_TEACHER`.
   * The Admins are notified after commit.
   */
  async apply(userId: string, message: string): Promise<TeacherApplicationDto> {
    try {
      await this.transactions.run(async (tx) => {
        const inserted = await tx.$executeRaw`
          INSERT INTO user_roles (user_id, role, status, application_message)
          VALUES (${userId}::uuid, 'TEACHER', 'PENDING', ${message})
          ON CONFLICT (user_id, role) DO NOTHING`;
        if (inserted === 1) {
          emitAfterCommit(tx, 'teacher-application.received', {
            applicantId: userId,
          });
          return;
        }
        const replaced = await tx.$queryRaw<
          {
            old_status: string;
            old_message: string | null;
            old_note: string | null;
          }[]
        >`
          WITH old AS (
            SELECT status AS old_status, application_message AS old_message, decision_note AS old_note
              FROM user_roles
             WHERE user_id = ${userId}::uuid AND role = 'TEACHER' AND status IN ('REJECTED', 'REVOKED')
               FOR UPDATE)
          UPDATE user_roles r
             SET status = 'PENDING', application_message = ${message}, decision_note = NULL,
                 decided_by = NULL, decided_at = NULL, updated_at = now()
            FROM old
           WHERE r.user_id = ${userId}::uuid AND r.role = 'TEACHER' AND r.status IN ('REJECTED', 'REVOKED')
          RETURNING old.old_status, old.old_message, old.old_note`;
        if (replaced.length === 1) {
          await this.audit.record(tx, {
            actorId: userId,
            action: 'TEACHER_REAPPLIED',
            targetType: 'USER',
            targetId: userId,
            metadata: {
              previousStatus: replaced[0].old_status,
              previousMessage: replaced[0].old_message,
              previousDecisionNote: replaced[0].old_note,
            },
          });
          emitAfterCommit(tx, 'teacher-application.received', {
            applicantId: userId,
          });
          return;
        }
        const current = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM user_roles WHERE user_id = ${userId}::uuid AND role = 'TEACHER'`;
        throw new ApiException(
          current[0]?.status === 'ACTIVE'
            ? 'ALREADY_TEACHER'
            : 'APPLICATION_PENDING',
        );
      });
    } catch (error) {
      // Two submissions at the very same moment: the loser's insert hit the primary key before the winner committed.
      if (isUniqueViolation(error))
        throw new ApiException('APPLICATION_PENDING');
      throw error;
    }
    return this.get(userId);
  }
}
