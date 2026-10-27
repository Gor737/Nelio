// A throwaway module for HTTP tests of the shared infrastructure (validation, UUID pipe, throttling, error mapping). It has
// no database, so it runs in the plain e2e suite. It lives in test/ and is never imported by src/.
import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import {
  CourseRole,
  CurrentUser,
  OptionalAuth,
  Public,
  RateLimit,
  Roles,
} from '../../src/common/decorators/index.js';
import { ApiException } from '../../src/common/filters/index.js';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../src/common/guards/index.js';
import { ParseUuidPipe } from '../../src/common/pipes/index.js';
import { Req } from '@nestjs/common';

export class ProbeItemDto {
  @IsString()
  @Length(1, 10)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  count?: number;
}

export class ProbeLoginDto {
  @IsString()
  email!: string;
}

/** The shape Prisma 7 + adapter-pg gives a database error (Spike A finding E2). */
const dbError = (sqlstate: string, constraint?: string) =>
  Object.assign(new Error(`db error ${sqlstate}`), {
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: sqlstate,
          originalMessage: constraint ? `constraint "${constraint}"` : 'x',
        },
      },
    },
  });

@Public()
@Controller('probe')
export class ProbeController {
  @Post('items')
  create(@Body() dto: ProbeItemDto) {
    return dto;
  }

  @Get('items/:id')
  one(@Param('id', ParseUuidPipe) id: string) {
    return { id };
  }

  @Post('login')
  @RateLimit('STRICT')
  login(@Body() dto: ProbeLoginDto) {
    return { ok: true, email: dto.email };
  }

  @Get('throw/:kind')
  fail(@Param('kind') kind: string): never {
    switch (kind) {
      case 'api':
        throw new ApiException('COURSE_ARCHIVED');
      case 'two-status-403':
        throw new ApiException('COURSE_ADMIN_LOCKED', { status: 403 });
      case 'two-status-409':
        throw new ApiException('COURSE_ADMIN_LOCKED', { status: 409 });
      case 'unique':
        throw dbError('23505', 'users_email_key');
      case 'fk':
        throw dbError('23503', 'x_fkey');
      case 'restrict':
        throw dbError('23001', 'x_fkey');
      case 'check':
        throw dbError('23514', 'blocks_no_self_block');
      case 'deadlock':
        throw dbError('40P01');
      case 'lock-timeout':
        throw dbError('55P03');
      default:
        throw new Error('secret internal detail: postgresql://user:pw@host/db');
    }
  }
}

/**
 * Routes that need authentication (the global guards are secure by default): they exercise the JWT guard, the roles guard, the
 * course-role guard, the user-keyed rate limits and the check order. Nothing here is public.
 */
@Controller('probe-auth')
export class AuthProbeController {
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return { id: user.id, roles: user.activeRoles };
  }

  @Get('optional')
  @OptionalAuth()
  optional(@CurrentUser() user?: AuthenticatedUser) {
    return { id: user?.id ?? null };
  }

  @Get('teacher')
  @Roles('TEACHER')
  teacher() {
    return { ok: true };
  }

  @Get('admin')
  @Roles('ADMIN')
  admin() {
    return { ok: true };
  }

  /** Authenticated route with a validated body: the 400 must come after 401, 403 and the role guard. */
  @Post('teacher-items')
  @Roles('TEACHER')
  teacherItem(@Body() dto: ProbeItemDto) {
    return dto;
  }

  @Post('conversations/:conversationId/messages')
  @RateLimit('PER_CONVERSATION_BURST')
  send(
    @Param('conversationId') conversationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { conversationId, userId: user.id };
  }

  @Get('tight')
  @RateLimit('TIGHT')
  tight() {
    return { ok: true };
  }

  @Get('courses/:courseId/owner')
  @CourseRole('OWNER')
  owner(
    @Param('courseId') _courseId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return { relationship: request.courseAccess?.relationship };
  }

  @Get('courses/:courseId/staff')
  @CourseRole('OWNER', 'ASSISTANT')
  staff(
    @Param('courseId') _courseId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return { relationship: request.courseAccess?.relationship };
  }

  /** Any relationship that can see the course: the 404 and lock gates apply, the role check passes for all. */
  @Get('courses/:courseId/any')
  @OptionalAuth()
  @CourseRole(
    'OWNER',
    'ASSISTANT',
    'STUDENT_ACTIVE',
    'STUDENT_PENDING',
    'STUDENT_LEFT',
    'REMOVED',
    'REJECTED',
    'INVITEE',
    'NONE',
  )
  any(
    @Param('courseId') _courseId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return { relationship: request.courseAccess?.relationship };
  }
}

@Module({ controllers: [ProbeController, AuthProbeController] })
export class ProbeModule {}
