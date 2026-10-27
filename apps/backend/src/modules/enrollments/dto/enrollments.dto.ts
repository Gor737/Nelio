import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import {
  ENROLLMENT_STATUSES,
  type EnrollmentStatusName,
} from '../services/enrollment-transitions.js';

export class ProgressDto {
  @ApiProperty({
    description: 'Lessons published now that the student has completed.',
  })
  completedLessons!: number;

  @ApiProperty({ description: 'Lessons published now.' })
  totalLessons!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 100,
    description:
      'Live whole percent, rounded down. Independent of `completedAt`, the permanent completion snapshot.',
  })
  percent!: number;
}

export class PersonDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ nullable: true, type: String })
  avatarUrl!: string | null;
}

export class EnrollmentDto {
  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiProperty({ enum: ENROLLMENT_STATUSES })
  status!: EnrollmentStatusName;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description:
      'Permanent: set once when the student finished every published lesson; never cleared.',
  })
  completedAt!: Date | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  lastVisitedLessonId!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  lastVisitedAt!: Date | null;

  @ApiProperty({ type: ProgressDto })
  progress!: ProgressDto;
}

export class MyEnrollmentDto extends EnrollmentDto {
  @ApiProperty()
  courseTitle!: string;

  @ApiProperty({ enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] })
  courseStatus!: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

  @ApiProperty({ nullable: true, type: String })
  coverUrl!: string | null;
}

export class MyEnrollmentsPageDto {
  @ApiProperty({ type: [MyEnrollmentDto] })
  items!: MyEnrollmentDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;
}

export class StudentDto {
  @ApiProperty({
    type: PersonDto,
    description: 'Name and avatar only: never an email address.',
  })
  student!: PersonDto;

  @ApiProperty({ enum: ENROLLMENT_STATUSES })
  status!: EnrollmentStatusName;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  completedAt!: Date | null;

  @ApiProperty({ type: ProgressDto })
  progress!: ProgressDto;
}

export class StudentsPageDto {
  @ApiProperty({ type: [StudentDto] })
  items!: StudentDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;
}

export class StudentProgressDto extends StudentDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'The lessons this student completed.',
  })
  completedLessonIds!: string[];
}

export class StudentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ENROLLMENT_STATUSES,
    description: 'Default: ACTIVE and PENDING.',
  })
  @IsOptional()
  @IsIn(ENROLLMENT_STATUSES)
  status?: EnrollmentStatusName;
}

export class MyEnrollmentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ENROLLMENT_STATUSES,
    description: 'Default: ACTIVE and PENDING.',
  })
  @IsOptional()
  @IsIn(ENROLLMENT_STATUSES)
  status?: EnrollmentStatusName;
}

export class LastVisitedDto {
  @ApiProperty({
    format: 'uuid',
    description: 'A published lesson of this course.',
  })
  @IsUUID()
  lessonId!: string;
}

export class CreateInvitationDto {
  @ApiProperty({ format: 'uuid', description: 'An existing, active user.' })
  @IsUUID()
  userId!: string;
}

export const INVITATION_VIEW_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'DECLINED',
  'REVOKED',
  'EXPIRED',
] as const;

export class InvitationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: PersonDto })
  invitee!: PersonDto;

  @ApiProperty({
    enum: INVITATION_VIEW_STATUSES,
    description: 'EXPIRED is derived from `expiresAt`: nothing stores it.',
  })
  status!: (typeof INVITATION_VIEW_STATUSES)[number];

  @ApiProperty({ type: PersonDto })
  invitedBy!: PersonDto;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class InvitationsPageDto {
  @ApiProperty({ type: [InvitationDto] })
  items!: InvitationDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;
}

export class MyInvitationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  courseId!: string;

  @ApiProperty()
  courseTitle!: string;

  @ApiProperty({ nullable: true, type: String })
  coverUrl!: string | null;

  @ApiProperty({ type: PersonDto })
  invitedBy!: PersonDto;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;
}
