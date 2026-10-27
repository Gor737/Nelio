import { Controller, Get, HttpCode, Param, Put, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/index.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import {
  NotificationListQueryDto,
  NotificationsPageDto,
  UnreadCountDto,
} from '../dto/notification.dto.js';
import { NotificationsService } from '../services/notifications.service.js';

/**
 * Notifications are only ever created by the server from events; there is no endpoint that creates or deletes one (deletion is the
 * retention job). Live delivery is the Socket.IO event `notification:new`, carrying the same object as a list item.
 */
@ApiTags('Notifications')
@ApiBearerAuth('access-token')
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'My notifications',
    description:
      'Newest first. Cursor pagination: pass `nextCursor` of the previous page as `cursor`. `unread=true` lists unread ones only.',
  })
  @ApiOkResponse({ type: NotificationsPageDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: NotificationListQueryDto,
  ): Promise<NotificationsPageDto> {
    return this.notifications.list(user.id, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of unread notifications (the badge)' })
  @ApiOkResponse({ type: UnreadCountDto })
  unreadCount(@CurrentUser() user: AuthenticatedUser): Promise<UnreadCountDto> {
    return this.notifications.unreadCount(user.id);
  }

  @Put('read-all')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Mark all my notifications as read',
    description: 'Idempotent.',
  })
  @ApiNoContentResponse({ description: 'Done (also when nothing was unread).' })
  async readAll(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.notifications.markAllRead(user.id);
  }

  @Put(':id/read')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Mark one notification as read',
    description:
      'Idempotent: repeating it succeeds and keeps the first read time. Another user`s notification, or one that does not exist, is 404.',
  })
  @ApiNoContentResponse({ description: 'Read (or already read).' })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async read(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ): Promise<void> {
    await this.notifications.markRead(user.id, id);
  }
}
