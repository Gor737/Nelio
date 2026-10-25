import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformRole } from '../constants/permission-matrix.js';
import { ROLES_KEY } from '../decorators/auth.decorators.js';
import { ApiException } from '../filters/api-exception.js';
import type { AuthenticatedRequest } from './authenticated-user.js';

/**
 * `@Roles(...)`: level 1 of authorization (docs/architecture.md section 12). It looks only at the `ACTIVE` role rows that the
 * authentication guard attached, so a PENDING, REJECTED or REVOKED role never counts.
 *   - the caller has one of the allowed roles                        -> pass
 *   - otherwise, and TEACHER is among the allowed roles              -> 403 TEACHER_NOT_APPROVED
 *   - otherwise                                                      -> 403 FORBIDDEN
 * (An Admin without an ACTIVE Teacher role on a Teacher route is `TEACHER_NOT_APPROVED`: Admins act through `/admin/*` only.)
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const allowed = this.reflector.getAllAndOverride<
      PlatformRole[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!allowed || allowed.length === 0) return true;

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) throw new ApiException('UNAUTHENTICATED'); // a role route reached without authentication: never open
    if (user.activeRoles.some((role) => allowed.includes(role))) return true;
    throw new ApiException(
      allowed.includes('TEACHER') ? 'TEACHER_NOT_APPROVED' : 'FORBIDDEN',
    );
  }
}
