import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { COUNT_LIMITS, TEXT_LIMITS } from '../../../common/constants/limits.js';
import { TextLength, textLengthApi } from '../../../common/decorators/index.js';

/** A search prefix is 1 to TAG_NAME.max characters (it may be shorter than a tag name: it is being typed). */
const PREFIX_LIMIT = { min: 1, max: TEXT_LIMITS.TAG_NAME.max } as const;

export class CategoryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Programming' })
  name!: string;

  @ApiProperty({ example: 'programming' })
  slug!: string;
}

export class TagDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    example: 'web development',
    description: 'Normalized: lowercase, single spaces.',
  })
  name!: string;

  @ApiProperty({
    example: 'web-development',
    description: 'The name with hyphens instead of spaces; unique.',
  })
  slug!: string;
}

export class TagSearchQueryDto {
  @ApiPropertyOptional({
    ...textLengthApi(PREFIX_LIMIT),
    description:
      'Start of a tag name. Case, accents composition and extra spaces do not matter; `%` and `_` are literal characters.',
  })
  @IsOptional()
  @TextLength(PREFIX_LIMIT)
  q?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: COUNT_LIMITS.TAG_AUTOCOMPLETE_MAX_RESULTS,
    default: COUNT_LIMITS.TAG_AUTOCOMPLETE_MAX_RESULTS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COUNT_LIMITS.TAG_AUTOCOMPLETE_MAX_RESULTS)
  limit?: number;
}
