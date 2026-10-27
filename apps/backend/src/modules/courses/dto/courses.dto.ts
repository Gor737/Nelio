import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { COUNT_LIMITS, TEXT_LIMITS } from '../../../common/constants/limits.js';
import { COURSE_RELATIONSHIPS } from '../../../common/constants/permission-matrix.js';
import type { CourseRelationship } from '../../../common/constants/permission-matrix.js';
import { TextLength } from '../../../common/decorators/index.js';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const ENROLLMENT_POLICIES = [
  'OPEN',
  'APPROVAL_REQUIRED',
  'INVITATION_ONLY',
] as const;
export type EnrollmentPolicyName = (typeof ENROLLMENT_POLICIES)[number];
export const COURSE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type CourseStatusName = (typeof COURSE_STATUSES)[number];

// ---------- requests

export class CreateCourseDto {
  @ApiProperty({
    minLength: TEXT_LIMITS.COURSE_TITLE.min,
    maxLength: TEXT_LIMITS.COURSE_TITLE.max,
  })
  @Transform(trim)
  @TextLength(TEXT_LIMITS.COURSE_TITLE)
  title!: string;

  @ApiProperty({
    enum: ENROLLMENT_POLICIES,
    description:
      'REQUIRED. There is no default: a missing or unknown value is 400. OPEN: anyone can enroll. APPROVAL_REQUIRED: a teacher approves each request. INVITATION_ONLY: only invited people can enroll, and the course is not listed in the catalog.',
  })
  @IsIn(ENROLLMENT_POLICIES)
  enrollmentPolicy!: EnrollmentPolicyName;

  @ApiPropertyOptional({
    minLength: TEXT_LIMITS.COURSE_SUMMARY.min,
    maxLength: TEXT_LIMITS.COURSE_SUMMARY.max,
  })
  @IsOptional()
  @Transform(trim)
  @TextLength(TEXT_LIMITS.COURSE_SUMMARY)
  summary?: string;

  @ApiPropertyOptional({ maxLength: TEXT_LIMITS.COURSE_DESCRIPTION.max })
  @IsOptional()
  @TextLength(TEXT_LIMITS.COURSE_DESCRIPTION)
  description?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

export class UpdateCourseDto {
  @ApiPropertyOptional({
    minLength: TEXT_LIMITS.COURSE_TITLE.min,
    maxLength: TEXT_LIMITS.COURSE_TITLE.max,
  })
  @IsOptional()
  @Transform(trim)
  @TextLength(TEXT_LIMITS.COURSE_TITLE)
  title?: string;

  @ApiPropertyOptional({ enum: ENROLLMENT_POLICIES })
  @IsOptional()
  @IsIn(ENROLLMENT_POLICIES)
  enrollmentPolicy?: EnrollmentPolicyName;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'null clears it; a published course must keep one.',
  })
  @IsOptional()
  @Transform(trim)
  @TextLength(TEXT_LIMITS.COURSE_SUMMARY)
  summary?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @TextLength(TEXT_LIMITS.COURSE_DESCRIPTION)
  description?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'null clears it; a published course must keep one.',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'A COURSE_COVER file you uploaded, or null to remove the cover.',
  })
  @IsOptional()
  @IsUUID()
  coverFileId?: string | null;
}

export class SetTagsDto {
  @ApiProperty({
    type: [String],
    description: `The complete list of tag names (at most ${COUNT_LIMITS.TAGS_PER_COURSE_MAX} after normalization). Names are normalized (case, spacing, Unicode form) and new ones are created.`,
  })
  @IsArray()
  @ArrayMaxSize(COUNT_LIMITS.TAGS_PER_COURSE_MAX * 3)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  names!: string[];
}

export class UserRefDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;
}

export const CATALOG_SORTS = ['relevance', 'newest', 'title'] as const;
export class CatalogQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Words to search for in the title, summary and description (any language). The last word also matches as a prefix.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'A tag slug.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  tag?: string;

  @ApiPropertyOptional({ enum: ['OPEN', 'APPROVAL_REQUIRED'] })
  @IsOptional()
  @IsIn(['OPEN', 'APPROVAL_REQUIRED'])
  enrollmentPolicy?: 'OPEN' | 'APPROVAL_REQUIRED';

  @ApiPropertyOptional({
    enum: CATALOG_SORTS,
    description:
      '`relevance` (the default when `q` is given) ranks matches; otherwise the newest published course is first.',
  })
  @IsOptional()
  @IsIn(CATALOG_SORTS)
  sort?: (typeof CATALOG_SORTS)[number];
}

// ---------- responses

export class CategoryRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;
}

export class TagRefDto extends CategoryRefDto {}

export class PersonRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ nullable: true, type: String })
  avatarUrl!: string | null;
}

export class CourseCardDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true, type: String })
  summary!: string | null;

  @ApiProperty({ nullable: true, type: String })
  coverUrl!: string | null;

  @ApiProperty({ type: CategoryRefDto, nullable: true })
  category!: CategoryRefDto | null;

  @ApiProperty({ type: [TagRefDto] })
  tags!: TagRefDto[];

  @ApiProperty({ enum: ENROLLMENT_POLICIES })
  enrollmentPolicy!: EnrollmentPolicyName;

  @ApiProperty({ type: PersonRefDto })
  owner!: PersonRefDto;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  firstPublishedAt!: Date | null;
}

export class CatalogPageDto {
  @ApiProperty({ type: [CourseCardDto] })
  items!: CourseCardDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;
}

export class ViewerDto {
  @ApiProperty({
    enum: COURSE_RELATIONSHIPS,
    description:
      'What the caller is to this course (NONE for an anonymous visitor).',
  })
  relationship!: CourseRelationship;
}

export class CourseDetailDto extends CourseCardDto {
  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ enum: COURSE_STATUSES })
  status!: CourseStatusName;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  archivedAt!: Date | null;

  @ApiPropertyOptional({
    description:
      'Teachers only: an Admin locked the course (only an Admin can restore it).',
  })
  lockedByAdmin?: boolean;

  @ApiProperty({ type: ViewerDto })
  viewer!: ViewerDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class CourseTeacherDto extends PersonRefDto {
  @ApiProperty({ enum: ['OWNER', 'ASSISTANT'] })
  role!: 'OWNER' | 'ASSISTANT';
}

export class TeachingCourseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ enum: COURSE_STATUSES })
  status!: CourseStatusName;

  @ApiProperty({ enum: ['OWNER', 'ASSISTANT'] })
  role!: 'OWNER' | 'ASSISTANT';

  @ApiProperty({ enum: ENROLLMENT_POLICIES })
  enrollmentPolicy!: EnrollmentPolicyName;

  @ApiProperty({ nullable: true, type: String })
  coverUrl!: string | null;

  @ApiProperty()
  lockedByAdmin!: boolean;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  firstPublishedAt!: Date | null;
}

export class TeachingCoursesPageDto {
  @ApiProperty({ type: [TeachingCourseDto] })
  items!: TeachingCourseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;
}
