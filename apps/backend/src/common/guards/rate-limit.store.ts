export interface HitResult {
  readonly count: number;
  /** Milliseconds until the window of this key ends. */
  readonly resetInMs: number;
}

/**
 * Fixed-window counters in process memory. The backend is one instance (architecture section 1), so no shared store is
 * needed; a restart clears the counters, which only ever makes the limiter more permissive for one window.
 */
export class RateLimitStore {
  private readonly windows = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly now: () => number = Date.now,
    sweepEveryMs = 60_000,
  ) {
    this.sweeper = setInterval(() => this.sweep(), sweepEveryMs);
    this.sweeper.unref();
  }

  hit(key: string, windowMs: number): HitResult {
    const now = this.now();
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, entry);
    }
    entry.count++;
    return { count: entry.count, resetInMs: entry.resetAt - now };
  }

  size(): number {
    return this.windows.size;
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
}
