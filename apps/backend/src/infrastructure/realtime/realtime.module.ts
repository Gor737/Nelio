import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';
import { SocketRegistry } from './socket-registry.js';

/** Socket.IO server, handshake, personal rooms, registry and delivery. Imported only by Chat and Notifications (dependency rule). */
@Module({
  providers: [RealtimeGateway, RealtimeService, SocketRegistry],
  exports: [RealtimeService, SocketRegistry],
})
export class RealtimeModule {}
