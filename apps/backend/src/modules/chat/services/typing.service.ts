import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { TIME_LIMITS } from '../../../common/constants/limits.js';
import { ApiException } from '../../../common/filters/index.js';
import { PrismaService } from '../../../infrastructure/database/index.js';
import { RealtimeService } from '../../../infrastructure/realtime/index.js';

export const TYPING_EVENT = 'typing';

/**
 * Typing indicators (Decision 156): direct conversations and groups only, in memory, never stored. Membership is checked on EVERY event, so
 * someone who is not in the conversation (a forged id) is refused and nobody is told. The indicator expires on its own after about five
 * seconds. The caller applies the Per-conversation burst rate limit before calling this.
 */
@Injectable()
export class TypingService implements OnModuleDestroy {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** The expiry in milliseconds (a field so a test can shorten it). */
  expiryMs: number = TIME_LIMITS.TYPING_EXPIRY_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async set(
    userId: string,
    conversationId: string,
    isTyping: boolean,
  ): Promise<void> {
    const key = `${conversationId}:${userId}`;
    const others = await this.others(userId, conversationId);
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    this.timers.delete(key);
    this.emit(others, userId, conversationId, isTyping);
    if (isTyping) {
      const timer = setTimeout(() => {
        this.timers.delete(key);
        this.emit(others, userId, conversationId, false);
      }, this.expiryMs);
      timer.unref();
      this.timers.set(key, timer);
    }
  }

  /** The other active members of a direct conversation or group that `userId` is an active member of; anything else is 404. */
  private async others(
    userId: string,
    conversationId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<
      { user_id: string; self: boolean }[]
    >`
      SELECT m.user_id, (m.user_id = ${userId}::uuid) AS self
        FROM conversation_members m
        JOIN conversations c ON c.id = m.conversation_id AND c.type IN ('DIRECT', 'GROUP')
        JOIN users u ON u.id = m.user_id AND u.status = 'ACTIVE'
       WHERE m.conversation_id = ${conversationId}::uuid AND m.left_at IS NULL`;
    if (!rows.some((r) => r.self)) throw new ApiException('NOT_FOUND');
    return rows.filter((r) => !r.self).map((r) => r.user_id);
  }

  private emit(
    recipients: string[],
    userId: string,
    conversationId: string,
    isTyping: boolean,
  ): void {
    this.realtime.emitToUsers(recipients, TYPING_EVENT, {
      conversationId,
      userId,
      isTyping,
    });
  }
}
