import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import { TEXT_LIMITS } from '../../../common/constants/limits.js';
import { TextLength } from '../../../common/decorators/index.js';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { REPORT_REASONS, type ReportReason } from './moderation.dto.js';

export const REPORT_STATUSES = ['OPEN', 'DISMISSED', 'ACTIONED'] as const;
export type ReportStatusName = (typeof REPORT_STATUSES)[number];
export const REPORT_TARGET_TYPES = ['MESSAGE', 'USER'] as const;
export type ReportTargetTypeName = (typeof REPORT_TARGET_TYPES)[number];

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ReportQueueQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: REPORT_STATUSES,
    default: 'OPEN',
    description:
      'OPEN is the queue (oldest first); the others list what was handled (latest first).',
  })
  @IsOptional()
  @IsIn(REPORT_STATUSES)
  status?: ReportStatusName;

  @ApiPropertyOptional({ enum: REPORT_TARGET_TYPES })
  @IsOptional()
  @IsIn(REPORT_TARGET_TYPES)
  targetType?: ReportTargetTypeName;

  @ApiPropertyOptional({ enum: REPORT_REASONS })
  @IsOptional()
  @IsIn(REPORT_REASONS)
  reason?: ReportReason;
}

export class ResolveReportDto {
  @ApiPropertyOptional({
    minLength: TEXT_LIMITS.REPORT_RESOLUTION_NOTE.min,
    maxLength: TEXT_LIMITS.REPORT_RESOLUTION_NOTE.max,
  })
  @IsOptional()
  @Transform(trim)
  @TextLength(TEXT_LIMITS.REPORT_RESOLUTION_NOTE)
  note?: string;
}

export class PersonNameDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
}

export class ReportedMessageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty({ type: () => PersonNameDto }) author!: PersonNameDto;
  @ApiProperty({ description: 'The message is soft-deleted now.' })
  deleted!: boolean;
}

export class AdminReportItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: REPORT_TARGET_TYPES })
  targetType!: ReportTargetTypeName;
  @ApiProperty({ enum: REPORT_REASONS }) reason!: ReportReason;
  @ApiProperty({ enum: REPORT_STATUSES }) status!: ReportStatusName;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: () => PersonNameDto }) reporter!: PersonNameDto;
  @ApiProperty({ type: () => ReportedMessageDto, nullable: true })
  message!: ReportedMessageDto | null;
  @ApiProperty({ type: () => PersonNameDto, nullable: true })
  targetUser!: PersonNameDto | null;
}

export class AdminReportsPageDto {
  @ApiProperty({ type: () => [AdminReportItemDto] })
  items!: AdminReportItemDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

export class AdminReportDetailDto extends AdminReportItemDto {
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The message body as it was when the report was filed (evidence). Null for a user report.',
  })
  snapshot!: string | null;
  @ApiProperty({
    description:
      'OPEN reports about the same message or user besides this one. Deleting the message through `action` closes the sibling reports of that message.',
  })
  openSiblings!: number;
  @ApiProperty({ type: () => PersonNameDto, nullable: true })
  reviewedBy!: PersonNameDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reviewedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) resolutionNote!: string | null;
}

export class ContextMessageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() seq!: number;
  @ApiProperty({ type: () => PersonNameDto }) sender!: PersonNameDto;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null for a deleted message: its text is never returned.',
  })
  body!: string | null;
  @ApiProperty() deleted!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ description: 'This is the reported message.' })
  reported!: boolean;
}

export class ReportContextDto {
  @ApiProperty({ format: 'uuid' }) reportId!: string;
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty({ type: String, description: 'The body at report time.' })
  snapshot!: string;
  @ApiProperty({
    type: () => [ContextMessageDto],
    description:
      'The reported message with up to 10 messages before and 10 after it, oldest first. Viewing it is audited each time (REPORT_CONTEXT_VIEWED).',
  })
  messages!: ContextMessageDto[];
}
