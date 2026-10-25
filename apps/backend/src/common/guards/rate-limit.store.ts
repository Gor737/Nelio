import { COUNT_LIMITS } from '../constants/limits.js';

export interface HitResult {
  readonly count: number;
  /** Milliseconds until the window of this key ends. */
  readonly resetInMs: number;
}

export interface RateLimitStoreOptions {
  /** Clock, injectable so tests can move time without waiting. */
  readonly now?: () => number;
  /** How often expired windows are removed. */
  readonly sweepEveryMs?: number;
  /** Upper bound on stored keys; see the eviction rule on the class. */
  readonly maxKeys?: number;
}

/**
 * Fixed-window counters in process memory. The backend is one instance (architecture section 1, Decision 153), so no shared
 * store is needed; a restart clears the counters, which only ever makes the limiter more permissive for one window.
 *
 * The store is bounded: it holds at most `maxKeys` windows (default COUNT_LIMITS.RATE_LIMIT_MAX_KEYS), so a flood of
 * unique keys (for example many random emails) cannot grow memory without limit. When a new key arrives at the cap, expired
 * windows are swept first; if the store is still full, the window that was started earliest is evicted. The cost of eviction
 * is that an evicted key starts a fresh window, so under a sustained unique-key flood the limiter can become more permissive
 * for the oldest keys. That trade-off is deliberate: refusing every new key instead would let an attacker lock all other
 * users out. Each eviction is counted (`evictions`), so the condition can be logged and alerted on.
 */
export class RateLimitStore {
  // A Map iterates in insertion order. A key is re-inserted when its window restarts, so the first entry is always the
  // window that started earliest.
  private readonly windows = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly sweeper: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private evicted = 0;

  constructor(options: RateLimitStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? COUNT_LIMITS.RATE_LIMIT_MAX_KEYS;
    if (!Number.isInteger(this.maxKeys) || this.maxKeys < 1) {
      throw new RangeError(
        'RateLimitStore: maxKeys must be a positive integer',
      );
    }
    this.sweeper = setInterval(
      () => this.sweep(),
      options.sweepEveryMs ?? 60_000,
    );
    this.sweeper.unref();
  }

  hit(key: string, windowMs: number): HitResult {
    const now = this.now();
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      if (entry)
        this.windows.delete(key); // restart the window at the end of the eviction order
      else this.makeRoom();
      entry = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, entry);
    }
    entry.count++;
    return { count: entry.count, resetInMs: entry.resetAt - now };
  }

  size(): number {
    return this.windows.size;
  }

  /** Number of windows dropped before they expired because the store was full. */
  get evictions(): number {
    return this.evicted;
  }

  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.windows)
      if (entry.resetAt <= now) this.windows.delete(key);
  }

  close(): void {
    clearInterval(this.sweeper);
    this.windows.clear();
  }

  private makeRoom(): void {
    if (this.windows.size < this.maxKeys) return;
    this.sweep();
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) return;
      this.windows.delete(oldest.value);
      this.evicted++;
    }
  }
}
