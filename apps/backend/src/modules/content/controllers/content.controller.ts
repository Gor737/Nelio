import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { CourseAccess } from '../../../common/access/index.js';
import {
  CourseRole,
  CurrentCourseAccess,
  CurrentUser,
} from '../../../common/decorators/index.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import { SignedUrlDto } from '../../files/index.js';
import {
  ContentBlockDto,
  CreateBlockDto,
  LessonStudentDto,
  LessonSummaryDto,
  LessonTeacherDto,
  LessonTitleDto,
  MoveLessonDto,
  OutlineDto,
  ReorderDto,
  SectionDto,
  TitleDto,
  UpdateBlockDto,
} from '../dto/content.dto.js';
import { BlocksService } from '../services/blocks.service.js';
import { LessonsService } from '../services/lessons.service.js';
import { OutlineService } from '../services/outline.service.js';
import { SectionsService } from '../services/sections.service.js';

const TEACHER_ERRORS =
  'Every change is 409 COURSE_ADMIN_LOCKED while an Admin has locked the course, and 409 COURSE_ARCHIVED on an archived course.';

/**
 * Course content (Decisions 48, 66, 67, 69, 122): the outline, sections, lessons and blocks of `/courses/:courseId`. Reading is for the
 * Owner, Assistants and ACTIVE students (a student sees published lessons only); every change is for the Owner and Assistants.
 */
@ApiTags('Content')
@ApiBearerAuth('access-token')
@ApiExtraModels(LessonTeacherDto, LessonStudentDto)
@Controller('courses/:courseId')
export class ContentController {
  constructor(
    private readonly outline: OutlineService,
    private readonly sections: SectionsService,
    private readonly lessons: LessonsService,
    private readonly blocks: BlocksService,
  ) {}

  // ---------- outline

  @Get('outline')
  @CourseRole('OWNER', 'ASSISTANT', 'STUDENT_ACTIVE')
  @ApiOperation({
    summary: 'Sections and lessons of the course',
    description:
      'Teachers: every lesson with its status and block count. An ACTIVE student: published lessons only, no status; sections without a published lesson are left out. The public syllabus for visitors is part of the course endpoints.',
  })
  @ApiOkResponse({ type: OutlineDto })
  getOutline(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @CurrentCourseAccess() access: CourseAccess,
  ): Promise<OutlineDto> {
    return this.outline.outline(courseId, access.relationship);
  }

  // ---------- sections

