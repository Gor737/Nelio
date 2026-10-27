import { ChannelReconcileJob } from './services/channel-reconcile.job.js';
import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/index.js';
import { RealtimeModule } from '../../infrastructure/realtime/index.js';
import { FilesModule } from '../files/index.js';
import { ModerationModule } from '../moderation/index.js';
import { ConversationsController } from './controllers/conversations.controller.js';
import { PresenceController } from './controllers/presence.controller.js';
import { ChatGateway } from './gateway/chat.gateway.js';
import { ChatDeliveryService } from './services/chat-delivery.service.js';
import { PresenceService } from './services/presence.service.js';
import { TypingService } from './services/typing.service.js';
import { MessagesController } from './controllers/messages.controller.js';
import { CourseChannelService } from './services/course-channel.service.js';
import { ConversationsService } from './services/conversations.service.js';
import { MembersService } from './services/members.service.js';
import { MessagesService } from './services/messages.service.js';

/**
 * Chat (Layer 1): conversations, membership, messages, the course channel, presence and the real-time gateway.
 * It reads Courses and Enrollments through SQL (archived/locked state, moderators), calls Moderation's `BlockService`, and uses
 * Realtime for delivery. It imports no other Layer 1 module.
 */
@Module({
  imports: [AuditModule, RealtimeModule, FilesModule, ModerationModule],
  controllers: [
    ConversationsController,
    MessagesController,
    PresenceController,
  ],
  providers: [
    ConversationsService,
    MembersService,
    MessagesService,
    CourseChannelService,
    ChannelReconcileJob,
    ChatDeliveryService,
    PresenceService,
    TypingService,
    ChatGateway,
  ],
  exports: [CourseChannelService, MessagesService, PresenceService],
})
export class ChatModule {}
