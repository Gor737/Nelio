import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { COUNT_LIMITS, TEXT_LIMITS } from '../../../common/constants/limits.js';
import { TextLength } from '../../../common/decorators/index.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const CONVERSATION_TYPES = [
  'DIRECT',
  'GROUP',
  'COURSE_CHANNEL',
] as const;
export type ConversationTypeName = (typeof CONVERSATION_TYPES)[number];
export const MEMBER_ROLES = ['MEMBER', 'ADMIN'] as const;
export type MemberRoleName = (typeof MEMBER_ROLES)[number];

// ---------- requests

export class CreateDirectDto {
  @ApiProperty({ format: 'uuid', description: 'The other person.' })
  @IsUUID()
  userId!: string;
}

export class CreateGroupDto {
  @ApiProperty({
    minLength: TEXT_LIMITS.GROUP_TITLE.min,
    maxLength: TEXT_LIMITS.GROUP_TITLE.max,
  })
  @Transform(trim)
  @TextLength(TEXT_LIMITS.GROUP_TITLE)
  title!: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: `The other members (you are added as the group's admin). With you, at most ${COUNT_LIMITS.GROUP_MEMBERS_MAX}.`,
  })
  @IsArray()
  @ArrayMaxSize(COUNT_LIMITS.GROUP_MEMBERS_MAX)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  memberIds!: string[];
}

export class RenameGroupDto {
  @ApiProperty({
    minLength: TEXT_LIMITS.GROUP_TITLE.min,
    maxLength: TEXT_LIMITS.GROUP_TITLE.max,
  })
  @Transform(trim)
  @TextLength(TEXT_LIMITS.GROUP_TITLE)
  title!: string;
}

export class AddMembersDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMaxSize(COUNT_LIMITS.GROUP_MEMBERS_MAX)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  userIds!: string[];
}

export class SetMemberRoleDto {
  @ApiProperty({ enum: MEMBER_ROLES })
  @IsIn(MEMBER_ROLES)
  role!: MemberRoleName;
}

export class UpdateMembershipDto {
  @ApiProperty({ description: 'Mute or unmute this conversation for me.' })
  @IsBoolean()
  isMuted!: boolean;
}

export class SendMessageDto {
  @ApiProperty({
    minLength: TEXT_LIMITS.MESSAGE_BODY.min,
    maxLength: TEXT_LIMITS.MESSAGE_BODY.max,
    description: 'Plain text. Leading and trailing white space is removed.',
  })
  @Transform(trim)
  @TextLength(TEXT_LIMITS.MESSAGE_BODY)
  body!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Chosen by the client for each new message. Sending the same clientId and body again returns the same message (no duplicate); the same clientId with another body or in another conversation is 409 CLIENT_ID_REUSED.',
  })
  @IsUUID()
  clientId!: string;
}

export class EditMessageDto {
  @ApiProperty({
    minLength: TEXT_LIMITS.MESSAGE_BODY.min,
    maxLength: TEXT_LIMITS.MESSAGE_BODY.max,
  })
  @Transform(trim)
  @TextLength(TEXT_LIMITS.MESSAGE_BODY)
  body!: string;
}

export class MarkReadDto {
  @ApiProperty({
    minimum: 0,
    description:
      "The highest seq you have seen. It never moves backwards, and it cannot be above the conversation's last seq (400).",
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  seq!: number;
}

export class HistoryQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Messages older than this seq (the newest of them come first in the page).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  before?: number;

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Messages after this seq, oldest first: exactly what a client missed.',
  })
  @IsOptional()
  @ValidateIf((o: HistoryQueryDto) => o.after !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  after?: number;

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
}

// ---------- responses

export class PersonDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ nullable: true, type: String })
  avatarUrl!: string | null;
}

export class SenderDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;
}

export class ConversationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: CONVERSATION_TYPES })
  type!: ConversationTypeName;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The group title, or the course title for a course channel; null for a direct conversation.',
  })
  title!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  courseId!: string | null;

  @ApiProperty({
    type: PersonDto,
    nullable: true,
    description: 'The other person of a direct conversation.',
  })
  peer!: PersonDto | null;

  @ApiProperty({ description: 'Active members.' })
  memberCount!: number;

  @ApiProperty({ enum: MEMBER_ROLES })
  myRole!: MemberRoleName;

  @ApiProperty()
  isMuted!: boolean;

  @ApiProperty({
    description:
      'Messages after my read position that I did not send and that are not deleted.',
  })
  unreadCount!: number;

  @ApiProperty()
  lastSeq!: number;

  @ApiProperty()
  lastReadSeq!: number;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  lastMessageAt!: Date | null;

  @ApiProperty({
    description:
      'True for a course channel whose course is archived or locked: reading and deleting only.',
  })
  readOnly!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class ConversationsPageDto {
  @ApiProperty({ type: [ConversationDto] })
  items!: ConversationDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty()
  total!: number;
}

export class MemberDto extends PersonDto {
  @ApiProperty({ enum: MEMBER_ROLES })
  role!: MemberRoleName;

  @ApiProperty({ format: 'date-time' })
  joinedAt!: Date;
}

export class MessageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  conversationId!: string;

  @ApiProperty({
    description:
      'Position in the conversation: 1, 2, 3, … without gaps. Sort by it.',
  })
  seq!: number;

  @ApiProperty({ type: SenderDto })
  sender!: SenderDto;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'null once the message was deleted.',
  })
  body!: string | null;

  @ApiProperty({ format: 'uuid' })
  clientId!: string;

  @ApiProperty()
  deleted!: boolean;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  editedAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class HistoryDto {
  @ApiProperty({ type: [MessageDto], description: 'Oldest first.' })
  items!: MessageDto[];

  @ApiProperty({
    description: 'There are more messages in the direction you asked for.',
  })
  hasMore!: boolean;
}

export class ReadPositionDto {
  @ApiProperty()
  lastReadSeq!: number;
}

export class PresenceDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'People you share a direct conversation or a group with who are online now.',
  })
  online!: string[];
}
