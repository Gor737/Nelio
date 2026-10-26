import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/index.js';
import { CategoryDto, TagDto, TagSearchQueryDto } from '../dto/catalog.dto.js';
import { CatalogService } from '../services/catalog.service.js';

/**
 * Both reads are public: the public catalog (published courses, filters) is browsed without an account (docs/architecture.md section 12),
 * and the lists contain nothing but names. Writing tags happens through a course (Courses -> `setCourseTags`); categories are Admin-managed (M12).
 */
@ApiTags('Catalog')
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  @Public()
  @ApiOperation({
    summary: 'List all categories',
    description:
      'Public. Sorted by name; not paginated (the list is managed by Admins and small).',
  })
  @ApiOkResponse({ type: [CategoryDto] })
  categories(): Promise<CategoryDto[]> {
    return this.catalog.listCategories();
  }

  @Get('tags')
  @Public()
  @ApiOperation({
    summary: 'Tag autocomplete',
    description:
      'Public. Tags that start with `q` (all tags when `q` is omitted), the most used first, at most 20 (`limit` can lower it).',
  })
  @ApiOkResponse({ type: [TagDto] })
  tags(@Query() query: TagSearchQueryDto): Promise<TagDto[]> {
    return this.catalog.searchTags(query.q, query.limit);
  }
}
