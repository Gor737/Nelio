import type { Request } from 'express';
import type { CourseAccess } from '../access/course-access.js';
import type { PlatformRole } from '../constants/permission-matrix.js';

/**
 * What a guard attaches to the request after authentication (docs/architecture.md section 11, step 5): the user id and ONLY the
 * `ACTIVE` platform roles. A pending, rejected or revoked Teacher role is not in the list, so it grants nothing.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly activeRoles: readonly PlatformRole[];
}

/** An Express request after the global guards ran. `user` is absent on public routes and for anonymous optional-auth calls. */
export type AuthenticatedRequest = Request & {
  user?: AuthenticatedUser;
  /** Set by the course-role guard on `@CourseRole()` routes: the caller's relationship to `:courseId` and the course state. */
  courseAccess?: CourseAccess;
};

/** The current state of a user as the guards need it, loaded from the database on every authenticated request (Decision 108). */
export interface AuthUserRecord {
  readonly id: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  /** `User.tokens_valid_after`: access tokens issued in an earlier whole second are no longer valid (Decision 152). */
  readonly tokensValidAfter: Date | null;
  readonly activeRoles: readonly PlatformRole[];
}
