import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CourseAccessService } from '../access/course-access.service.js';
import type { CourseRelationship } from '../constants/permission-matrix.js';
import { COURSE_ROLE_KEY } from '../decorators/auth.decorators.js';
import { ApiException } from '../filters/api-exception.js';
import type { AuthenticatedRequest } from './authenticated-user.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `@CourseRole(...)`: level 2 of authorization (docs/architecture.md section 12), for routes under `/courses/:courseId/...`.
 * In the order of the check list (first failure wins):
 *   1. the course does not exist, or the caller may not know it exists   -> 404 NOT_FOUND
 *   2. the course is locked by an Admin and the caller is its student    -> 403 COURSE_ADMIN_LOCKED
 *   3. the caller's relationship is not one of the allowed ones          -> 403 FORBIDDEN
 * It attaches the resolved `courseAccess` to the request. A malformed `courseId` is answered 400 here, before any query, so it
 * can never reach PostgreSQL as an invalid UUID.
 */
@Injectable()
export class CourseRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: CourseAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const allowed = this.reflector.getAllAndOverride<
      CourseRelationship[] | undefined
    >(COURSE_ROLE_KEY, [context.getHandler(), context.getClass()]);
    if (!allowed || allowed.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const courseId: unknown = request.params.courseId;
    if (typeof courseId !== 'string' || !UUID.test(courseId)) {
      throw new ApiException('VALIDATION_FAILED', {
        message: 'Validation failed',
        errors: [{ field: 'courseId', messages: ['courseId must be a UUID'] }],
      });
    }

    const access = await this.access.requireVisible(
      request.user?.id ?? null,
      courseId.toLowerCase(),
    );
    if (!allowed.includes(access.relationship))
      throw new ApiException('FORBIDDEN');
    request.courseAccess = access;
    return true;
  }
}
