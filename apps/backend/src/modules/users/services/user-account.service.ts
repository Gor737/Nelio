import { Injectable } from '@nestjs/common';
import { ApiException } from '../../../common/filters/index.js';
import { AuditWriter } from '../../../infrastructure/audit/index.js';
import { type Tx, lockRow } from '../../../infrastructure/database/index.js';
import { emitAfterCommit } from '../../../infrastructure/events/index.js';

export interface NewUserInput {
  readonly email: string;
  readonly fullName: string;
  /** Already hashed, outside any transaction (no hashing inside a transaction). Absent for a Google-only account. */
  readonly passwordHash?: string | null;
  readonly emailVerifiedAt?: Date | null;
}

export interface RoleDecisionInput {
  readonly userId: string;
  readonly decidedBy: string;
  readonly note?: string | null;
}

/**
 * The write primitives that Auth and Admin compose inside THEIR transaction (docs/architecture.md section 6: Users owns `User` and
 * `UserRole`; nobody else writes them). Every method takes the caller's `tx`, never opens one, and never calls Auth or Courses, which
 * are above this module: rules that need them (the last Admin, "owns any course", revoking sessions) are the caller's, between the
 * calls below. Decisions write the audit row in the same transaction and queue the notification event for after the commit.
 */
@Injectable()
export class UserAccountService {
  constructor(private readonly audit: AuditWriter) {}

  /**
   * Creates the user and the ACTIVE `STUDENT` role together (Decision 36): both rows are in the caller's transaction, so there is never a
   * user without a role. The email is lower-cased here (the column is unique and compared lower-case, Decision 65). A duplicate email is a
   * unique violation: the caller handles it OUTSIDE the failed transaction.
   */
  async createWithStudentRole(
    tx: Tx,
    input: NewUserInput,
  ): Promise<{ id: string; email: string }> {
    const email = input.email.trim().toLowerCase();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO users (email, full_name, password_hash, email_verified_at)
      VALUES (${email}, ${input.fullName}, ${input.passwordHash ?? null}, ${input.emailVerifiedAt ?? null})
      RETURNING id`;
    const id = rows[0].id;
    await tx.$executeRaw`
      INSERT INTO user_roles (user_id, role, status) VALUES (${id}::uuid, 'STUDENT', 'ACTIVE')`;
    return { id, email };
  }

  /**
   * Makes every access token issued before `at` (default: now) invalid (Decision 152). It never moves backwards: a later call with an
   * earlier time keeps the later value. Returns the value now stored.
   */
  async setTokensValidAfter(
    tx: Tx,
    userId: string,
    at: Date = new Date(),
  ): Promise<Date> {
    const rows = await tx.$queryRaw<{ tokens_valid_after: Date }[]>`
      UPDATE users SET tokens_valid_after = GREATEST(COALESCE(tokens_valid_after, ${at}), ${at}), updated_at = now()
       WHERE id = ${userId}::uuid RETURNING tokens_valid_after`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    return rows[0].tokens_valid_after;
  }

  /**
   * The User row lock of the global order: `S` (FOR SHARE) for anything that makes the user a course Owner or Assistant, `X`
   * (FOR NO KEY UPDATE) for revocation and suspension (architecture section 15, "Teacher eligibility"). Returns false when the user
   * does not exist.
   */
  lockUser(tx: Tx, userId: string, mode: 'S' | 'X'): Promise<boolean> {
    return lockRow(
      tx,
      'user',
      userId,
      mode === 'S' ? 'SHARE' : 'NO_KEY_UPDATE',
    );
  }

  /** `PENDING -> ACTIVE`. Audit `TEACHER_APPROVED`; the applicant is notified after commit. */
  async approveApplication(tx: Tx, input: RoleDecisionInput): Promise<void> {
    await this.decideRole(tx, input, 'TEACHER', 'PENDING', 'ACTIVE');
    await this.audit.record(tx, {
      actorId: input.decidedBy,
      action: 'TEACHER_APPROVED',
      targetType: 'USER',
      targetId: input.userId,
      metadata: { note: input.note ?? null },
    });
    emitAfterCommit(tx, 'teacher-application.approved', {
      applicantId: input.userId,
      decidedBy: input.decidedBy,
    });
  }

  /** `PENDING -> REJECTED`. The user may apply again (Decision 128). */
  async rejectApplication(tx: Tx, input: RoleDecisionInput): Promise<void> {
    await this.decideRole(tx, input, 'TEACHER', 'PENDING', 'REJECTED');
    await this.audit.record(tx, {
      actorId: input.decidedBy,
      action: 'TEACHER_REJECTED',
      targetType: 'USER',
      targetId: input.userId,
      metadata: { note: input.note ?? null },
    });
    emitAfterCommit(tx, 'teacher-application.rejected', {
      applicantId: input.userId,
      decidedBy: input.decidedBy,
    });
  }

  /**
   * `ACTIVE -> REVOKED` for the Teacher role, under the User-X lock taken here. Whether the user still owns courses is NOT checked here
   * (Courses is above this module): the caller locks the user with `lockUser(tx, id, 'X')`, checks `ownsCourses`, and only then calls
   * this (Decision 10).
   */
  async revokeTeacher(tx: Tx, input: RoleDecisionInput): Promise<void> {
    await this.lockUser(tx, input.userId, 'X');
    await this.decideRole(tx, input, 'TEACHER', 'ACTIVE', 'REVOKED');
    await this.audit.record(tx, {
      actorId: input.decidedBy,
      action: 'TEACHER_REVOKED',
      targetType: 'USER',
      targetId: input.userId,
      metadata: { note: input.note ?? null },
    });
    emitAfterCommit(tx, 'teacher-role.revoked', {
      userId: input.userId,
      revokedBy: input.decidedBy,
    });
  }

  /**
   * `ACTIVE -> SUSPENDED` under the User-X lock taken here: sets `suspended_at` and invalidates every access token issued so far. The
   * caller (Admin) has already protected the last Admin and the owner-transfer rule, and calls Auth's `revokeAllSessions` in the same
   * transaction. Suspending a suspended user is 409 `INVALID_STATE_TRANSITION`.
   */
  async suspend(
    tx: Tx,
    input: { userId: string; actorId: string; reason?: string | null },
  ): Promise<void> {
    await this.lockUser(tx, input.userId, 'X');
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE users SET status = 'SUSPENDED', suspended_at = now(), updated_at = now()
       WHERE id = ${input.userId}::uuid AND status = 'ACTIVE' RETURNING id`;
    if (rows.length === 0) await this.failTransition(tx, input.userId);
    await this.setTokensValidAfter(tx, input.userId);
    await this.audit.record(tx, {
      actorId: input.actorId,
      action: 'USER_SUSPENDED',
      targetType: 'USER',
      targetId: input.userId,
      metadata: { reason: input.reason ?? null },
    });
  }

