import { Injectable } from '@nestjs/common';
import { pageWindow } from '../../../common/dto/page-query.dto.js';
import { ApiException } from '../../../common/filters/index.js';
import {
  PrismaService,
  TransactionService,
  type Tx,
  lockAdvisory,
} from '../../../infrastructure/database/index.js';
import { SessionsService } from '../../auth/index.js';
import { CourseTeamService } from '../../courses/index.js';
import { UserAccountService } from '../../users/index.js';
import {
  AdminUserDetailDto,
  AdminUserItemDto,
  AdminUsersPageDto,
  AdminUsersQueryDto,
  ApplicationsQueryDto,
  TeacherApplicationItemDto,
  TeacherApplicationsPageDto,
} from '../dto/admin.dto.js';

/** LIKE special characters in an Admin's search are literals. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  suspended_at: Date | null;
  email_verified_at: Date | null;
  created_at: Date;
  roles: AdminUserItemDto['roles'];
  total?: number;
}

const transferFirst = (): ApiException =>
  new ApiException('RESOURCE_CONFLICT', {
    message:
      'This person still owns courses: transfer their ownership first (it applies to every owned course, in any status)',
  });

/**
 * Admin: people (Decisions 10, 39, 45, 133, 135). Orchestration only: the writes belong to Users (`UserAccountService`), Courses
 * (`CourseTeamService`) and Auth (`SessionsService`), and each Admin action is ONE transaction that composes them in the global lock order:
 * the `ADMIN-SET` advisory lock first (anything that can shrink the set of Admins), then the User row, then the Courses.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly accounts: UserAccountService,
    private readonly team: CourseTeamService,
    private readonly sessions: SessionsService,
  ) {}

  // ------------------------------------------------------------------ reads

  async list(query: AdminUsersQueryDto): Promise<AdminUsersPageDto> {
    const { page, pageSize, offset } = pageWindow(query);
    const needle = query.q ? escapeLike(query.q.toLowerCase()) : null;
    const rows = await this.prisma.$queryRaw<UserRow[]>`
      SELECT u.id, u.email, u.full_name, u.status, u.suspended_at, u.email_verified_at, u.created_at,
             COALESCE((SELECT json_agg(json_build_object('role', r.role, 'status', r.status) ORDER BY r.role)
                         FROM user_roles r WHERE r.user_id = u.id), '[]'::json) AS roles,
             count(*) OVER ()::int AS total
        FROM users u
       WHERE (${needle}::text IS NULL OR lower(u.full_name) LIKE ${'%' + (needle ?? '') + '%'} ESCAPE '\\' OR lower(u.email) LIKE ${(needle ?? '') + '%'} ESCAPE '\\')
         AND (${query.status ?? null}::text IS NULL OR u.status::text = ${query.status ?? null}::text)
         AND (${query.role ?? null}::text IS NULL OR EXISTS (
               SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role::text = ${query.role ?? null}::text AND r.status = 'ACTIVE'))
       ORDER BY u.created_at DESC, u.id
       LIMIT ${pageSize} OFFSET ${offset}`;
    return {
      items: rows.map((row) => this.toItem(row)),
      page,
      pageSize,
      total: rows[0]?.total ?? 0,
    };
  }

  async get(userId: string): Promise<AdminUserDetailDto> {
    const rows = await this.prisma.$queryRaw<
      (UserRow & {
        owned: number;
        assisted: number;
        enrollments: number;
        has_password: boolean;
        has_google: boolean;
      })[]
    >`
      SELECT u.id, u.email, u.full_name, u.status, u.suspended_at, u.email_verified_at, u.created_at,
             COALESCE((SELECT json_agg(json_build_object('role', r.role, 'status', r.status) ORDER BY r.role)
                         FROM user_roles r WHERE r.user_id = u.id), '[]'::json) AS roles,
             (SELECT count(*)::int FROM course_teachers t WHERE t.user_id = u.id AND t.role = 'OWNER') AS owned,
             (SELECT count(*)::int FROM course_teachers t WHERE t.user_id = u.id AND t.role = 'ASSISTANT') AS assisted,
             (SELECT count(*)::int FROM enrollments e WHERE e.user_id = u.id AND e.status IN ('ACTIVE', 'PENDING')) AS enrollments,
             (u.password_hash IS NOT NULL) AS has_password,
             EXISTS (SELECT 1 FROM auth_identities a WHERE a.user_id = u.id AND a.provider = 'GOOGLE') AS has_google
        FROM users u WHERE u.id = ${userId}::uuid`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    const row = rows[0];
    return Object.assign(this.toItem(row), {
      ownedCourses: row.owned,
      assistedCourses: row.assisted,
      enrollments: row.enrollments,
      hasPassword: row.has_password,
      hasGoogle: row.has_google,
    });
  }

  async applications(
    query: ApplicationsQueryDto,
  ): Promise<TeacherApplicationsPageDto> {
    const { page, pageSize, offset } = pageWindow(query);
    const status = query.status ?? 'PENDING';
    const rows = await this.prisma.$queryRaw<
      {
        user_id: string;
        full_name: string;
        email: string;
        status: TeacherApplicationItemDto['status'];
        application_message: string | null;
        updated_at: Date;
        decision_note: string | null;
        decided_by: string | null;
        decided_at: Date | null;
        total: number;
      }[]
    >`
      SELECT r.user_id, u.full_name, u.email, r.status, r.application_message, r.updated_at, r.decision_note, r.decided_by, r.decided_at,
             count(*) OVER ()::int AS total
        FROM user_roles r JOIN users u ON u.id = r.user_id
       WHERE r.role = 'TEACHER' AND r.status = ${status}::role_status
       ORDER BY r.updated_at ASC, r.user_id
       LIMIT ${pageSize} OFFSET ${offset}`;
    return {
      items: rows.map((row) => ({
        userId: row.user_id,
        fullName: row.full_name,
        email: row.email,
        status: row.status,
        message: row.application_message,
        appliedAt: row.updated_at,
        decisionNote: row.decision_note,
        decidedBy: row.decided_by,
        decidedAt: row.decided_at,
      })),
      page,
      pageSize,
      total: rows[0]?.total ?? 0,
    };
  }

  // ------------------------------------------------------------------ Teacher applications and revocation

  approveApplication(
    actorId: string,
    userId: string,
    note?: string,
  ): Promise<void> {
    return this.transactions.run((tx) =>
      this.accounts.approveApplication(tx, {
        userId,
        decidedBy: actorId,
        note,
      }),
    );
  }

  rejectApplication(
    actorId: string,
    userId: string,
    note?: string,
  ): Promise<void> {
    return this.transactions.run((tx) =>
      this.accounts.rejectApplication(tx, { userId, decidedBy: actorId, note }),
    );
  }

  /**
   * Revokes the Teacher role (Decisions 10, 133). User-X first; the person must own no course (an Owner is never left revoked: transfer
   * first, Admin may do it on their behalf); then the Assistant rows go (courses locked in ascending order), and the role changes. Sessions
   * stay: roles are read from the database on every request.
   */
  revokeTeacher(actorId: string, userId: string, note?: string): Promise<void> {
    return this.transactions.run(async (tx) => {
      if (!(await this.accounts.lockUser(tx, userId, 'X')))
        throw new ApiException('NOT_FOUND');
      if (await this.team.ownsCourses(userId, tx)) throw transferFirst();
      await this.team.removeAssistantRowsOfInTx(tx, { userId, actorId });
      await this.accounts.revokeTeacher(tx, {
        userId,
        decidedBy: actorId,
        note,
      });
    });
  }

  // ------------------------------------------------------------------ suspension

  /**
   * Suspends an account (Decisions 39, 45, 133, 135): status, the Assistant rows, every session and the audit row in ONE transaction. An
   * Owner must transfer first; the last active Admin cannot be suspended; nobody suspends themselves (400). The new request of the user is
   * 403 at once (the status is read from the database), the refresh fails, and their sockets are told `session:revoked` after the commit.
   */
  async suspend(
    actorId: string,
    userId: string,
    reason?: string,
  ): Promise<void> {
    if (actorId === userId) throw new ApiException('CANNOT_SUSPEND_SELF');
    await this.transactions.run(async (tx) => {
      await this.takeAdminSet(tx, actorId);
      if (!(await this.accounts.lockUser(tx, userId, 'X')))
        throw new ApiException('NOT_FOUND');
      if (
        (await this.accounts.isActiveAdmin(tx, userId)) &&
        (await this.accounts.countOtherActiveAdmins(tx, userId)) === 0
      )
        throw new ApiException('LAST_PLATFORM_ADMIN');
      if (await this.team.ownsCourses(userId, tx)) throw transferFirst();
      await this.team.removeAssistantRowsOfInTx(tx, { userId, actorId });
      await this.accounts.suspend(tx, { userId, actorId, reason });
      await this.sessions.revokeAllSessions(tx, userId);
    });
  }

  /** The account is ACTIVE again. The Assistant rows removed at suspension are NOT restored; the user logs in again. */
  unsuspend(actorId: string, userId: string): Promise<void> {
    return this.transactions.run((tx) =>
      this.accounts.unsuspend(tx, { userId, actorId }),
    );
  }

  // ------------------------------------------------------------------ the Admin role

  grantAdminRole(actorId: string, userId: string): Promise<void> {
    return this.transactions.run(async (tx) => {
      await this.accounts.grantAdminRole(tx, { userId, actorId });
    });
  }

  /** Removes the ADMIN role; the last active Admin cannot be demoted (409 `LAST_PLATFORM_ADMIN`). Not an Admin: nothing to do. */
  revokeAdminRole(actorId: string, userId: string): Promise<void> {
    return this.transactions.run(async (tx) => {
      await this.takeAdminSet(tx, actorId);
      if (!(await this.accounts.isActiveAdmin(tx, userId))) {
        await this.accounts.revokeAdminRole(tx, { userId, actorId }); // a REVOKED-able leftover (suspended Admin) still loses the role
        return;
      }
      if ((await this.accounts.countOtherActiveAdmins(tx, userId)) === 0)
        throw new ApiException('LAST_PLATFORM_ADMIN');
      await this.accounts.revokeAdminRole(tx, { userId, actorId });
    });
  }

  /**
   * `ADMIN-SET` (the first lock of the order), then a check that the actor is STILL an active Admin: a request that was authorized
   * a moment ago by an Admin who has just been demoted or suspended by a parallel request does not go on to shrink the set.
   */
  private async takeAdminSet(tx: Tx, actorId: string): Promise<void> {
    await lockAdvisory(tx, 'ADMIN-SET');
    if (!(await this.accounts.isActiveAdmin(tx, actorId)))
      throw new ApiException('FORBIDDEN');
  }

  private toItem(row: UserRow): AdminUserItemDto {
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      status: row.status,
      suspendedAt: row.suspended_at,
      emailVerified: row.email_verified_at !== null,
      roles: row.roles,
      createdAt: row.created_at,
    };
  }
}
