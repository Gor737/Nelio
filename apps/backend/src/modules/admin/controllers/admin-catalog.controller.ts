import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
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
import { CurrentUser, Roles } from '../../../common/decorators/index.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import {
  AdminCategoryDto,
  AdminTagsPageDto,
  AdminTagsQueryDto,
  CategoryInputDto,
  MergeTagDto,
  TagMergeResultDto,
} from '../dto/admin.dto.js';
import { AdminCatalogService } from '../services/admin-catalog.service.js';

const ADMIN_ONLY = 'Admins only: 403 FORBIDDEN for anyone else.';

/** Categories (create, rename, delete) and tags (usage list, merge). */
@ApiTags('Admin')
@ApiBearerAuth('access-token')
@Roles('ADMIN')
@Controller('admin')
export class AdminCatalogController {
  constructor(private readonly catalog: AdminCatalogService) {}

  @Get('categories')
  @ApiOperation({
    summary: 'List categories',
    description: `The same list as the public one. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: [AdminCategoryDto] })
  categories(): Promise<AdminCategoryDto[]> {
    return this.catalog.categories();
  }

  @Post('categories')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a category',
    description: `The slug is made from the name; two names with the same slug are one category (409 RESOURCE_CONFLICT). ${ADMIN_ONLY}`,
  })
  @ApiCreatedResponse({ type: AdminCategoryDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  createCategory(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: CategoryInputDto,
  ): Promise<AdminCategoryDto> {
    return this.catalog.createCategory(admin.id, dto.name);
  }

  @Patch('categories/:categoryId')
  @ApiOperation({ summary: 'Rename a category', description: ADMIN_ONLY })
  @ApiOkResponse({ type: AdminCategoryDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  renameCategory(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('categoryId', ParseUuidPipe) categoryId: string,
    @Body() dto: CategoryInputDto,
  ): Promise<AdminCategoryDto> {
    return this.catalog.renameCategory(admin.id, categoryId, dto.name);
  }

  @Delete('categories/:categoryId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a category',
    description: `409 RESOURCE_CONFLICT while a course still uses it. ${ADMIN_ONLY}`,
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ErrorResponseDto })
  async deleteCategory(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('categoryId', ParseUuidPipe) categoryId: string,
  ): Promise<void> {
    await this.catalog.deleteCategory(admin.id, categoryId);
  }

  @Get('tags')
  @ApiOperation({
    summary: 'Tags with their course counts',
    description: `Most used first; \`q\` is the start of the tag name. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: AdminTagsPageDto })
  tags(@Query() query: AdminTagsQueryDto): Promise<AdminTagsPageDto> {
    return this.catalog.tags(query);
  }

  @Post('tags/:tagId/merge')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Merge a tag into another',
    description: `Every course with the tag in the URL gets \`targetTagId\` (a course that already has it keeps one link), then the tag in the URL is deleted. A tag cannot be merged into itself (400). A course owner tagging the source at the same instant may get a 409 and retry. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: TagMergeResultDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  merge(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('tagId', ParseUuidPipe) tagId: string,
    @Body() dto: MergeTagDto,
  ): Promise<TagMergeResultDto> {
    return this.catalog.mergeTags(admin.id, tagId, dto.targetTagId);
  }
}
