import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
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
import { CurrentUser, RateLimit } from '../../../common/decorators/index.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import {
  EditMessageDto,
  HistoryDto,
  HistoryQueryDto,
  MarkReadDto,
  MessageDto,
  ReadPositionDto,
  SendMessageDto,
} from '../dto/chat.dto.js';
import { MessagesService } from '../services/messages.service.js';

@ApiTags('Chat')
@ApiBearerAuth('access-token')
@Controller('conversations/:id')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post('messages')
  @HttpCode(201)
  @RateLimit('PER_CONVERSATION_BURST', { conversationParam: 'id' })
  @ApiOperation({
    summary: 'Send a message',
    description:
      'The fallback of the socket event `message:send`; both give the same result and the same errors. Sending the same clientId and text again returns the same message and creates nothing. 404 for a non-member and for a former member; 403 CANNOT_MESSAGE_USER in a direct conversation with a block; 409 COURSE_ARCHIVED / COURSE_ADMIN_LOCKED in the channel of an archived or locked course; 409 CLIENT_ID_REUSED; 429 above 30 messages in 10 seconds in this conversation.',
  })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  async send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: SendMessageDto,
  ): Promise<MessageDto> {
    return (await this.messages.send(user.id, id, dto)).message;
  }

  @Get('messages')
  @ApiOperation({
    summary: 'Message history',
    description:
      'Oldest first. No cursor: the newest page. `before=seq`: the page just older than that seq. `after=seq`: everything after it (what a client missed after a gap). A deleted message is present with `deleted: true` and no text.',
  })
  @ApiOkResponse({ type: HistoryDto })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Query() query: HistoryQueryDto,
  ): Promise<HistoryDto> {
    return this.messages.history(user.id, id, query);
  }

  @Patch('messages/:messageId')
  @ApiOperation({
    summary: 'Edit my message',
    description:
      'Only the author; a deleted message cannot be edited (409); blocked in the channel of an archived or locked course (409).',
  })
  @ApiOkResponse({ type: MessageDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  edit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @Body() dto: EditMessageDto,
  ): Promise<MessageDto> {
    return this.messages.edit(user.id, id, messageId, dto.body);
  }

  @Delete('messages/:messageId')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a message',
    description:
      'The author, or in a course channel the course Owner or an Assistant. Also allowed while the channel is read-only. Deleting twice is fine. The text is hidden from the API; the row stays.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
  ): Promise<void> {
    await this.messages.delete(user.id, id, messageId);
  }

  @Put('read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark read up to a seq',
    description:
      "Never moves backwards. A seq above the conversation's last message is 400. Clients should debounce this call.",
  })
  @ApiOkResponse({ type: ReadPositionDto })
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: MarkReadDto,
  ): Promise<ReadPositionDto> {
    return this.messages.markRead(user.id, id, dto.seq);
  }
}