  /** `SUSPENDED -> ACTIVE`. Tokens invalidated at suspension stay invalid; the user logs in again. */
  async unsuspend(
    tx: Tx,
    input: { userId: string; actorId: string },
  ): Promise<void> {
    await this.lockUser(tx, input.userId, 'X');
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE users SET status = 'ACTIVE', suspended_at = NULL, updated_at = now()
       WHERE id = ${input.userId}::uuid AND status = 'SUSPENDED' RETURNING id`;
    if (rows.length === 0) await this.failTransition(tx, input.userId);
    await this.audit.record(tx, {
      actorId: input.actorId,
      action: 'USER_UNSUSPENDED',
      targetType: 'USER',
      targetId: input.userId,
    });
  }

  /** One conditional update of a role row from a known state; the decided pair is set together (CHECK `user_roles_decided_pair`). */
  private async decideRole(
    tx: Tx,
    input: RoleDecisionInput,
    role: 'TEACHER',
    from: 'PENDING' | 'ACTIVE',
    to: 'ACTIVE' | 'REJECTED' | 'REVOKED',
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ user_id: string }[]>`
      UPDATE user_roles
         SET status = ${to}::role_status, decision_note = ${input.note ?? null},
             decided_by = ${input.decidedBy}::uuid, decided_at = now(), updated_at = now()
       WHERE user_id = ${input.userId}::uuid AND role = ${role}::platform_role AND status = ${from}::role_status
      RETURNING user_id`;
    if (rows.length === 1) return;
    const exists = await tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM user_roles WHERE user_id = ${input.userId}::uuid AND role = ${role}::platform_role`;
    throw new ApiException(
      exists.length === 0 ? 'NOT_FOUND' : 'INVALID_STATE_TRANSITION',
    );
  }

  private async failTransition(tx: Tx, userId: string): Promise<never> {
    const exists = await tx.$queryRaw<
      { one: number }[]
    >`SELECT 1 AS one FROM users WHERE id = ${userId}::uuid`;
    throw new ApiException(
      exists.length === 0 ? 'NOT_FOUND' : 'INVALID_STATE_TRANSITION',
    );
  }
}
