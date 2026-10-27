import type { EventContracts, EventName } from './event-contracts.js';

export interface QueuedEvent {
  readonly name: EventName;
  readonly payload: unknown;
}

/**
 * Events queued by code running inside a transaction, keyed by the transaction client object. The transaction runner
 * drains the queue of the attempt that committed and emits those events; the queue of a rolled-back or retried attempt is
 * simply dropped with its transaction object. So an event is delivered only after commit, exactly once, never after rollback.
 */
const queues = new WeakMap<object, QueuedEvent[]>();

/** Queues `name` to be emitted when (and only if) the transaction `tx` commits. */
export function emitAfterCommit<N extends EventName>(
  tx: object,
  name: N,
  payload: EventContracts[N],
): void {
  const queue = queues.get(tx);
  if (queue) queue.push({ name, payload });
  else queues.set(tx, [{ name, payload }]);
}

/** Removes and returns the events queued for `tx`. Used by the transaction runner only. */
export function takeQueuedEvents(tx: object): QueuedEvent[] {
  const queue = queues.get(tx) ?? [];
  queues.delete(tx);
  return queue;
}
