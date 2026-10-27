import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { CourseAccess } from '../../../common/access/index.js';
import { COURSE_RELATIONSHIPS } from '../../../common/constants/permission-matrix.js';
import {
  CourseRole,
  CurrentCourseAccess,
  CurrentUser,
  OptionalAuth,
  Roles,
} from '../../../common/decorators/index.js';
import {
  PageQueryDto,
  pageWindow,
} from '../../../common/dto/page-query.dto.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import { SyllabusSectionDto } from '../../content/index.js';
import {
  CatalogPageDto,
  CatalogQueryDto,
  CourseDetailDto,
  CourseTeacherDto,
  CreateCourseDto,
  SetTagsDto,
  TagRefDto,
  TeachingCoursesPageDto,
  UpdateCourseDto,
} from '../dto/courses.dto.js';
import { CoursesService } from '../services/courses.service.js';

const OWNER_ERRORS =
  'Owner only. 409 COURSE_ADMIN_LOCKED while an Admin has locked the course (before COURSE_ARCHIVED).';

/**
 * Courses (Decisions 63, 118-121). The public routes (`catalog`, the course page, syllabus, teachers) are readable without an account;
 * what a caller sees of a given course follows the visibility table (404 when they may not know it exists). The Owner and Assistants are
 * "teachers"; only the Owner changes settings and the lifecycle.
 */
@ApiTags('Courses')
@Controller()
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get('courses')
  @OptionalAuth()
  @ApiOperation({
    summary: 'The public catalog',
    description:
      'PUBLISHED courses with an OPEN or APPROVAL_REQUIRED policy (INVITATION_ONLY courses and courses locked by an Admin are never listed). `q` searches title, summary and description in any language (every word must match, the last one as a prefix). Filters: categoryId, tag (slug), enrollmentPolicy. Offset pagination, at most 50 per page.',
  })
  @ApiOkResponse({ type: CatalogPageDto })
  catalog(@Query() query: CatalogQueryDto): Promise<CatalogPageDto> {
    return this.courses.catalog(query);
  }

  @Post('courses')
  @HttpCode(201)
  @Roles('TEACHER')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a course (an approved Teacher)',
    description:
      '`enrollmentPolicy` is required: there is no default, and a missing or unknown value is 400. The course starts as a DRAFT and you are its Owner. TEACHER_NOT_APPROVED (403) without an ACTIVE Teacher role.',
  })
  @ApiCreatedResponse({ type: CourseDetailDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCourseDto,
  ): Promise<CourseDetailDto> {
    return this.courses.create(user.id, dto);
  }

  @Get('me/teaching/courses')
  @Roles('TEACHER')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'The courses I teach (as Owner or Assistant), in any status',
  })
  @ApiOkResponse({ type: TeachingCoursesPageDto })
  teaching(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PageQueryDto,
  ): Promise<TeachingCoursesPageDto> {
    return this.courses.teaching(user.id, pageWindow(query));
  }

  @Get('courses/:courseId')
  @OptionalAuth()
  @CourseRole(...COURSE_RELATIONSHIPS)
  @ApiOperation({
    summary: 'A course page',
    description:
      'Visible according to the visibility table: a draft only to its teachers, an archived course to teachers and to ACTIVE or LEFT students, an INVITATION_ONLY course to invitees, students and teachers; anyone else gets 404. `viewer.relationship` says what the caller is to the course. A course locked by an Admin is 403 COURSE_ADMIN_LOCKED for its students and 404 for everyone but its teachers.',
  })
  @ApiOkResponse({ type: CourseDetailDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  detail(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @CurrentCourseAccess() access: CourseAccess,
  ): Promise<CourseDetailDto> {
    return this.courses.detail(courseId, access.relationship);
  }

  @Get('courses/:courseId/syllabus')
  @OptionalAuth()
  @CourseRole(...COURSE_RELATIONSHIPS)
  @ApiOperation({
    summary: 'The syllabus: sections and the titles of PUBLISHED lessons',
    description:
      'Titles only, never content. Sections without a published lesson are omitted. Same visibility as the course page.',
  })
  @ApiOkResponse({ type: [SyllabusSectionDto] })
  syllabus(
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<SyllabusSectionDto[]> {
    return this.courses.syllabus(courseId);
  }

  @Get('courses/:courseId/teachers')
  @OptionalAuth()
  @CourseRole(...COURSE_RELATIONSHIPS)
  @ApiOperation({
    summary: 'The Owner and Assistants',
    description: 'The Owner first. Same visibility as the course page.',
  })
  @ApiOkResponse({ type: [CourseTeacherDto] })
  teachers(
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<CourseTeacherDto[]> {
    return this.courses.teachers(courseId);
  }

  @Patch('courses/:courseId')
  @CourseRole('OWNER')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Change the course settings',
    description: `${OWNER_ERRORS} A published course must keep a summary and a category (400). The cover must be a COURSE_COVER file you uploaded.`,
  })
  @ApiOkResponse({ type: CourseDetailDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Body() dto: UpdateCourseDto,
  ): Promise<CourseDetailDto> {
    return this.courses.update(user.id, courseId, dto);
  }

  @Put('courses/:courseId/tags')
  @CourseRole('OWNER')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Replace the tags of the course',
    description: `${OWNER_ERRORS} At most 10 distinct tags after normalization.`,
  })
  @ApiOkResponse({ type: [TagRefDto] })
  setTags(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Body() dto: SetTagsDto,
  ): Promise<TagRefDto[]> {
    return this.courses.setTags(user.id, courseId, dto.names);
  }

  @Post('courses/:courseId/publish')
  @HttpCode(200)
  @CourseRole('OWNER')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Publish a draft course',
    description: `${OWNER_ERRORS} Needs a category, a summary and at least one published lesson (409 INVALID_STATE_TRANSITION). The first publication creates the course channel.`,
  })
  @ApiOkResponse({ type: CourseDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<CourseDetailDto> {
    return this.courses.publish(user.id, courseId);
  }

  @Post('courses/:courseId/archive')
  @HttpCode(200)
  @CourseRole('OWNER')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Archive a published course',
    description: `${OWNER_ERRORS} No new enrollments; students keep their data and the channel becomes read-only. There is no way back to draft.`,
  })
  @ApiOkResponse({ type: CourseDetailDto })
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<CourseDetailDto> {
    return this.courses.archive(user.id, courseId);
  }

  @Post('courses/:courseId/restore')
  @HttpCode(200)
  @CourseRole('OWNER')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Restore an archived course to PUBLISHED',
    description:
      'Owner only. A course an Admin locked can only be restored by an Admin: 409 COURSE_ADMIN_LOCKED.',
  })
  @ApiOkResponse({ type: CourseDetailDto })
  restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<CourseDetailDto> {
    return this.courses.restore(user.id, courseId);
  }

  @Delete('courses/:courseId')
  @HttpCode(204)
  @CourseRole('OWNER')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Permanently delete a course that was never published',
    description:
      'Owner only. A course that was ever published can only be archived (409 INVALID_STATE_TRANSITION). Anything still referencing the course makes the foreign keys answer 409.',
  })
  @ApiNoContentResponse()
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<void> {
    await this.courses.delete(user.id, courseId);
  }
}
