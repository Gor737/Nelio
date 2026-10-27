import { UseFilters } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Transform } from 'class-transformer';
import { IsUUID } from 'class-validator';
import type { Socket } from 'socket.io';
import { TEXT_LIMITS } from '../../../common/constants/limits.js';
import { TextLength } from '../../../common/decorators/index.js';
import {
  AllExceptionsFilter,
  ApiException,
} from '../../../common/filters/index.js';
import { RateLimiter } from '../../../common/guards/index.js';
import {
  RealtimeService,
  type SocketSession,
} from '../../../infrastructure/realtime/index.js';
import type { MessageDto } from '../dto/chat.dto.js';
import { MessagesService } from '../services/messages.service.js';
import { PresenceService } from '../services/presence.service.js';
import { TypingService } from '../services/typing.service.js';

export class SocketSendMessageDto {
  @IsUUID()
  conversationId!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @TextLength(TEXT_LIMITS.MESSAGE_BODY)
  body!: string;

  @IsUUID()
  clientId!: string;
}

export class TypingDto {
  @IsUUID()
  conversationId!: string;
}

/**
 * The chat on the Socket.IO server (docs/architecture.md section 14, Decisions 154, 156, 158). A thin adapter: on every event it
 * re-checks that the user is still active, applies the Per-conversation burst limit through the same `RateLimiter` the REST routes use,
 * validates the payload with the global pipe, and calls the same services REST calls. It holds no business rule and no database access.
 * Errors reach the client as `{ ok: false, statusCode, code, message }` acknowledgements with the REST codes (the exception filter is
 * bound here because Nest does not apply global filters to gateways).
 *
 * Client to server: `message:send` (ack `{ ok, message }`), `typing:start`, `typing:stop`, `presence:subscribe` (ack `{ ok, online }`).
 */
@UseFilters(AllExceptionsFilter)
@WebSocketGateway()
export class ChatGateway {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly limiter: RateLimiter,
    private readonly messages: MessagesService,
    private readonly presence: PresenceService,
    private readonly typing: TypingService,
  ) {}

  @SubscribeMessage('message:send')
  async send(
    @MessageBody() dto: SocketSendMessageDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ ok: true; message: MessageDto }> {
    const userId = await this.activeUser(client, dto.conversationId);
    const { message } = await this.messages.send(userId, dto.conversationId, {
      body: dto.body,
      clientId: dto.clientId,
    });
    return { ok: true, message };
  }

  @SubscribeMessage('typing:start')
  async typingStart(
    @MessageBody() dto: TypingDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ ok: true }> {
    const userId = await this.activeUser(client, dto.conversationId);
    await this.typing.set(userId, dto.conversationId.toLowerCase(), true);
    return { ok: true };
  }

  @SubscribeMessage('typing:stop')
  async typingStop(
    @MessageBody() dto: TypingDto,
    @ConnectedSocket() client: Socket,
  ): Promise<{ ok: true }> {
    const userId = await this.activeUser(client, dto.conversationId);
    await this.typing.set(userId, dto.conversationId.toLowerCase(), false);
    return { ok: true };
  }

  @SubscribeMessage('presence:subscribe')
  async subscribePresence(
    @ConnectedSocket() client: Socket,
  ): Promise<{ ok: true; online: string[] }> {
    const user = await this.realtime.requireActiveUser(
      client.data as SocketSession,
    );
    return { ok: true, online: await this.presence.subscribe(user.id) };
  }

  /** The per-event check: the user still exists, is not suspended and the token is not revoked; then the shared rate limit. */
  private async activeUser(
    client: Socket,
    conversationId: string,
  ): Promise<string> {
    const user = await this.realtime.requireActiveUser(
      client.data as SocketSession,
    );
    const decision = this.limiter.consume(
      'PER_CONVERSATION_BURST',
      { userId: user.id, conversationId: conversationId.toLowerCase() },
      'post-auth',
    );
    if (!decision.allowed) throw new ApiException('TOO_MANY_REQUESTS');
    return user.id;
  }
}
