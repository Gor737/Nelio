import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Server } from 'socket.io';
import type { AuthenticatedUser } from '../../common/guards/authenticated-user.js';
import { Authenticator } from '../../common/guards/authenticator.js';
import { EventBus } from '../events/index.js';
import { SocketRegistry, userRoom } from './socket-registry.js';

/** What the handshake stores on `socket.data`. */
export interface SocketSession {
  user: AuthenticatedUser;
  /** The access token's issued-at (whole seconds), kept for `requireActiveUser`. */
  issuedAt: number;
}

/**
 * The only way the rest of the application talks to connected clients (docs/architecture.md section 14, "Placement"). It imports
 * no domain module. Recipients are always computed by the caller from the database; this service only delivers.
 *
 * Before the Socket.IO server exists (an application started without the gateway, or a test that only exercises HTTP) every
 * emit is a no-op that returns false, so callers need no guard.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private server?: Server;
  private unsubscribe?: () => void;

  constructor(
    private readonly registry: SocketRegistry,
    private readonly events: EventBus,
    private readonly authenticator: Authenticator,
  ) {}

  /** Called by the gateway when the Socket.IO server is ready. */
  attach(server: Server): void {
    this.server = server;
  }

  onModuleInit(): void {
    // `session.revoked` is emitted after commit by whoever revoked the sessions (suspension, logout-all, password reset).
    this.unsubscribe = this.events.on('session.revoked', ({ userId }) =>
      this.revokeSessions(userId),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Delivers `event` to every socket of the user (all devices). Returns false when there is no server. */
  emitToUser(userId: string, event: string, payload?: unknown): boolean {
    if (!this.server) return false;
    this.server.to(userRoom(userId)).emit(event, payload);
    return true;
  }

  /** Delivers to every socket of every listed user; a socket in several of the rooms still receives the event once. */
  emitToUsers(
    userIds: Iterable<string>,
    event: string,
    payload?: unknown,
  ): boolean {
    if (!this.server) return false;
    const rooms = [...new Set(userIds)].map(userRoom);
    if (rooms.length === 0) return true;
    this.server.to(rooms).emit(event, payload);
    return true;
  }

  /** Closes every socket of the user. Returns the number of sockets that were open. */
  disconnectUser(userId: string): number {
    const open = this.registry.count(userId);
    this.server?.in(userRoom(userId)).disconnectSockets(true);
    return open;
  }

  /**
   * Suspension and logout-everywhere (architecture section 14, rule 7): tell every device its session is over, then close the
   * sockets. The notice is written to each connection before it is closed, so a client that is still listening receives it.
   */
  revokeSessions(userId: string): void {
    this.emitToUser(userId, 'session:revoked', {});
    const closed = this.disconnectUser(userId);
    this.logger.log({ event: 'sessions_revoked', userId, sockets: closed });
  }

  isOnline(userId: string): boolean {
    return this.registry.isOnline(userId);
  }

  socketCount(userId: string): number {
    return this.registry.count(userId);
  }

  /**
   * Per-event check (architecture section 14, rule 2): the user of this connection must still exist, not be suspended, and its
   * session must not have been revoked since the handshake. Throws the same `ApiException`s as HTTP (`UNAUTHENTICATED`,
   * `ACCOUNT_SUSPENDED`), which the exception filter delivers as `{ ok: false, code }`.
   */
  requireActiveUser(session: SocketSession): Promise<AuthenticatedUser> {
    return this.authenticator.recheck(session.user.id, session.issuedAt);
  }
}
