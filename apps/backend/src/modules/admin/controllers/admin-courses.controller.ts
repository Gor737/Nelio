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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../../common/decorators/index.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import { LessonTeacherDto, OutlineDto } from '../../content/index.js';
import {
  AdminCourseDetailDto,
  AdminCoursesPageDto,
  AdminCoursesQueryDto,
  LockCourseDto,
} from '../../courses/index.js';
import { TransferOwnershipDto } from '../dto/admin.dto.js';
import { AdminCoursesService } from '../services/admin-courses.service.js';

const ADMIN_ONLY = 'Admins only: 403 FORBIDDEN for anyone else.';

/** Courses seen and handled by Admins: takedown (`lock`, `unlock`, `restore`), ownership transfer, students, read-only content review. */
@ApiTags('Admin')
@ApiBearerAuth('access-token')
@Roles('ADMIN')
@Controller('admin/courses')
export class AdminCoursesController {
  constructor(private readonly courses: AdminCoursesService) {}

  @Get()
  @ApiOperation({
    summary: 'List courses in every status',
    description: `Newest first; filter by title words, status, policy, locked, category, teacher. Locked and draft courses are included. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: AdminCoursesPageDto })
  list(@Query() query: AdminCoursesQueryDto): Promise<AdminCoursesPageDto> {
    return this.courses.list(query);
  }

  @Get(':courseId')
  @ApiOperation({
    summary: 'One course with its team',
    description: ADMIN_ONLY,
  })
  @ApiOkResponse({ type: AdminCourseDetailDto })
  get(
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<AdminCourseDetailDto> {
    return this.courses.get(courseId);
  }

  @Get(':courseId/outline')
  @ApiOperation({
    summary: 'Sections and lessons, read-only',
    description: `Every lesson with its status, also on a locked course. Writes no audit row. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: OutlineDto })
  outline(
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<OutlineDto> {
    return this.courses.outline(courseId);
  }

  @Get(':courseId/lessons/:lessonId')
  @ApiOperation({
    summary: 'A lesson with its blocks, read-only',
    description: `Any status, also on a locked course. Writes no audit row. 404 when the lesson is not in this course. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: LessonTeacherDto })
  lesson(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
  ): Promise<LessonTeacherDto> {
    return this.courses.lesson(courseId, lessonId);
  }

  @Post(':courseId/lock')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Take a course down',
    description: `A published or already archived course becomes ARCHIVED and locked; its Owner and Assistants cannot restore it and are notified with the reason. Students with an ACTIVE, LEFT or PENDING enrollment get 403 COURSE_ADMIN_LOCKED; everyone else 404. 409 COURSE_ALREADY_LOCKED; a draft is 409 INVALID_STATE_TRANSITION. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: AdminCourseDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  lock(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Body() dto: LockCourseDto,
  ): Promise<AdminCourseDetailDto> {
    return this.courses.lock(admin.id, courseId, dto.reason);
  }

  @Post(':courseId/unlock')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Lift the lock and leave the course archived',
    description: `The Owner can then restore it. 409 COURSE_NOT_LOCKED when it is not locked. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: AdminCourseDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  unlock(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<AdminCourseDetailDto> {
    return this.courses.unlock(admin.id, courseId);
  }

  @Post(':courseId/restore')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Lift the lock and publish the course again',
    description: `409 COURSE_NOT_LOCKED when it is not locked. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: AdminCourseDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  restore(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<AdminCourseDetailDto> {
    return this.courses.restore(admin.id, courseId);
  }

  @Post(':courseId/ownership-transfer')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Transfer ownership on behalf of the Owner',
    description: `Works in any course status. The new Owner must be an ACTIVE Teacher who is not a student of the course; the old Owner becomes an Assistant. 409 RESOURCE_CONFLICT otherwise. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: AdminCourseDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  transfer(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Body() dto: TransferOwnershipDto,
  ): Promise<AdminCourseDetailDto> {
    return this.courses.transferOwnership(admin.id, courseId, dto.newOwnerId);
  }

  @Post(':courseId/students/:studentId/remove')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a student',
    description: `Allowed in any course status; progress is kept. 404 without an enrollment, 409 INVALID_STATE_TRANSITION when the student cannot be removed from their current status. ${ADMIN_ONLY}`,
  })
  @ApiNoContentResponse()
  async removeStudent(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('studentId', ParseUuidPipe) studentId: string,
  ): Promise<void> {
    await this.courses.removeStudent(admin.id, courseId, studentId);
  }

  @Post(':courseId/students/:studentId/reinstate')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Reinstate a removed student',
    description: `REMOVED to ACTIVE with the old progress. Refused on an archived or locked course (409). ${ADMIN_ONLY}`,
  })
  @ApiNoContentResponse()
  async reinstateStudent(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('studentId', ParseUuidPipe) studentId: string,
  ): Promise<void> {
    await this.courses.reinstateStudent(admin.id, courseId, studentId);
  }
}
