import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { TEXT_LIMITS } from '../../../common/constants/limits.js';
import { TextLength } from '../../../common/decorators/index.js';
import { MAX_VIDEO_URL_LENGTH } from '../services/video-url.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const LESSON_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type LessonStatusName = (typeof LESSON_STATUSES)[number];
export const BLOCK_TYPES = ['TEXT', 'VIDEO', 'FILE'] as const;
export type BlockTypeName = (typeof BLOCK_TYPES)[number];
export const MAX_REORDER_ITEMS = 500;

// ---------- requests

export class TitleDto {
  @ApiProperty({
    minLength: TEXT_LIMITS.SECTION_TITLE.min,
    maxLength: TEXT_LIMITS.SECTION_TITLE.max,
  })
  @Transform(trim)
  @TextLength(TEXT_LIMITS.SECTION_TITLE)
  title!: string;
}

export class LessonTitleDto {
  @ApiProperty({
    minLength: TEXT_LIMITS.LESSON_TITLE.min,
    maxLength: TEXT_LIMITS.LESSON_TITLE.max,
  })
  @Transform(trim)
  @TextLength(TEXT_LIMITS.LESSON_TITLE)
  title!: string;
}

export class ReorderDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'The COMPLETE list of ids in the new order. It must contain exactly the ids of the current list; otherwise 409 ORDER_MISMATCH (reload and retry).',
  })
  @IsArray()
  @ArrayMaxSize(MAX_REORDER_ITEMS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class MoveLessonDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'A section of the same course. The lesson goes to the end of it.',
  })
  @IsUUID()
  sectionId!: string;
}

export class CreateBlockDto {
  @ApiProperty({ enum: BLOCK_TYPES })
  @IsIn(BLOCK_TYPES)
  type!: BlockTypeName;

  @ApiPropertyOptional({
    description: 'TEXT only: Markdown source, stored as text.',
    minLength: TEXT_LIMITS.TEXT_BLOCK_BODY.min,
    maxLength: TEXT_LIMITS.TEXT_BLOCK_BODY.max,
  })
  @ValidateIf((o: CreateBlockDto) => o.type === 'TEXT')
  @TextLength(TEXT_LIMITS.TEXT_BLOCK_BODY)
  textBody?: string;

  @ApiPropertyOptional({
    description:
      'VIDEO only: a YouTube or Vimeo link. Only the provider and the video id are kept.',
    maxLength: MAX_VIDEO_URL_LENGTH,
  })
  @ValidateIf((o: CreateBlockDto) => o.type === 'VIDEO')
  @IsString()
  @MaxLength(MAX_VIDEO_URL_LENGTH)
  videoUrl?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'FILE only: a file you uploaded with kind LESSON_ATTACHMENT that no other block uses.',
  })
  @ValidateIf((o: CreateBlockDto) => o.type === 'FILE')
  @IsUUID()
  fileId?: string;
}

export class UpdateBlockDto {
  @ApiPropertyOptional({ description: 'For a TEXT block.' })
  @IsOptional()
  @TextLength(TEXT_LIMITS.TEXT_BLOCK_BODY)
  textBody?: string;

  @ApiPropertyOptional({ description: 'For a VIDEO block.' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_VIDEO_URL_LENGTH)
  videoUrl?: string;
}

// ---------- responses

export class SectionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  position!: number;
}

export class LessonSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  sectionId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  position!: number;

  @ApiProperty({ enum: LESSON_STATUSES })
  status!: LessonStatusName;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  firstPublishedAt!: Date | null;
}

export class BlockVideoDto {
  @ApiProperty({ enum: ['YOUTUBE', 'VIMEO'] })
  provider!: 'YOUTUBE' | 'VIMEO';

  @ApiProperty()
  externalId!: string;

  @ApiProperty({
    description:
      'The player URL, built by the server from the provider and the id.',
  })
  embedUrl!: string;
}

export class BlockFileDto {
  @ApiProperty()
  name!: string;

  @ApiProperty()
  mimeType!: string;

  @ApiProperty()
  sizeBytes!: number;
}

export class ContentBlockDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  position!: number;

  @ApiProperty({ enum: BLOCK_TYPES })
  type!: BlockTypeName;

  @ApiProperty({ nullable: true, type: String })
  textBody!: string | null;

  @ApiProperty({ type: BlockVideoDto, nullable: true })
  video!: BlockVideoDto | null;

  @ApiProperty({
    type: BlockFileDto,
    nullable: true,
    description:
      'Metadata only. Download through GET …/blocks/:blockId/download, which signs a short-lived link on every request.',
  })
  file!: BlockFileDto | null;
}

/** A lesson as a teacher sees it: every status, with the lifecycle fields. */
export class LessonTeacherDto extends LessonSummaryDto {
  @ApiProperty({ type: [ContentBlockDto] })
  blocks!: ContentBlockDto[];
}

/** A lesson as an ACTIVE student sees it: published lessons only, no lifecycle fields. */
export class LessonStudentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  sectionId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  position!: number;

  @ApiProperty({ type: [ContentBlockDto] })
  blocks!: ContentBlockDto[];
}

export class OutlineLessonDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  position!: number;

  @ApiPropertyOptional({
    enum: LESSON_STATUSES,
    description: 'Teachers only.',
  })
  status?: LessonStatusName;

  @ApiPropertyOptional({ description: 'Teachers only.' })
  blockCount?: number;
}

export class OutlineSectionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  position!: number;

  @ApiProperty({ type: [OutlineLessonDto] })
  lessons!: OutlineLessonDto[];
}

export class OutlineDto {
  @ApiProperty({ type: [OutlineSectionDto] })
  sections!: OutlineSectionDto[];
}

export class SyllabusLessonDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;
}

export class SyllabusSectionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ type: [SyllabusLessonDto] })
  lessons!: SyllabusLessonDto[];
}
