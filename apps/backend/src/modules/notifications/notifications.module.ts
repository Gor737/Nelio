import { Module } from '@nestjs/common';
import { RealtimeModule } from '../../infrastructure/realtime/index.js';
import { NotificationsController } from './controllers/notifications.controller.js';
import { NotificationWriter } from './services/notification-writer.service.js';
import { NotificationRetentionJob } from './services/notification-retention.job.js';
import { NotificationRetention } from './services/notification-retention.service.js';
import { NotificationsListener } from './services/notifications.listener.js';
import { NotificationsService } from './services/notifications.service.js';

/**
 * Notifications (Layer 0): listens to the typed domain events, writes notification rows in chunks, pushes `notification:new`, serves the
 * user's own list, and removes old read ones. It exports nothing and nobody imports it: producers only emit events.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [NotificationsController],
  providers: [
    NotificationWriter,
    NotificationsListener,
    NotificationsService,
    NotificationRetention,
    NotificationRetentionJob,
  ],
})
export class NotificationsModule {}
