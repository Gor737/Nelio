// A throwaway Socket.IO gateway for the realtime tests. It stands in for the chat gateway of M10c: it shows how a gateway uses the
// infrastructure (per-event active-user check, the shared rate limiter, validated payloads, errors as acks). Test code only.
import { Module, UseFilters } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { IsString, IsUUID, Length } from 'class-validator';
import type { Socket } from 'socket.io';
import {
  AllExceptionsFilter,
  ApiException,
} from '../../src/common/filters/index.js';
import { RateLimiter } from '../../src/common/guards/index.js';
import {
  RealtimeModule,
  RealtimeService,
  type SocketSession,
} from '../../src/infrastructure/realtime/index.js';

export class ProbeEchoDto {
  @IsString()
  @Length(1, 10)
  text!: string;
}

export class ProbeSendDto {
  @IsUUID()
  conversationId!: string;
}

/** Nest does not apply the global exception filter to gateways: every gateway binds it itself, so errors become `{ ok: false, code }` acks. */
@UseFilters(AllExceptionsFilter)
@WebSocketGateway()
export class ProbeGateway {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly limiter: RateLimiter,
  ) {}

  /** A validated payload and nothing else (the global ValidationPipe must apply to gateway payloads). */
  @SubscribeMessage('probe:echo')
  echo(@MessageBody() dto: ProbeEchoDto) {
    return { ok: true, text: dto.text };
  }

  /** What `message:send` will do in M10c, minus the database: re-check the user, rate-limit per user and conversation, answer. */
  @SubscribeMessage('probe:send')
  async send(
    @MessageBody() dto: ProbeSendDto,
    @ConnectedSocket() client: Socket,
  ) {
    const user = await this.realtime.requireActiveUser(
      client.data as SocketSession,
    );
    const decision = this.limiter.consume(
      'PER_CONVERSATION_BURST',
      { userId: user.id, conversationId: dto.conversationId.toLowerCase() },
      'post-auth',
    );
    if (!decision.allowed) throw new ApiException('TOO_MANY_REQUESTS');
    return { ok: true };
  }

  @SubscribeMessage('probe:boom')
  boom(): never {
    throw new Error('secret internal detail: postgresql://user:pw@host/db');
  }
}

@Module({ imports: [RealtimeModule], providers: [ProbeGateway] })
export class ProbeGatewayModule {}
