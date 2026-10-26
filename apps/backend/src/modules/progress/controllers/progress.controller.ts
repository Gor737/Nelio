import { Controller, HttpCode, Param, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CourseRole, CurrentUser } from '../../../common/decorators/index.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import { LessonCompletionDto } from '../dto/progress.dto.js';
import { CompletionService } from '../services/completion.service.js';

@ApiTags('Progress')
@ApiBearerAuth('access-token')
@Controller('courses/:courseId/lessons/:lessonId/completion')
export class ProgressController {
  constructor(private readonly completion: CompletionService) {}

  @Put()
  @HttpCode(200)
  @CourseRole('STUDENT_ACTIVE')
  @ApiOperation({
    summary: 'Mark a lesson complete',
    description:
      'For an ACTIVE student of the course. Idempotent: repeating it changes nothing and returns the same `completedAt`. There is no way to un-complete a lesson. When this request finishes the last published lesson, the course is completed permanently and `courseCompleted` is true in this response only.',
  })
  @ApiOkResponse({ type: LessonCompletionDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description:
      'The lesson does not exist in this course or is not published.',
  })
  @ApiForbiddenResponse({
    type: ErrorResponseDto,
    description: 'Not an ACTIVE student (for example removed a moment ago).',
  })
  async markComplete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
  ): Promise<LessonCompletionDto> {
    const result = await this.completion.markComplete(
      user.id,
      courseId,
      lessonId,
    );
    return {
      lessonId: result.lessonId,
      completedAt: result.completedAt,
      courseCompleted: result.courseCompleted,
      progress: {
        completedLessons: result.progress.completedLessons,
        totalLessons: result.progress.totalLessons,
        percent: result.progress.percent,
      },
    };
  }
}
