import { Injectable } from '@nestjs/common';
import {
  PLATFORM_ROLES,
  type PlatformRole,
} from '../constants/permission-matrix.js';
import { PrismaService } from '../../infrastructure/database/index.js';
import type { AuthUserRecord } from './authenticated-user.js';

/**
 * Loads the current state of a user for authentication. An abstract class so that it is an injection token: the application
 * uses `PrismaAuthUserLoader`; HTTP tests that must not need a database provide a fake.
 */
export abstract class AuthUserLoader {
  abstract load(userId: string): Promise<AuthUserRecord | null>;
}

interface Row {
  status: 'ACTIVE' | 'SUSPENDED';
  tokens_valid_after: Date | null;
  roles: string[];
}

/**
 * One statement per request (Decision 108: "costs one indexed query per request"): the user row and the names of its `ACTIVE`
 * role rows. A role row that is PENDING, REJECTED or REVOKED is not returned, so it can never grant anything.
 */
@Injectable()
export class PrismaAuthUserLoader extends AuthUserLoader {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async load(userId: string): Promise<AuthUserRecord | null> {
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT u.status::text AS status, u.tokens_valid_after,
             COALESCE(array_agg(r.role::text) FILTER (WHERE r.status = 'ACTIVE'), '{}') AS roles
        FROM users u
        LEFT JOIN user_roles r ON r.user_id = u.id
       WHERE u.id = ${userId}::uuid
       GROUP BY u.id`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: userId,
      status: row.status,
      tokensValidAfter: row.tokens_valid_after,
      activeRoles: row.roles.filter((role): role is PlatformRole =>
        (PLATFORM_ROLES as readonly string[]).includes(role),
      ),
    };
  }
}
