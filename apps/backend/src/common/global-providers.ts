import type { Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { CourseAccessService } from './access/course-access.service.js';
import { AllExceptionsFilter } from './filters/index.js';
import {
  Authenticator,
  AuthUserLoader,
  CourseRoleGuard,
  JwtAuthGuard,
  PrismaAuthUserLoader,
  RateLimiter,
  RateLimitGuard,
  RolesGuard,
  TokenVerifier,
  UserRateLimitGuard,
} from './guards/index.js';
import { createValidationPipe } from './pipes/index.js';

/**
 * The application-wide guards, filter and pipe, in one list that AppModule and the HTTP tests both register, so the tests run
 * the real wiring. Global guards run in registration order, and the order IS the check order of the architecture
 * (docs/architecture.md sections 12 and 13, Decisions 140 and 167):
 *
 *   1. RateLimitGuard      429  keys that exist before authentication: ip, email
 *   2. JwtAuthGuard        401, 403 ACCOUNT_SUSPENDED
 *   3. UserRateLimitGuard  429  keys that need the user: user, user + conversation
 *   4. RolesGuard          403 TEACHER_NOT_APPROVED / FORBIDDEN
 *   5. CourseRoleGuard     404 / 403 COURSE_ADMIN_LOCKED / 403 FORBIDDEN
 *   then the validation pipe (400) and the services (409).
 *
 * A test (auth-guards integration spec) fails if this order changes.
 */
export const GLOBAL_PROVIDERS: Provider[] = [
  { provide: APP_GUARD, useClass: RateLimitGuard },
  { provide: APP_GUARD, useClass: JwtAuthGuard },
  { provide: APP_GUARD, useClass: UserRateLimitGuard },
  { provide: APP_GUARD, useClass: RolesGuard },
  { provide: APP_GUARD, useClass: CourseRoleGuard },
  { provide: APP_FILTER, useClass: AllExceptionsFilter },
  { provide: APP_PIPE, useFactory: createValidationPipe },
];

/**
 * What the global guards need, also used outside HTTP (the Socket.IO handshake in `infrastructure/realtime`, the chat gateway):
 * provided once by the global `AuthCoreModule`. Tests that must not touch a database replace `AuthUserLoader` and
 * `CourseAccessService` with fakes (`{ provide: AuthUserLoader, useValue: fake }` in the testing module's providers).
 */
export const AUTH_SUPPORT_PROVIDERS: Provider[] = [
  TokenVerifier,
  Authenticator,
  { provide: AuthUserLoader, useClass: PrismaAuthUserLoader },
  CourseAccessService,
  RateLimiter,
];
