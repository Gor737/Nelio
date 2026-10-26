import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsUUID } from 'class-validator';
import { COUNT_LIMITS, TEXT_LIMITS } from '../../../common/constants/limits.js';
import { TextLength } from '../../../common/decorators/index.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const ROLE_NAMES = ['STUDENT', 'TEACHER', 'ADMIN'] as const;
export const ROLE_STATUSES = [
  'PENDING',
  'ACTIVE',
  'REJECTED',
  'REVOKED',
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];
export type RoleStatusName = (typeof ROLE_STATUSES)[number];

export class RoleStateDto {
  @ApiProperty({ enum: ROLE_NAMES })
  role!: RoleName;

  @ApiProperty({ enum: ROLE_STATUSES })
  status!: RoleStatusName;
}

/** The caller's own account. The only user response that contains the email address (Decision 31). */
export class MeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ nullable: true, type: String })
  avatarUrl!: string | null;

  @ApiProperty({
    type: [RoleStateDto],
    description:
      'Every role row of the account with its state. Only ACTIVE roles grant anything.',
  })
  roles!: RoleStateDto[];

  @ApiProperty()
  emailVerified!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class UpdateMeDto {
  @ApiPropertyOptional({
    minLength: TEXT_LIMITS.USER_FULL_NAME.min,
    maxLength: TEXT_LIMITS.USER_FULL_NAME.max,
  })
  @IsOptional()
  @Transform(trim)
  @TextLength(TEXT_LIMITS.USER_FULL_NAME)
  fullName?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'The id of a file you uploaded with kind AVATAR, or null to remove the avatar.',
  })
  @IsOptional()
  @IsUUID()
  avatarFileId?: string | null;
}

/** What anybody who is signed in may see of another user. Never the email address. */
export class UserSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ nullable: true, type: String })
  avatarUrl!: string | null;
}

export class UserSearchQueryDto {
  @ApiProperty({
    minLength: COUNT_LIMITS.USER_SEARCH_MIN_QUERY_LENGTH,
    maxLength: TEXT_LIMITS.USER_FULL_NAME.max,
    description: 'Part of the name; at least 2 characters after trimming.',
  })
  @Transform(trim)
  @TextLength({
    min: COUNT_LIMITS.USER_SEARCH_MIN_QUERY_LENGTH,
    max: TEXT_LIMITS.USER_FULL_NAME.max,
  })
  q!: string;
}

export const APPLICATION_STATUSES = [
  'NONE',
  'PENDING',
  'ACTIVE',
  'REJECTED',
  'REVOKED',
] as const;
export type ApplicationStatusName = (typeof APPLICATION_STATUSES)[number];

export class TeacherApplicationDto {
  @ApiProperty({
    enum: APPLICATION_STATUSES,
    description:
      'NONE: never applied. ACTIVE: you are a Teacher. REJECTED and REVOKED can apply again.',
  })
  status!: ApplicationStatusName;

  @ApiProperty({ nullable: true, type: String })
  message!: string | null;

  @ApiProperty({ nullable: true, type: String })
  decisionNote!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  decidedAt!: Date | null;
}

export class ApplyTeacherDto {
  @ApiProperty({
    minLength: TEXT_LIMITS.TEACHER_APPLICATION_MESSAGE.min,
    maxLength: TEXT_LIMITS.TEACHER_APPLICATION_MESSAGE.max,
  })
  @Transform(trim)
  @TextLength(TEXT_LIMITS.TEACHER_APPLICATION_MESSAGE)
  message!: string;
}
