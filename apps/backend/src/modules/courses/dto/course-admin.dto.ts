import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { TEXT_LIMITS } from '../../../common/constants/limits.js';
import { TextLength } from '../../../common/decorators/index.js';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import {
  COURSE_STATUSES,
  CategoryRefDto,
  CourseTeacherDto,
  type CourseStatusName,
  ENROLLMENT_POLICIES,
  type EnrollmentPolicyName,
  PersonRefDto,
} from './courses.dto.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** The Admin course list: every status, locked or not (Decision 133). */
export class AdminCoursesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    description:
      'Words of the title (case-insensitive, any part of the title).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: COURSE_STATUSES })
  @IsOptional()
  @IsIn(COURSE_STATUSES)
  status?: CourseStatusName;

  @ApiPropertyOptional({ enum: ENROLLMENT_POLICIES })
  @IsOptional()
  @IsIn(ENROLLMENT_POLICIES)
  enrollmentPolicy?: EnrollmentPolicyName;

  @ApiPropertyOptional({
    description: 'true: only locked; false: only not locked.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  locked?: boolean;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Courses of this teacher (Owner or Assistant).',
  })
  @IsOptional()
  @IsUUID()
  teacherId?: string;
}

export class LockCourseDto {
  @ApiProperty({
    minLength: TEXT_LIMITS.ADMIN_LOCK_REASON.min,
    maxLength: TEXT_LIMITS.ADMIN_LOCK_REASON.max,
    description:
      'Shown to the Owner and the Assistants in the COURSE_ADMIN_LOCKED notification and kept in the audit row.',
  })
  @Transform(trim)
  @TextLength(TEXT_LIMITS.ADMIN_LOCK_REASON)
  reason!: string;
}

export class AdminCourseItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: COURSE_STATUSES }) status!: CourseStatusName;
  @ApiProperty({ enum: ENROLLMENT_POLICIES })
  enrollmentPolicy!: EnrollmentPolicyName;
  @ApiProperty({ type: () => CategoryRefDto, nullable: true })
  category!: CategoryRefDto | null;
  @ApiProperty({ type: () => PersonRefDto }) owner!: PersonRefDto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lockedByAdminAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  firstPublishedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ description: 'Students with an ACTIVE enrollment.' })
  activeStudents!: number;
}

export class AdminCoursesPageDto {
  @ApiProperty({ type: () => [AdminCourseItemDto] })
  items!: AdminCourseItemDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

export class AdminCourseDetailDto extends AdminCourseItemDto {
  @ApiProperty({ type: String, nullable: true }) summary!: string | null;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ type: () => [CourseTeacherDto] })
  teachers!: CourseTeacherDto[];
}
