import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  CourseRole,
  CurrentUser,
  RateLimit,
} from '../../../common/decorators/index.js';
import {
  PageQueryDto,
  pageWindow,
} from '../../../common/dto/page-query.dto.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import {
  CreateInvitationDto,
  EnrollmentDto,
  InvitationDto,
  InvitationsPageDto,
  MyInvitationDto,
} from '../dto/enrollments.dto.js';
import { InvitationsService } from '../services/invitations.service.js';

@ApiTags('Invitations')
@ApiBearerAuth('access-token')
@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('courses/:courseId/invitations')
  @HttpCode(201)
  @RateLimit('TIGHT')
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Invite an existing user (Owner or Assistant)',
    description:
      'Valid for 7 days. 409 INVITATION_PENDING while a valid one exists (never silently reset); an expired, revoked, declined or used one is reused and reset. 409 ALREADY_ENROLLED for an ACTIVE or PENDING student. Not on an archived or locked course.',
  })
  @ApiCreatedResponse({ type: InvitationDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Body() dto: CreateInvitationDto,
  ): Promise<InvitationDto> {
    return this.invitations.create(user.id, courseId, dto.userId);
  }

  @Get('courses/:courseId/invitations')
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'The invitations of the course (teachers)',
    description: 'EXPIRED is derived from the expiry time.',
  })
  @ApiOkResponse({ type: InvitationsPageDto })
  list(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Query() query: PageQueryDto,
  ): Promise<InvitationsPageDto> {
    return this.invitations.list(courseId, pageWindow(query));
  }

  @Post('courses/:courseId/invitations/:invitationId/revoke')
  @HttpCode(204)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Revoke an invitation (the inviter or the Owner)',
    description: 'Only a PENDING invitation; if it was accepted first, 409.',
  })
  @ApiNoContentResponse()
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('invitationId', ParseUuidPipe) invitationId: string,
  ): Promise<void> {
    await this.invitations.revoke(user.id, courseId, invitationId);
  }

  @Get('me/invitations')
  @ApiOperation({ summary: 'My valid invitations' })
  @ApiOkResponse({ type: [MyInvitationDto] })
  mine(@CurrentUser() user: AuthenticatedUser): Promise<MyInvitationDto[]> {
    return this.invitations.mine(user.id);
  }

  @Post('me/invitations/:invitationId/accept')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept an invitation',
    description:
      'Makes me an ACTIVE student, whatever the policy. 409 ALREADY_ENROLLED when I already am (and the invitation stays pending); 409 when it was revoked, declined or expired.',
  })
  @ApiOkResponse({ type: EnrollmentDto })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invitationId', ParseUuidPipe) invitationId: string,
  ): Promise<EnrollmentDto> {
    return this.invitations.accept(user.id, invitationId);
  }

  @Post('me/invitations/:invitationId/decline')
  @HttpCode(204)
  @ApiOperation({ summary: 'Decline an invitation' })
  @ApiNoContentResponse()
  async decline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('invitationId', ParseUuidPipe) invitationId: string,
  ): Promise<void> {
    await this.invitations.decline(user.id, invitationId);
  }
}