  @Post('sections')
  @HttpCode(201)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Add a section at the end',
    description: TEACHER_ERRORS,
  })
  @ApiCreatedResponse({ type: SectionDto })
  createSection(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Body() dto: TitleDto,
  ): Promise<SectionDto> {
    return this.sections.create(courseId, dto.title);
  }

  @Post('sections/reorder')
  @HttpCode(204)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Reorder the sections',
    description: `Send the complete list of section ids in the new order; a stale list is 409 ORDER_MISMATCH. ${TEACHER_ERRORS}`,
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto })
  async reorderSections(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Body() dto: ReorderDto,
  ): Promise<void> {
    await this.sections.reorder(courseId, dto.ids);
  }

  @Patch('sections/:sectionId')
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({ summary: 'Rename a section', description: TEACHER_ERRORS })
  @ApiOkResponse({ type: SectionDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  renameSection(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('sectionId', ParseUuidPipe) sectionId: string,
    @Body() dto: TitleDto,
  ): Promise<SectionDto> {
    return this.sections.rename(courseId, sectionId, dto.title);
  }

  @Delete('sections/:sectionId')
  @HttpCode(204)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Delete an empty section',
    description: `A section that still has lessons is 409 RESOURCE_CONFLICT. ${TEACHER_ERRORS}`,
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async deleteSection(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('sectionId', ParseUuidPipe) sectionId: string,
  ): Promise<void> {
    await this.sections.delete(courseId, sectionId);
  }

  // ---------- lessons

  @Post('sections/:sectionId/lessons')
  @HttpCode(201)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Add a draft lesson at the end of a section',
    description: TEACHER_ERRORS,
  })
  @ApiCreatedResponse({ type: LessonSummaryDto })
  createLesson(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('sectionId', ParseUuidPipe) sectionId: string,
    @Body() dto: LessonTitleDto,
  ): Promise<LessonSummaryDto> {
    return this.lessons.create(courseId, sectionId, dto.title);
  }

  @Post('sections/:sectionId/lessons/reorder')
  @HttpCode(204)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Reorder the lessons of a section',
    description: `Send the complete list of the section's lesson ids in the new order; a stale list is 409 ORDER_MISMATCH. ${TEACHER_ERRORS}`,
  })
  @ApiNoContentResponse()
  async reorderLessons(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('sectionId', ParseUuidPipe) sectionId: string,
    @Body() dto: ReorderDto,
  ): Promise<void> {
    await this.lessons.reorder(courseId, sectionId, dto.ids);
  }

  @Get('lessons/:lessonId')
  @CourseRole('OWNER', 'ASSISTANT', 'STUDENT_ACTIVE')
  @ApiOperation({
    summary: 'A lesson with its blocks',
    description:
      'Teachers see any status, with the lifecycle fields. An ACTIVE student gets only a published lesson (404 otherwise, also on an archived course) and no lifecycle fields.',
  })
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(LessonTeacherDto) },
        { $ref: getSchemaPath(LessonStudentDto) },
      ],
    },
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  getLesson(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
    @CurrentCourseAccess() access: CourseAccess,
  ): Promise<LessonTeacherDto | LessonStudentDto> {
    return this.lessons.get(courseId, lessonId, access.relationship);
  }

  @Patch('lessons/:lessonId')
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({ summary: 'Rename a lesson', description: TEACHER_ERRORS })
  @ApiOkResponse({ type: LessonSummaryDto })
  renameLesson(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
    @Body() dto: LessonTitleDto,
  ): Promise<LessonSummaryDto> {
    return this.lessons.rename(courseId, lessonId, dto.title);
  }

  @Post('lessons/:lessonId/move')
  @HttpCode(200)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Move a lesson to the end of another section of this course',
    description: `A section of another course is 404. ${TEACHER_ERRORS}`,
  })
  @ApiOkResponse({ type: LessonSummaryDto })
  moveLesson(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
    @Body() dto: MoveLessonDto,
  ): Promise<LessonSummaryDto> {
    return this.lessons.move(courseId, lessonId, dto.sectionId);
  }

  @Post('lessons/:lessonId/publish')
  @HttpCode(200)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Publish a lesson (DRAFT or ARCHIVED to PUBLISHED)',
    description: `Needs at least one block. The first publication notifies the active students. ${TEACHER_ERRORS}`,
  })
  @ApiOkResponse({ type: LessonSummaryDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'INVALID_STATE_TRANSITION',
  })
  publish(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
  ): Promise<LessonSummaryDto> {
    return this.lessons.publish(courseId, lessonId);
  }

  @Post('lessons/:lessonId/unpublish')
  @HttpCode(200)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Unpublish a lesson (PUBLISHED to DRAFT)',
    description: `Students lose access immediately; course completion is re-checked in the same transaction. ${TEACHER_ERRORS}`,
  })
  @ApiOkResponse({ type: LessonSummaryDto })
  unpublish(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
  ): Promise<LessonSummaryDto> {
    return this.lessons.unpublish(courseId, lessonId);
  }

  @Post('lessons/:lessonId/archive')
  @HttpCode(200)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Archive a lesson (PUBLISHED to ARCHIVED)',
    description: `Course completion is re-checked in the same transaction. ${TEACHER_ERRORS}`,
  })
  @ApiOkResponse({ type: LessonSummaryDto })
  archive(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
  ): Promise<LessonSummaryDto> {
    return this.lessons.archive(courseId, lessonId);
  }

  @Delete('lessons/:lessonId')
  @HttpCode(204)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Permanently delete a lesson',
    description: `Only a lesson that is not published, was never published and has no completions; otherwise 409 INVALID_STATE_TRANSITION (archive it instead). ${TEACHER_ERRORS}`,
  })
  @ApiNoContentResponse()
  async deleteLesson(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
  ): Promise<void> {
    await this.lessons.delete(courseId, lessonId);
  }

  // ---------- blocks

  @Post('lessons/:lessonId/blocks')
  @HttpCode(201)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Add a block at the end of a lesson',
    description: `TEXT needs textBody (Markdown); VIDEO needs videoUrl (YouTube or Vimeo only); FILE needs fileId (your own LESSON_ATTACHMENT, used by no other block). ${TEACHER_ERRORS}`,
  })
  @ApiCreatedResponse({ type: ContentBlockDto })
  createBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
    @Body() dto: CreateBlockDto,
  ): Promise<ContentBlockDto> {
    return this.blocks.create(courseId, lessonId, user.id, dto);
  }

  @Post('lessons/:lessonId/blocks/reorder')
  @HttpCode(204)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Reorder the blocks of a lesson',
    description: `Send the complete list of block ids in the new order; a stale list is 409 ORDER_MISMATCH. ${TEACHER_ERRORS}`,
  })
  @ApiNoContentResponse()
  async reorderBlocks(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
    @Body() dto: ReorderDto,
  ): Promise<void> {
    await this.blocks.reorder(courseId, lessonId, dto.ids);
  }

  @Patch('lessons/:lessonId/blocks/:blockId')
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({
    summary: 'Change a text or video block',
    description: `A file block cannot be changed. ${TEACHER_ERRORS}`,
  })
  @ApiOkResponse({ type: ContentBlockDto })
  updateBlock(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
    @Param('blockId', ParseUuidPipe) blockId: string,
    @Body() dto: UpdateBlockDto,
  ): Promise<ContentBlockDto> {
    return this.blocks.update(courseId, lessonId, blockId, dto);
  }

  @Delete('lessons/:lessonId/blocks/:blockId')
  @HttpCode(204)
  @CourseRole('OWNER', 'ASSISTANT')
  @ApiOperation({ summary: 'Delete a block', description: TEACHER_ERRORS })
  @ApiNoContentResponse()
  async deleteBlock(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
    @Param('blockId', ParseUuidPipe) blockId: string,
  ): Promise<void> {
    await this.blocks.delete(courseId, lessonId, blockId);
  }

  @Get('lessons/:lessonId/blocks/:blockId/download')
  @CourseRole('OWNER', 'ASSISTANT', 'STUDENT_ACTIVE')
  @ApiOperation({
    summary: 'A short-lived download link for a file block',
    description:
      'Signed on every request after re-checking that the caller may see the lesson: a student gets 404 for a lesson that is not published.',
  })
  @ApiOkResponse({ type: SignedUrlDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  download(
    @Param('courseId', ParseUuidPipe) courseId: string,
    @Param('lessonId', ParseUuidPipe) lessonId: string,
    @Param('blockId', ParseUuidPipe) blockId: string,
    @CurrentCourseAccess() access: CourseAccess,
  ): Promise<SignedUrlDto> {
    return this.blocks.download(
      courseId,
      lessonId,
      blockId,
      access.relationship,
    );
  }
}
