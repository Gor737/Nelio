import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { COUNT_LIMITS } from '../../../common/constants/limits.js';
import {
  NOTIFICATION_TYPE_NAMES,
  type NotificationType,
} from '../../../common/constants/notification-types.js';

export class NotificationActorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;
}

export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: NOTIFICATION_TYPE_NAMES })
  type!: NotificationType;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  courseId!: string | null;

  @ApiProperty({
    type: NotificationActorDto,
    nullable: true,
    description:
      'Who caused it; null for system events and when that account no longer exists.',
  })
  actor!: NotificationActorDto | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Display snapshot taken when the event happened (for example `courseTitle`, `lessonTitle`, `reason`, `reinstated`). Keys depend on `type`.',
  })
  data!: Record<string, unknown>;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  readAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class NotificationsPageDto {
  @ApiProperty({ type: [NotificationDto] })
  items!: NotificationDto[];

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Pass it as `cursor` to get the next (older) page; null when there is no more.',
  })
  nextCursor!: string | null;
}

export class UnreadCountDto {
  @ApiProperty()
  count!: number;
}

export class NotificationListQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The `nextCursor` of the previous page.',
  })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: COUNT_LIMITS.CURSOR_PAGE_SIZE_MAX,
    default: COUNT_LIMITS.CURSOR_PAGE_SIZE_DEFAULT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COUNT_LIMITS.CURSOR_PAGE_SIZE_MAX)
  limit?: number;

  @ApiPropertyOptional({ description: 'true: only unread notifications.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  unread?: boolean;
}
