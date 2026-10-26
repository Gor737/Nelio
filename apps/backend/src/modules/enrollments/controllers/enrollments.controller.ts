import {
  Body,
  Controller,
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
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CourseRole, CurrentUser } from '../../../common/decorators/index.js';
import { pageWindow } from '../../../common/dto/page-query.dto.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import {
  EnrollmentDto,
  LastVisitedDto,
  MyEnrollmentsPageDto,
  MyEnrollmentsQueryDto,
  StudentProgressDto,
  StudentsPageDto,
  StudentsQueryDto,
} from '../dto/enrollments.dto.js';
import { EnrollmentsService } from '../services/enrollments.service.js';

const REFUSED =
  'On an archived or Admin-locked course: 409 COURSE_ARCHIVED / COURSE_ADMIN_LOCKED.';

/** The student's side (`/courses/:id/enrollments…`, `/me/enrollments`) and the teachers' side (`/courses/:id/students…`). */
@ApiTags('Enrollments')
@ApiBearerAuth('access-token')
@Controller()
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Post('courses/:courseId/enrollments')
  @HttpCode(201)
  @CourseRole(
    'NONE',
    'INVITEE',
    'STUDENT_LEFT',
    'REJECTED',
    'REMOVED',
    'STUDENT_ACTIVE',
    'STUDENT_PENDING',
  )
  @ApiOperation({
    summary: 'Enroll in a course (or return after leaving or a rejection)',
    description: `The course's CURRENT policy decides: OPEN gives ACTIVE at once, APPROVAL_REQUIRED gives PENDING until a teacher approves, INVITATION_ONLY needs an invitation (403 INVITATION_REQUIRED; accept the invitation instead). Enrolling twice is harmless: 409 ALREADY_ENROLLED. A REMOVED student cannot enroll (403): only reinstatement or a new invitation brings them back. ${REFUSED}`,
  })
  @ApiCreatedResponse({ type: EnrollmentDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  enroll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<EnrollmentDto> {
    return this.enrollments.enroll(user.id, courseId);
  }

  @Get('courses/:courseId/enrollments/me')
  @CourseRole(
    'STUDENT_ACTIVE',
    'STUDENT_PENDING',
    'STUDENT_LEFT',
    'REMOVED',
    'REJECTED',
  )
  @ApiOperation({
    summary: 'My enrollment in this course',
    description:
      '`completedAt` (permanent) and `progress.percent` (live) are separate: a completed student can show less than 100 after new lessons are published.',
  })
  @ApiOkResponse({ type: EnrollmentDto })
  mine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<EnrollmentDto> {
    return this.enrollments.mine(user.id, courseId);
  }

  @Post('courses/:courseId/enrollments/me/leave')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Leave the course, or cancel a pending request',
    description:
      'Always possible, also on an archived or Admin-locked course. Progress is kept; returning restores it.',
  })
  @ApiNoContentResponse()
  async leave(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<void> {
    await this.enrollments.leave(user.id, courseId);
  }

  @Put('courses/:courseId/enrollments/me/last-visited')
  @HttpCode(204)
  @CourseRole('STUDENT_ACTIVE')
  @ApiOperation({
    summary: 'Remember the lesson I was on ("continue where you left off")',
    description: 'A published lesson of this course, else 404.',
  })
  @ApiNoContentResponse()
  async lastVisited(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Body() dto: LastVisitedDto,
  ): Promise<void> {
    await this.enrollments.setLastVisited(user.id, courseId, dto.lessonId);
  }

  @Get('me/enrollments')
  @ApiOperation({
    summary: 'My courses',
    description:
      'My enrollments with their progress (default ACTIVE and PENDING; `status` selects another). Progress for the whole page is one query.',
  })
  @ApiOkResponse({ type: MyEnrollmentsPageDto })
  myEnrollments(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MyEnrollmentsQueryDto,
  ): Promise<MyEnrollmentsPageDto> {
    return this.enrollments.myEnrollments(user.id, query, pageWindow(query));
  }

  @Get('courses/:courseId/students')
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'The students of the course (teachers)',
    description:
      'Default ACTIVE and PENDING. Names and avatars only, never an email address.',
  })
  @ApiOkResponse({ type: StudentsPageDto })
  students(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Query() query: StudentsQueryDto,
  ): Promise<StudentsPageDto> {
    return this.enrollments.students(courseId, query, pageWindow(query));
  }

  @Get('courses/:courseId/students/:userId/progress')
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({ summary: "One student's progress (teachers)" })
  @ApiOkResponse({ type: StudentProgressDto })
  studentProgress(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<StudentProgressDto> {
    return this.enrollments.studentProgress(courseId, userId);
  }

  @Post('courses/:courseId/students/:userId/approve')
  @HttpCode(204)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Approve a pending request (Owner or Assistant)',
    description: `PENDING to ACTIVE. ${REFUSED}`,
  })
  @ApiNoContentResponse()
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<void> {
    await this.enrollments.approve(user.id, courseId, userId);
  }

  @Post('courses/:courseId/students/:userId/reject')
  @HttpCode(204)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Reject a pending request (Owner or Assistant)',
    description: 'PENDING to REJECTED. The student may request again.',
  })
  @ApiNoContentResponse()
  async reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<void> {
    await this.enrollments.reject(user.id, courseId, userId);
  }

  @Post('courses/:courseId/students/:userId/remove')
  @HttpCode(204)
  @CourseRole('OWNER')
  @ApiOperation({
    summary: 'Remove a student (Owner only)',
    description:
      'ACTIVE to REMOVED, in any course status. Their progress is kept.',
  })
  @ApiNoContentResponse()
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<void> {
    await this.enrollments.remove(user.id, courseId, userId);
  }

  @Post('courses/:courseId/students/:userId/reinstate')
  @HttpCode(204)
  @CourseRole('OWNER')
  @ApiOperation({
    summary: 'Reinstate a removed student (Owner only)',
    description: `REMOVED to ACTIVE with their old progress. ${REFUSED}`,
  })
  @ApiNoContentResponse()
  async reinstate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<void> {
    await this.enrollments.reinstate(user.id, courseId, userId);
  }
}
