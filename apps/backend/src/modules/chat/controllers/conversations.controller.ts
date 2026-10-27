import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  CourseRole,
  CurrentUser,
  RateLimit,
} from '../../../common/decorators/index.js';
import {
  PageQueryDto,
  pageWindow,
} from '../../../common/dto/page-query.dto.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import {
  AddMembersDto,
  ConversationDto,
  ConversationsPageDto,
  CreateDirectDto,
  CreateGroupDto,
  MemberDto,
  RenameGroupDto,
  SetMemberRoleDto,
  UpdateMembershipDto,
} from '../dto/chat.dto.js';
import { ConversationsService } from '../services/conversations.service.js';
import { MembersService } from '../services/members.service.js';

@ApiTags('Chat')
@ApiBearerAuth('access-token')
@Controller()
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly members: MembersService,
  ) {}

  @Get('me/conversations')
  @ApiOperation({
    summary: 'My conversations',
    description:
      'Direct conversations, groups and course channels I am an active member of, most recent first. A direct conversation nobody has written in yet is not listed. Includes the unread count of each.',
  })
  @ApiOkResponse({ type: ConversationsPageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PageQueryDto,
  ): Promise<ConversationsPageDto> {
    return this.conversations.list(user.id, pageWindow(query));
  }

  @Post('conversations/direct')
  @HttpCode(200)
  @RateLimit('TIGHT')
  @ApiOperation({
    summary: 'Open (get or create) the direct conversation with a person',
    description:
      'The same conversation is returned every time, whoever asks first. 403 CANNOT_MESSAGE_USER when a block exists in either direction (the same answer for both sides); 404 for an unknown or suspended user.',
  })
  @ApiOkResponse({ type: ConversationDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  openDirect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDirectDto,
  ): Promise<ConversationDto> {
    return this.conversations.openDirect(user.id, dto.userId);
  }

  @Post('conversations/groups')
  @HttpCode(201)
  @RateLimit('TIGHT')
  @ApiOperation({
    summary: 'Create a group',
    description:
      'You become its admin. No consent is needed from the people you add. 409 MEMBERS_UNAVAILABLE (neutral) when someone cannot be added, for example because they blocked you.',
  })
  @ApiCreatedResponse({ type: ConversationDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  createGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateGroupDto,
  ): Promise<ConversationDto> {
    return this.conversations.createGroup(user.id, dto.title, dto.memberIds);
  }

  @Get('conversations/:id')
  @ApiOperation({
    summary: 'One conversation',
    description: 'A non-member and a former member get 404.',
  })
  @ApiOkResponse({ type: ConversationDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ): Promise<ConversationDto> {
    return this.conversations.getFor(user.id, id);
  }

  @Patch('conversations/:id')
  @ApiOperation({ summary: 'Rename a group (group admins only)' })
  @ApiOkResponse({ type: ConversationDto })
  rename(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: RenameGroupDto,
  ): Promise<ConversationDto> {
    return this.conversations.rename(user.id, id, dto.title);
  }

  @Patch('conversations/:id/membership')
  @ApiOperation({ summary: 'Mute or unmute a conversation for me' })
  @ApiOkResponse({ type: ConversationDto })
  setMuted(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateMembershipDto,
  ): Promise<ConversationDto> {
    return this.conversations.setMuted(user.id, id, dto.isMuted);
  }

  @Post('conversations/:id/leave')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Leave a group',
    description:
      'If you are the last admin and others remain, the member who joined first becomes the admin. A direct conversation and a course channel cannot be left (409).',
  })
  @ApiNoContentResponse()
  async leave(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ): Promise<void> {
    await this.members.leave(user.id, id);
  }

  @Get('conversations/:id/members')
  @ApiOperation({ summary: 'Active members' })
  @ApiOkResponse({ type: [MemberDto] })
  listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ): Promise<MemberDto[]> {
    return this.members.list(user.id, id);
  }

  @Post('conversations/:id/members')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Add people to a group (group admins only)',
    description:
      'People who are already members are skipped; someone who left earlier returns on their old row. 409 MEMBERS_UNAVAILABLE (neutral) when someone cannot be added; 409 RESOURCE_CONFLICT above 50 members.',
  })
  @ApiOkResponse({ type: [MemberDto] })
  addMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: AddMembersDto,
  ): Promise<MemberDto[]> {
    return this.members.add(user.id, id, dto.userIds);
  }

  @Patch('conversations/:id/members/:userId')
  @ApiOperation({
    summary: 'Promote to group admin or demote to member (group admins only)',
    description:
      'Demoting the last admin while others remain is 409 LAST_GROUP_ADMIN.',
  })
  @ApiOkResponse({ type: [MemberDto] })
  setRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: SetMemberRoleDto,
  ): Promise<MemberDto[]> {
    return this.members.setRole(user.id, id, userId, dto.role);
  }

  @Delete('conversations/:id/members/:userId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a member from a group (group admins only)',
    description: 'Removing yourself is the same as leaving.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<void> {
    await this.members.remove(user.id, id, userId);
  }

  @Get('courses/:courseId/channel')
  @CourseRole('OWNER', 'ASSISTANT', 'STUDENT_ACTIVE')
  @ApiOperation({
    summary: 'The general channel of a course',
    description:
      'Members are the Owner, the Assistants and the ACTIVE students. 404 while the course has no channel yet (it is created when the course is first published).',
  })
  @ApiOkResponse({ type: ConversationDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  channel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseUuidPipe) courseId: string,
  ): Promise<ConversationDto> {
    return this.conversations.channelOfCourse(user.id, courseId);
  }
}
