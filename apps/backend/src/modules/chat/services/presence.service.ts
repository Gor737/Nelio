import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { TIME_LIMITS } from '../../../common/constants/limits.js';
import { PrismaService } from '../../../infrastructure/database/index.js';
import { EventBus } from '../../../infrastructure/events/index.js';
import { RealtimeService } from '../../../infrastructure/realtime/index.js';
import { BlockService } from '../../moderation/index.js';

export const PRESENCE_EVENT = 'presence:update';

/**
 * Who is online (Decision 156). In memory, single instance. A user is online while ANY of their sockets is connected; going offline is
 * debounced (about 5 seconds), so a page reload does not flash "offline". Presence is shared ONLY with people the user has a direct
 * conversation or a group with (never in course channels, never platform-wide), pairs with a block are hidden from each other, and a
 * suspended user is not shown. `users.last_seen_at` is written when the last socket closes and is exposed by no endpoint.
 * Someone receives `presence:update` only after calling `presence:subscribe` (the client does that after connecting).
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private readonly online = new Set<string>();
  private readonly subscribed = new Set<string>();
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();
  private unsubscribe: (() => void)[] = [];
  /** The offline debounce in milliseconds (a field so a test can shorten it). */
  debounceMs: number = TIME_LIMITS.PRESENCE_OFFLINE_DEBOUNCE_MS;

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly blocks: BlockService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe.push(
      this.bus.on('socket.connected', ({ userId }) => this.connected(userId)),
      this.bus.on('socket.disconnected', ({ userId, wasLastSocket }) => {
        if (wasLastSocket) this.lastSocketClosed(userId);
      }),
    );
  }

  onModuleDestroy(): void {
    for (const stop of this.unsubscribe.splice(0)) stop();
    for (const timer of this.offlineTimers.values()) clearTimeout(timer);
    this.offlineTimers.clear();
  }

  isOnline(userId: string): boolean {
    return this.online.has(userId);
  }

  /**
   * `presence:subscribe`: from now on this user receives `presence:update` for their peers. Returns the peers who are online right now,
   * which is also what `GET /me/presence` answers.
   */
  async subscribe(userId: string): Promise<string[]> {
    this.subscribed.add(userId);
    return this.onlinePeers(userId);
  }

  async onlinePeers(userId: string): Promise<string[]> {
    const peers = await this.peersOf(userId);
    return peers.filter((id) => this.online.has(id));
  }

  /** People who share an active direct conversation or group with `userId`, without blocked pairs and suspended accounts. */
  async peersOf(userId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ user_id: string }[]>`
      SELECT DISTINCT p.user_id
        FROM conversation_members me
        JOIN conversations c ON c.id = me.conversation_id AND c.type IN ('DIRECT', 'GROUP')
        JOIN conversation_members p ON p.conversation_id = me.conversation_id AND p.user_id <> me.user_id AND p.left_at IS NULL
        JOIN users u ON u.id = p.user_id AND u.status = 'ACTIVE'
       WHERE me.user_id = ${userId}::uuid AND me.left_at IS NULL`;
    const ids = rows.map((r) => r.user_id);
    const blocked = await this.blocks.blockedAmong(userId, ids);
    return ids.filter((id) => !blocked.has(id));
  }

  private connected(userId: string): void {
    const timer = this.offlineTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.offlineTimers.delete(userId);
    }
    if (this.online.has(userId)) return; // a second socket, or a reconnect inside the debounce: nothing changed
    this.online.add(userId);
    void this.broadcast(userId, true);
  }

  private lastSocketClosed(userId: string): void {
    void this.prisma
      .$executeRaw`UPDATE users SET last_seen_at = now() WHERE id = ${userId}::uuid`.catch(
      () => undefined,
    );
    const existing = this.offlineTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.offlineTimers.delete(userId);
      if (!this.online.delete(userId)) return;
      this.subscribed.delete(userId);
      void this.broadcast(userId, false);
    }, this.debounceMs);
    timer.unref();
    this.offlineTimers.set(userId, timer);
  }

  private async broadcast(userId: string, isOnline: boolean): Promise<void> {
    try {
      const recipients = (await this.peersOf(userId)).filter((id) =>
        this.subscribed.has(id),
      );
      this.realtime.emitToUsers(recipients, PRESENCE_EVENT, {
        userId,
        online: isOnline,
      });
    } catch (error) {
      this.logger.warn({
        event: 'presence_broadcast_failed',
        error: error instanceof Error ? error.name : 'error',
      });
    }
  }
}
