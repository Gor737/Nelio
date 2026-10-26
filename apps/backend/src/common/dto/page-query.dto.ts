import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { COUNT_LIMITS } from '../constants/limits.js';

/** Offset pagination of the lists that are not cursor lists (docs/architecture.md section 13): `page` from 1, `pageSize` at most 50. */
export class PageQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: COUNT_LIMITS.PAGE_SIZE_MAX,
    default: COUNT_LIMITS.PAGE_SIZE_DEFAULT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COUNT_LIMITS.PAGE_SIZE_MAX)
  pageSize?: number;
}

export interface PageWindow {
  readonly page: number;
  readonly pageSize: number;
  readonly offset: number;
}

/** The effective page, page size and SQL offset of a validated query. */
export function pageWindow(query: PageQueryDto): PageWindow {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? COUNT_LIMITS.PAGE_SIZE_DEFAULT;
  return { page, pageSize, offset: (page - 1) * pageSize };
}
