import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { TEXT_LIMITS } from '../../../common/constants/limits.js';
import { TextLength } from '../../../common/decorators/index.js';

export const REPORT_REASONS = [
  'SPAM',
  'HARASSMENT',
  'INAPPROPRIATE',
  'OTHER',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export class BlockedUserDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ format: 'date-time' })
  blockedAt!: Date;
}

export class BlockedUsersPageDto {
  @ApiProperty({ type: [BlockedUserDto] })
  items!: BlockedUserDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;
}

export class CreateReportDto {
  @ApiProperty({ enum: REPORT_REASONS })
  @IsIn(REPORT_REASONS)
  reason!: ReportReason;

  @ApiPropertyOptional({
    minLength: TEXT_LIMITS.REPORT_DESCRIPTION.min,
    maxLength: TEXT_LIMITS.REPORT_DESCRIPTION.max,
  })
  @IsOptional()
  @TextLength(TEXT_LIMITS.REPORT_DESCRIPTION)
  description?: string;
}

/** What the reporter gets back: never the snapshot or anything about the target. */
export class ReportReceiptDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['OPEN'] })
  status!: 'OPEN';

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}
