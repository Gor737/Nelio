import { Inject, Logger } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { ApiException } from '../../common/filters/api-exception.js';
import { Authenticator } from '../../common/guards/authenticator.js';
import { APP_CONFIG, type AppConfig } from '../config/index.js';
import { EventBus } from '../events/index.js';
import { RealtimeService, type SocketSession } from './realtime.service.js';
import { SocketRegistry, userRoom } from './socket-registry.js';

/** The error a rejected handshake gives the client (`connect_error`): `error.message` and `error.data = { statusCode, code }`. */
function handshakeError(error: unknown, logger: Logger): Error {
  if (error instanceof ApiException) {
    return Object.assign(new Error(error.message), {
      data: { statusCode: error.status, code: error.code },
    });
  }
  logger.error({ event: 'handshake_failed', error });
  return Object.assign(new Error('Internal server error'), {
    data: { statusCode: 500, code: 'INTERNAL_ERROR' },
  });
}

/**
 * The Socket.IO server's entry point (docs/architecture.md section 14, lifecycle rule 1). It owns the connection lifecycle only;
 * the chat events live in the Chat module's gateway on the same server. It touches no domain module and no database.
 *
 * Handshake, in order, with the same checks as the HTTP guard (one `Authenticator`):
 *   1. Origin: when the browser sends one it must be the frontend origin (a browser always sends Origin on the WebSocket upgrade;
 *      same-origin polling requests may omit it, and a non-browser client has no Origin to forge) -> 403 FORBIDDEN;
 *   2. the access token in the `auth` payload, never in the URL -> 401 UNAUTHENTICATED;
 *   3. signature, pinned algorithm, expiry, user exists, not suspended (403 ACCOUNT_SUSPENDED), `tokens_valid_after`.
 * A rejected handshake never creates a socket. An accepted one joins the personal room `user:{id}`, is registered, and
 * `socket.connected` / `socket.disconnected` are emitted for presence.
 */
@WebSocketGateway()
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly authenticator: Authenticator,
    private readonly registry: SocketRegistry,
    private readonly service: RealtimeService,
    private readonly events: EventBus,
  ) {}

  afterInit(server: Server): void {
    this.service.attach(server);
    server.use((socket, next) => {
      this.handshake(socket).then(
        () => next(),
        (error: unknown) => next(handshakeError(error, this.logger)),
      );
    });
  }

  private async handshake(socket: Socket): Promise<void> {
    const origin = socket.handshake.headers.origin;
    if (origin !== undefined && origin !== this.config.frontendOrigin)
      throw new ApiException('FORBIDDEN');

    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    if (typeof auth?.token !== 'string' || auth.token.length === 0)
      throw new ApiException('UNAUTHENTICATED');

    const session = await this.authenticator.authenticateToken(auth.token);
    (socket.data as SocketSession).user = session.user;
    (socket.data as SocketSession).issuedAt = session.issuedAt;
  }

  async handleConnection(socket: Socket): Promise<void> {
    const { user } = socket.data as SocketSession;
    await socket.join(userRoom(user.id));
    this.registry.add(user.id, socket.id);
    this.events.emit('socket.connected', {
      userId: user.id,
      socketId: socket.id,
    });
  }

  handleDisconnect(socket: Socket): void {
    const session = socket.data as Partial<SocketSession>;
    if (!session.user) return; // never completed the handshake
    const remaining = this.registry.remove(session.user.id, socket.id);
    this.events.emit('socket.disconnected', {
      userId: session.user.id,
      socketId: socket.id,
      wasLastSocket: remaining === 0,
    });
  }
}
