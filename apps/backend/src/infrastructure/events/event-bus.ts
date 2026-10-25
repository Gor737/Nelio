import { EventEmitter } from 'node:events';
import { Injectable, Logger } from '@nestjs/common';
import type { EventContracts, EventName } from './event-contracts.js';

export type EventListener<N extends EventName> = (
  payload: EventContracts[N],
) => void | Promise<void>;

/**
 * In-process typed event bus (docs/architecture.md section 17). Emitting never throws and never waits: a listener that
 * throws or rejects is logged and cannot affect the emitter or the other listeners, because side effects (notifications,
 * pushes, disconnects) must not break a business transaction that already committed. Delivery is not durable: a lost
 * effect is repaired by the safety-net jobs of Decision 162.
 */
@Injectable()
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly logger = new Logger(EventBus.name);

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  /** Subscribes; returns the function that unsubscribes. */
  on<N extends EventName>(name: N, listener: EventListener<N>): () => void {
    const wrapped = (payload: EventContracts[N]) => {
      try {
        const result = listener(payload);
        if (result instanceof Promise)
          result.catch((error: unknown) => this.logFailure(name, error));
      } catch (error) {
        this.logFailure(name, error);
      }
    };
    this.emitter.on(name, wrapped);
    return () => void this.emitter.off(name, wrapped);
  }

  /** Delivers to the listeners registered right now. Call only after the transaction that caused the event has committed. */
  emit<N extends EventName>(name: N, payload: EventContracts[N]): void {
    this.emitter.emit(name, payload);
  }

  listenerCount(name: EventName): number {
    return this.emitter.listenerCount(name);
  }

  private logFailure(name: EventName, error: unknown): void {
    this.logger.error({
      event: 'event_listener_failed',
      eventName: name,
      error,
    });
  }
}
