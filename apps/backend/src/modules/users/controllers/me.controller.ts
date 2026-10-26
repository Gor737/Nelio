import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, RateLimit } from '../../../common/decorators/index.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import {
  ApplyTeacherDto,
  MeDto,
  TeacherApplicationDto,
  UpdateMeDto,
} from '../dto/users.dto.js';
import { TeacherApplicationService } from '../services/teacher-application.service.js';
import { UsersService } from '../services/users.service.js';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly applications: TeacherApplicationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'My account',
    description:
      'The only response that contains the email address. `roles` lists every role row with its state; only ACTIVE roles grant anything.',
  })
  @ApiOkResponse({ type: MeDto })
  me(@CurrentUser() user: AuthenticatedUser): Promise<MeDto> {
    return this.users.getMe(user.id);
  }

  @Patch()
  @ApiOperation({
    summary: 'Change my name or avatar',
    description:
      'Only `fullName` and `avatarFileId` can be sent; any other property (for example `role`, `email`, `status`) is 400. `avatarFileId: null` removes the avatar.',
  })
  @ApiOkResponse({ type: MeDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'The avatar file is not one of your AVATAR uploads.',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMeDto,
  ): Promise<MeDto> {
    return this.users.updateMe(user.id, dto);
  }

  @Get('teacher-application')
  @ApiOperation({
    summary: 'State of my Teacher application',
    description: '`status` is NONE when I never applied.',
  })
  @ApiOkResponse({ type: TeacherApplicationDto })
  application(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TeacherApplicationDto> {
    return this.applications.get(user.id);
  }

  @Post('teacher-application')
  @HttpCode(201)
  @RateLimit('TIGHT')
  @ApiOperation({
    summary: 'Apply to become a Teacher',
    description:
      'Also used to apply again after a rejection or a revocation (the earlier message is kept in the audit log). 409 APPLICATION_PENDING while one waits, 409 ALREADY_TEACHER for an ACTIVE Teacher.',
  })
  @ApiCreatedResponse({ type: TeacherApplicationDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'APPLICATION_PENDING or ALREADY_TEACHER.',
  })
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ApplyTeacherDto,
  ): Promise<TeacherApplicationDto> {
    return this.applications.apply(user.id, dto.message);
  }
}
