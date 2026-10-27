import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CourseRole, CurrentUser } from '../../../common/decorators/index.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import { UserRefDto } from '../dto/courses.dto.js';
import { CourseTeamService } from '../services/course-team.service.js';

/**
 * The teaching team (Decisions 6, 10, 37, 61, 72). Team operations work in any course status. Each takes the Course row exclusively and
 * re-checks the Owner after the lock.
 */
@ApiTags('Course team')
@ApiBearerAuth('access-token')
@Controller('courses/:courseId')
export class TeamController {
  constructor(private readonly team: CourseTeamService) {}

  @Post('assistants')
  @HttpCode(204)
  @CourseRole('OWNER')
  @ApiOperation({
    summary: 'Add an Assistant (Owner only)',
    description:
      'The person must be an approved Teacher (409), must not already teach the course and must not be an ACTIVE or PENDING student of it (409). They join the course channel.',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto })
  async add(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Body() dto: UserRefDto,
  ): Promise<void> {
    await this.team.addAssistant(user.id, courseId, dto.userId);
  }

  @Post('assistants/me/leave')
  @HttpCode(204)
  @CourseRole('ASSISTANT')
  @ApiOperation({
    summary:
      'Leave the team (an Assistant); the Owner must transfer ownership first',
  })
  @ApiNoContentResponse()
  async leave(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<void> {
    await this.team.leaveAsAssistant(user.id, courseId);
  }

  @Delete('assistants/:userId')
  @HttpCode(204)
  @CourseRole('OWNER')
  @ApiOperation({ summary: 'Remove an Assistant (Owner only)' })
  @ApiNoContentResponse()
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<void> {
    await this.team.removeAssistant(user.id, courseId, userId);
  }

  @Post('ownership-transfer')
  @HttpCode(204)
  @CourseRole('OWNER')
  @ApiOperation({
    summary: 'Transfer ownership (Owner only)',
    description:
      'The new Owner must be an approved Teacher (an existing Assistant or another Teacher) and not a student of this course. You become an Assistant. Exactly one Owner exists at every moment.',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto })
  async transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Body() dto: UserRefDto,
  ): Promise<void> {
    await this.team.transferOwnership(user.id, courseId, dto.userId);
  }
}
