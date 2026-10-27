import { Injectable } from '@nestjs/common';
import { COUNT_LIMITS } from '../../../common/constants/limits.js';
import { PrismaService } from '../../../infrastructure/database/index.js';
import type {
  AuditLogItemDto,
  AuditLogPageDto,
  AuditLogQueryDto,
  StatsDto,
} from '../dto/admin.dto.js';

interface AuditRow {
  id: string;
  actor_id: string;
  actor_name: string;
  action: string;
  target_type: string;
  target_id: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/**
 * Admin: the audit-log viewer and the read-only statistics (Decisions 78, 133). Both are plain reads; viewing them writes no audit row. The
 * log is read newest first with a cursor (ids are time-ordered), as the architecture lists the audit log among the cursor lists.
 */
@Injectable()
export class AdminInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  async auditLogs(query: AuditLogQueryDto): Promise<AuditLogPageDto> {
    const limit = query.limit ?? COUNT_LIMITS.PAGE_SIZE_DEFAULT;
    const rows = await this.prisma.$queryRaw<AuditRow[]>`
      SELECT a.id, a.actor_id, u.full_name AS actor_name, a.action, a.target_type, a.target_id, a.metadata, a.created_at
        FROM audit_logs a JOIN users u ON u.id = a.actor_id
       WHERE (${query.cursor ?? null}::uuid IS NULL OR a.id < ${query.cursor ?? null}::uuid)
         AND (${query.actorId ?? null}::uuid IS NULL OR a.actor_id = ${query.actorId ?? null}::uuid)
         AND (${query.action ?? null}::text IS NULL OR a.action = ${query.action ?? null}::text)
         AND (${query.targetType ?? null}::text IS NULL OR a.target_type = ${query.targetType ?? null}::text)
         AND (${query.targetId ?? null}::uuid IS NULL OR a.target_id = ${query.targetId ?? null}::uuid)
       ORDER BY a.id DESC
       LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const items: AuditLogItemDto[] = page.map((row) => ({
      id: row.id,
      actor: { id: row.actor_id, fullName: row.actor_name },
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: row.metadata,
      createdAt: row.created_at,
    }));
    return {
      items,
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async stats(): Promise<StatsDto> {
    const rows = await this.prisma.$queryRaw<
      {
        users_total: number;
        users_active: number;
        users_suspended: number;
        teachers: number;
        applications: number;
        admins: number;
        draft: number;
        published: number;
        archived: number;
        locked: number;
        enrolled: number;
        pending: number;
        reports: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM users) AS users_total,
        (SELECT count(*)::int FROM users WHERE status = 'ACTIVE') AS users_active,
        (SELECT count(*)::int FROM users WHERE status = 'SUSPENDED') AS users_suspended,
        (SELECT count(*)::int FROM user_roles WHERE role = 'TEACHER' AND status = 'ACTIVE') AS teachers,
        (SELECT count(*)::int FROM user_roles WHERE role = 'TEACHER' AND status = 'PENDING') AS applications,
        (SELECT count(*)::int FROM user_roles r JOIN users u ON u.id = r.user_id
          WHERE r.role = 'ADMIN' AND r.status = 'ACTIVE' AND u.status = 'ACTIVE') AS admins,
        (SELECT count(*)::int FROM courses WHERE status = 'DRAFT') AS draft,
        (SELECT count(*)::int FROM courses WHERE status = 'PUBLISHED') AS published,
        (SELECT count(*)::int FROM courses WHERE status = 'ARCHIVED') AS archived,
        (SELECT count(*)::int FROM courses WHERE locked_by_admin_at IS NOT NULL) AS locked,
        (SELECT count(*)::int FROM enrollments WHERE status = 'ACTIVE') AS enrolled,
        (SELECT count(*)::int FROM enrollments WHERE status = 'PENDING') AS pending,
        (SELECT count(*)::int FROM reports WHERE status = 'OPEN') AS reports`;
    const r = rows[0];
    return {
      users: {
        total: r.users_total,
        active: r.users_active,
        suspended: r.users_suspended,
      },
      roles: {
        activeTeachers: r.teachers,
        pendingApplications: r.applications,
        activeAdmins: r.admins,
      },
      courses: {
        draft: r.draft,
        published: r.published,
        archived: r.archived,
        locked: r.locked,
      },
      enrollments: { active: r.enrolled, pending: r.pending },
      reports: { open: r.reports },
    };
  }
}
