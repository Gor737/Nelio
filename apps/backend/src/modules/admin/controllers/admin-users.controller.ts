import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../../common/decorators/index.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import {
  AdminUserDetailDto,
  AdminUsersPageDto,
  AdminUsersQueryDto,
  ApplicationsQueryDto,
  DecisionNoteDto,
  SuspendUserDto,
  TeacherApplicationsPageDto,
} from '../dto/admin.dto.js';
import { AdminUsersService } from '../services/admin-users.service.js';

const ADMIN_ONLY = 'Admins only: 403 FORBIDDEN for anyone else.';

/** People: users, Teacher applications, suspension and the Admin role. Every route here is Admin-only. */
@ApiTags('Admin')
@ApiBearerAuth('access-token')
@Roles('ADMIN')
@Controller('admin')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get('users')
  @ApiOperation({
    summary: 'List users',
    description: `Newest first, with email and role rows. \`q\` matches part of the name or the start of the email. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: AdminUsersPageDto })
  list(@Query() query: AdminUsersQueryDto): Promise<AdminUsersPageDto> {
    return this.users.list(query);
  }

  @Get('users/:userId')
  @ApiOperation({ summary: 'One user', description: ADMIN_ONLY })
  @ApiOkResponse({ type: AdminUserDetailDto })
  get(
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<AdminUserDetailDto> {
    return this.users.get(userId);
  }

  @Post('users/:userId/suspend')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Suspend an account',
    description: `One transaction: the status, the Assistant roles on all courses (not restored on unsuspend), every session, the audit row. The user gets 403 ACCOUNT_SUSPENDED on the next request, cannot refresh, and their sockets receive \`session:revoked\` and close. Refused: yourself (400 CANNOT_SUSPEND_SELF), the last active Admin (409 LAST_PLATFORM_ADMIN), an Owner of any course in any status (409 RESOURCE_CONFLICT: transfer ownership first), an already suspended user (409 INVALID_STATE_TRANSITION). ${ADMIN_ONLY}`,
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto })
  async suspend(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: SuspendUserDto,
  ): Promise<void> {
    await this.users.suspend(admin.id, userId, dto.reason);
  }

  @Post('users/:userId/unsuspend')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Lift a suspension',
    description: `The account is ACTIVE again and the user logs in again. Assistant roles removed at suspension are not restored; student data was never touched. 409 INVALID_STATE_TRANSITION when not suspended. ${ADMIN_ONLY}`,
  })
  @ApiNoContentResponse()
  async unsuspend(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<void> {
    await this.users.unsuspend(admin.id, userId);
  }

  @Post('users/:userId/revoke-teacher')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke the Teacher role',
    description: `Removes the person from every team they assist and sets the role to REVOKED; sessions stay. An Owner of any course (any status) must transfer first: 409 RESOURCE_CONFLICT (an Admin can transfer on their behalf). 409 INVALID_STATE_TRANSITION when the role is not ACTIVE. ${ADMIN_ONLY}`,
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto })
  async revokeTeacher(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: DecisionNoteDto,
  ): Promise<void> {
    await this.users.revokeTeacher(admin.id, userId, dto.note);
  }

  @Put('users/:userId/admin-role')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Make a user an Admin',
    description: `Idempotent: an Admin stays one (no audit row). A suspended account cannot become an Admin (409). ${ADMIN_ONLY}`,
  })
  @ApiNoContentResponse()
  async grantAdmin(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<void> {
    await this.users.grantAdminRole(admin.id, userId);
  }

  @Delete('users/:userId/admin-role')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Take the Admin role away',
    description: `Under the ADMIN-SET lock, counting after the lock: the last active Admin cannot be demoted (409 LAST_PLATFORM_ADMIN), also when two Admins demote each other at the same moment (one of them is refused). Demoting yourself is allowed while another Admin remains. ${ADMIN_ONLY}`,
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto })
  async revokeAdmin(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<void> {
    await this.users.revokeAdminRole(admin.id, userId);
  }

  @Get('teacher-applications')
  @ApiOperation({
    summary: 'Teacher applications',
    description: `PENDING by default (oldest first); \`status\` shows the decided ones. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: TeacherApplicationsPageDto })
  applications(
    @Query() query: ApplicationsQueryDto,
  ): Promise<TeacherApplicationsPageDto> {
    return this.users.applications(query);
  }

  @Post('teacher-applications/:userId/approve')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Approve a Teacher application',
    description: `PENDING to ACTIVE; the applicant is notified. 409 INVALID_STATE_TRANSITION when it is not pending. ${ADMIN_ONLY}`,
  })
  @ApiNoContentResponse()
  async approve(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: DecisionNoteDto,
  ): Promise<void> {
    await this.users.approveApplication(admin.id, userId, dto.note);
  }

  @Post('teacher-applications/:userId/reject')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Reject a Teacher application',
    description: `PENDING to REJECTED; the applicant is notified and may apply again. ${ADMIN_ONLY}`,
  })
  @ApiNoContentResponse()
  async reject(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: DecisionNoteDto,
  ): Promise<void> {
    await this.users.rejectApplication(admin.id, userId, dto.note);
  }
}
