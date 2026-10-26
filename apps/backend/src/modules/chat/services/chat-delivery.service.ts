import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/index.js';
import {
  EventBus,
  type EventContracts,
  type EventName,
} from '../../../infrastructure/events/index.js';
import { RealtimeService } from '../../../infrastructure/realtime/index.js';
import { readMessage } from './conversation-reader.js';
import { ConversationsService } from './conversations.service.js';

/** The Socket.IO events of the chat (docs/architecture.md section 14). */
export const CHAT_SERVER_EVENTS = {
  messageNew: 'message:new',
  messageEdited: 'message:edited',
  messageDeleted: 'message:deleted',
  conversationAdded: 'conversation:added',
  conversationRemoved: 'conversation:removed',
  conversationUpdated: 'conversation:updated',
  conversationRead: 'conversation:read',
} as const;

/**
 * Delivery (Decisions 155, 158). After a transaction commits, the chat services queue typed events; this listener reads the CURRENT members
 * from the database and emits to each member's personal room. There are no per-conversation rooms, so a member who was removed a moment ago
 * is simply not in the list and receives nothing, and a suspended user is skipped. Payloads are built by the same mappers as REST, so
 * nobody receives anything they could not read over REST. A delivery that fails is logged and never affects the sender or the commit.
 */
@Injectable()
export class ChatDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatDeliveryService.name);
  private unsubscribe: (() => void)[] = [];
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly conversations: ConversationsService,
  ) {}

  onModuleInit(): void {
    this.on('message.created', async (e) => {
      const message = await readMessage(this.prisma, e.messageId);
      if (message)
        this.realtime.emitToUsers(
          await this.members(e.conversationId),
          CHAT_SERVER_EVENTS.messageNew,
          message,
        );
    });
    this.on('message.edited', async (e) => {
      const message = await readMessage(this.prisma, e.messageId);
      if (message)
        this.realtime.emitToUsers(
          await this.members(e.conversationId),
          CHAT_SERVER_EVENTS.messageEdited,
          message,
        );
    });
    this.on('message.deleted', async (e) => {
      const message = await readMessage(this.prisma, e.messageId);
      if (message)
        this.realtime.emitToUsers(
          await this.members(e.conversationId),
          CHAT_SERVER_EVENTS.messageDeleted,
          message,
        );
    });
    this.on('conversation.added', async (e) => {
      const conversation = await this.conversations
        .getFor(e.userId, e.conversationId)
        .catch(() => null);
      if (conversation)
        this.realtime.emitToUser(
          e.userId,
          CHAT_SERVER_EVENTS.conversationAdded,
          conversation,
        );
    });
    this.on('conversation.removed', (e) => {
      this.realtime.emitToUser(
        e.userId,
        CHAT_SERVER_EVENTS.conversationRemoved,
        {
          conversationId: e.conversationId,
        },
      );
    });
    this.on('conversation.updated', async (e) => {
      for (const userId of await this.members(e.conversationId)) {
        const conversation = await this.conversations
          .getFor(userId, e.conversationId)
          .catch(() => null);
        if (conversation)
          this.realtime.emitToUser(
            userId,
            CHAT_SERVER_EVENTS.conversationUpdated,
            conversation,
          );
      }
    });
    this.on('conversation.read', (e) => {
      this.realtime.emitToUser(e.userId, CHAT_SERVER_EVENTS.conversationRead, {
        conversationId: e.conversationId,
        lastReadSeq: e.lastReadSeq,
      });
    });
  }

  /** Stops listening and lets the deliveries that already started finish, so shutdown never reads a closed database. */
  async onModuleDestroy(): Promise<void> {
    for (const stop of this.unsubscribe.splice(0)) stop();
    await this.idle();
  }

  /** Resolves when no delivery is running (used by shutdown, and by tests that must not leave database work behind). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled(this.inflight);
  }

  /** The users who should receive an event of this conversation right now: active members who are not suspended. */
  async members(conversationId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ user_id: string }[]>`
      SELECT m.user_id FROM conversation_members m JOIN users u ON u.id = m.user_id AND u.status = 'ACTIVE'
       WHERE m.conversation_id = ${conversationId}::uuid AND m.left_at IS NULL`;
    return rows.map((r) => r.user_id);
  }

  private on<N extends EventName>(
    name: N,
    handler: (payload: EventContracts[N]) => Promise<void> | void,
  ): void {
    this.unsubscribe.push(
      this.bus.on(name, (payload) => {
        const run = (async () => {
          try {
            await handler(payload);
          } catch (error) {
            this.logger.warn({
              event: 'chat_delivery_failed',
              eventName: name,
              error: error instanceof Error ? error.name : 'error',
            });
          }
        })();
        this.inflight.add(run);
        void run.finally(() => this.inflight.delete(run));
      }),
    );
  }
}
