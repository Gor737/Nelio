import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { COUNT_LIMITS, TEXT_LIMITS } from '../../../common/constants/limits.js';
import { TextLength } from '../../../common/decorators/index.js';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const ADMIN_ROLES = ['STUDENT', 'TEACHER', 'ADMIN'] as const;
export type AdminRoleName = (typeof ADMIN_ROLES)[number];
export const ROLE_STATUSES = [
  'PENDING',
  'ACTIVE',
  'REJECTED',
  'REVOKED',
] as const;
export type RoleStatusName = (typeof ROLE_STATUSES)[number];
export const ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type AccountStatusName = (typeof ACCOUNT_STATUSES)[number];

// ---------- requests

/** A note on a decision (Teacher application, revocation, suspension reason). */
export class DecisionNoteDto {
  @ApiPropertyOptional({
    minLength: TEXT_LIMITS.DECISION_NOTE.min,
    maxLength: TEXT_LIMITS.DECISION_NOTE.max,
  })
  @IsOptional()
  @Transform(trim)
  @TextLength(TEXT_LIMITS.DECISION_NOTE)
  note?: string;
}

export class SuspendUserDto {
  @ApiPropertyOptional({
    minLength: TEXT_LIMITS.DECISION_NOTE.min,
    maxLength: TEXT_LIMITS.DECISION_NOTE.max,
    description: 'Kept in the audit row; not shown to the user.',
  })
  @IsOptional()
  @Transform(trim)
  @TextLength(TEXT_LIMITS.DECISION_NOTE)
  reason?: string;
}

export class AdminUsersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    description:
      'Part of the name or the start of the email (at least 2 characters).',
  })
  @IsOptional()
  @Transform(trim)
  @TextLength({ min: 2, max: 100 })
  q?: string;

  @ApiPropertyOptional({
    enum: ADMIN_ROLES,
    description: 'Holds this role ACTIVE.',
  })
  @IsOptional()
  @IsIn(ADMIN_ROLES)
  role?: AdminRoleName;

  @ApiPropertyOptional({ enum: ACCOUNT_STATUSES })
  @IsOptional()
  @IsIn(ACCOUNT_STATUSES)
  status?: AccountStatusName;
}

export class ApplicationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ROLE_STATUSES, default: 'PENDING' })
  @IsOptional()
  @IsIn(ROLE_STATUSES)
  status?: RoleStatusName;
}

export class TransferOwnershipDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'An ACTIVE Teacher: an Assistant of the course or any other Teacher who is not a student of it. The old Owner becomes an Assistant.',
  })
  @IsUUID()
  newOwnerId!: string;
}

export class CategoryInputDto {
  @ApiProperty({
    minLength: TEXT_LIMITS.CATEGORY_NAME.min,
    maxLength: TEXT_LIMITS.CATEGORY_NAME.max,
  })
  @IsString()
  name!: string;
}

export class MergeTagDto {
  @ApiProperty({
    format: 'uuid',
    description: 'The tag that remains. The tag in the URL is deleted.',
  })
  @IsUUID()
  targetTagId!: string;
}

export class AdminTagsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Start of the tag name.' })
  @IsOptional()
  @TextLength({ min: 1, max: TEXT_LIMITS.TAG_NAME.max })
  q?: string;
}

export class ActionReportDto {
  @ApiPropertyOptional({
    minLength: TEXT_LIMITS.REPORT_RESOLUTION_NOTE.min,
    maxLength: TEXT_LIMITS.REPORT_RESOLUTION_NOTE.max,
  })
  @IsOptional()
  @Transform(trim)
  @TextLength(TEXT_LIMITS.REPORT_RESOLUTION_NOTE)
  note?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Delete the reported message (message reports only). Every OPEN report about that message is closed together with this one.',
  })
  @IsOptional()
  @IsBoolean()
  deleteMessage?: boolean;
}

