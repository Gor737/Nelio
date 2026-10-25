import {
  type ExecutionContext,
  SetMetadata,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import type {
  CourseRelationship,
  PlatformRole,
} from '../constants/permission-matrix.js';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../guards/authenticated-user.js';

export const IS_PUBLIC_KEY = 'nelio:is-public';
export const OPTIONAL_AUTH_KEY = 'nelio:optional-auth';
export const ROLES_KEY = 'nelio:roles';
export const COURSE_ROLE_KEY = 'nelio:course-role';

/**
 * Markers the decorators leave on an operation in the OpenAPI document so that `buildOpenApiDocument` can derive its security
 * requirements and error responses from the same decorators that drive the guards; they are removed from the final document.
 */
export const OPENAPI_PUBLIC = 'x-nelio-public';
export const OPENAPI_OPTIONAL_AUTH = 'x-nelio-optional-auth';

/** No authentication at all: the route ignores any Authorization header. The whole API is secure by default (Decision 107). */
export const Public = () =>
  applyDecorators(
    SetMetadata(IS_PUBLIC_KEY, true),
    ApiExtension(OPENAPI_PUBLIC, true),
  );

/**
 * Optional authentication: no token means anonymous, a VALID token identifies the caller, and an invalid or expired token is
 * a 401 (never silently treated as anonymous; Decision 152).
 */
export const OptionalAuth = () =>
  applyDecorators(
    SetMetadata(OPTIONAL_AUTH_KEY, true),
    ApiExtension(OPENAPI_OPTIONAL_AUTH, true),
  );

/**
 * Platform roles that may call the route (any of them). A caller without an `ACTIVE` role row for it gets
 * `TEACHER_NOT_APPROVED` when TEACHER is among the allowed roles, otherwise `FORBIDDEN`.
 */
export const Roles = (...roles: PlatformRole[]) =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Course relationships that may call the route (any of them), for routes under `/courses/:courseId/...`. The guard first
 * applies visibility (404) and the Admin-lock gate (403 `COURSE_ADMIN_LOCKED`), then this list (403 `FORBIDDEN`).
 */
export const CourseRole = (...relationships: CourseRelationship[]) =>
  SetMetadata(COURSE_ROLE_KEY, relationships);

/** The authenticated user of the request (undefined on public routes and for anonymous optional-auth calls). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