export class AuditLogQueryDto {
  @ApiPropertyOptional({
    description: 'The `nextCursor` of the previous page. Newest first.',
  })
  @IsOptional()
  @IsUUID()
  cursor?: string;

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
  limit?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({
    description: 'One of the audit action names, e.g. USER_SUSPENDED.',
  })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({
    description: 'USER, COURSE, MESSAGE, REPORT, CATEGORY or TAG.',
  })
  @IsOptional()
  @IsString()
  targetType?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  targetId?: string;
}

// ---------- responses

export class AdminRoleRowDto {
  @ApiProperty({ enum: ADMIN_ROLES }) role!: AdminRoleName;
  @ApiProperty({ enum: ROLE_STATUSES }) status!: RoleStatusName;
}

export class AdminUserItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ enum: ACCOUNT_STATUSES }) status!: AccountStatusName;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  suspendedAt!: Date | null;
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty({ type: () => [AdminRoleRowDto] }) roles!: AdminRoleRowDto[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

export class AdminUsersPageDto {
  @ApiProperty({ type: () => [AdminUserItemDto] }) items!: AdminUserItemDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

export class AdminUserDetailDto extends AdminUserItemDto {
  @ApiProperty({ description: 'Courses this user owns, in any status.' })
  ownedCourses!: number;
  @ApiProperty({ description: 'Courses this user assists.' })
  assistedCourses!: number;
  @ApiProperty({ description: 'ACTIVE or PENDING enrollments.' })
  enrollments!: number;
  @ApiProperty({ description: 'Has a password.' }) hasPassword!: boolean;
  @ApiProperty({ description: 'Has a linked Google account.' })
  hasGoogle!: boolean;
}

export class TeacherApplicationItemDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ROLE_STATUSES }) status!: RoleStatusName;
  @ApiProperty({ type: String, nullable: true }) message!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) appliedAt!: Date;
  @ApiProperty({ type: String, nullable: true }) decisionNote!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  decidedBy!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt!: Date | null;
}

export class TeacherApplicationsPageDto {
  @ApiProperty({ type: () => [TeacherApplicationItemDto] })
  items!: TeacherApplicationItemDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

export class AdminCategoryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
}

export class AdminTagDto extends AdminCategoryDto {
  @ApiProperty({ description: 'Courses that carry the tag.' })
  courseCount!: number;
}

export class AdminTagsPageDto {
  @ApiProperty({ type: () => [AdminTagDto] }) items!: AdminTagDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

export class TagMergeResultDto {
  @ApiProperty({ format: 'uuid' }) sourceId!: string;
  @ApiProperty({ format: 'uuid' }) targetId!: string;
  @ApiProperty({ description: 'Courses that now carry the target tag.' })
  moved!: number;
  @ApiProperty({
    description:
      'Courses that already carried the target tag (their old link was dropped).',
  })
  alreadyTagged!: number;
}

export class AuditActorDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
}

export class AuditLogItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: () => AuditActorDto }) actor!: AuditActorDto;
  @ApiProperty() action!: string;
  @ApiProperty() targetType!: string;
  @ApiProperty({ format: 'uuid' }) targetId!: string;
  @ApiProperty({ type: 'object', additionalProperties: true })
  metadata!: Record<string, unknown>;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

export class AuditLogPageDto {
  @ApiProperty({ type: () => [AuditLogItemDto] }) items!: AuditLogItemDto[];
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Pass it as `cursor` for the next (older) page; null on the last page.',
  })
  nextCursor!: string | null;
}

export class StatsDto {
  @ApiProperty({ type: 'object', additionalProperties: { type: 'integer' } })
  users!: { total: number; active: number; suspended: number };
  @ApiProperty({ type: 'object', additionalProperties: { type: 'integer' } })
  roles!: {
    activeTeachers: number;
    pendingApplications: number;
    activeAdmins: number;
  };
  @ApiProperty({ type: 'object', additionalProperties: { type: 'integer' } })
  courses!: {
    draft: number;
    published: number;
    archived: number;
    locked: number;
  };
  @ApiProperty({ type: 'object', additionalProperties: { type: 'integer' } })
  enrollments!: { active: number; pending: number };
  @ApiProperty({ type: 'object', additionalProperties: { type: 'integer' } })
  reports!: { open: number };
}
