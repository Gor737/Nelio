// Unit tests for the in-memory rate-limit store with a fake clock: window expiry, sweeping and the key cap (Decision 167).
import { COUNT_LIMITS } from '../../src/common/constants/limits.js';
import { RateLimitStore } from '../../src/common/guards/rate-limit.store.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

let store: RateLimitStore;
afterEach(() => store.close());

describe('RateLimitStore windows', () => {
  it('counts hits inside one window and reports the time until reset', () => {
    const c = clock();
    store = new RateLimitStore({ now: c.now });
    expect(store.hit('a', 60_000)).toEqual({ count: 1, resetInMs: 60_000 });
    c.advance(10_000);
    expect(store.hit('a', 60_000)).toEqual({ count: 2, resetInMs: 50_000 });
  });

  it('starts a new window once the old one has expired', () => {
    const c = clock();
    store = new RateLimitStore({ now: c.now });
    store.hit('a', 1000);
    store.hit('a', 1000);
    c.advance(999);
    expect(store.hit('a', 1000).count).toBe(3); // still inside the window
    c.advance(1);
    expect(store.hit('a', 1000)).toEqual({ count: 1, resetInMs: 1000 }); // exactly at resetAt: expired
  });

  it('keeps keys independent', () => {
    store = new RateLimitStore({ now: clock().now });
    store.hit('a', 1000);
    store.hit('a', 1000);
    expect(store.hit('b', 1000).count).toBe(1);
  });
});

describe('RateLimitStore sweeping', () => {
  it('sweep removes expired windows and keeps live ones', () => {
    const c = clock();
    store = new RateLimitStore({ now: c.now });
    store.hit('short', 1000);
    store.hit('long', 60_000);
    c.advance(1000);
    expect(store.size()).toBe(2);
    store.sweep();
    expect(store.size()).toBe(1);
    expect(store.hit('long', 60_000).count).toBe(2); // the live window survived
  });

  it('the background sweeper runs on its own timer', async () => {
    const c = clock();
    store = new RateLimitStore({ now: c.now, sweepEveryMs: 10 });
    store.hit('a', 1000);
    c.advance(1000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(store.size()).toBe(0);
  });

  it('close() stops the timer and empties the store', () => {
    store = new RateLimitStore({ now: clock().now });
    store.hit('a', 1000);
    store.close();
    expect(store.size()).toBe(0);
  });
});

describe('RateLimitStore key cap', () => {
  it('never holds more than maxKeys windows, however many unique keys arrive', () => {
    store = new RateLimitStore({ now: clock().now, maxKeys: 100 });
    for (let i = 0; i < 10_000; i++) store.hit(`k${i}`, 60_000);
    expect(store.size()).toBe(100);
    expect(store.evictions).toBe(10_000 - 100);
  });

  it('sweeps expired windows before evicting a live one', () => {
    const c = clock();
    store = new RateLimitStore({ now: c.now, maxKeys: 3 });
    store.hit('expired1', 1000);
    store.hit('expired2', 1000);
    store.hit('live', 60_000);
    c.advance(1000);
    store.hit('new', 60_000); // full: the two expired windows go, 'live' stays
    expect(store.size()).toBe(2);
    expect(store.evictions).toBe(0);
    expect(store.hit('live', 60_000).count).toBe(2);
  });

  it('evicts the window that started earliest, not the busiest or the newest', () => {
    const c = clock();
    store = new RateLimitStore({ now: c.now, maxKeys: 2 });
    store.hit('first', 60_000);
    c.advance(1);
    store.hit('second', 60_000);
    store.hit('second', 60_000);
    c.advance(1);
    store.hit('third', 60_000); // evicts 'first'
    expect(store.evictions).toBe(1);
    expect(store.hit('second', 60_000).count).toBe(3); // kept its counter
    expect(store.hit('first', 60_000).count).toBe(1); // evicted: fresh window (the documented trade-off)
  });

  it('a restarted window moves to the end of the eviction order', () => {
    const c = clock();
    store = new RateLimitStore({ now: c.now, maxKeys: 2 });
    store.hit('a', 1000);
    store.hit('b', 60_000);
    c.advance(1000);
    store.hit('a', 1000); // a's window restarted, so b is now the earliest-started
    store.hit('c', 60_000); // full: b is evicted, not a
    expect(store.hit('a', 1000).count).toBe(2);
  });

  it('rejects a nonsensical cap and has a documented default', () => {
    expect(() => new RateLimitStore({ maxKeys: 0 })).toThrow(RangeError);
    store = new RateLimitStore();
    for (let i = 0; i < 5; i++) store.hit(`k${i}`, 1000);
    expect(COUNT_LIMITS.RATE_LIMIT_MAX_KEYS).toBeGreaterThan(1000);
  });
});

// Open items, tracked so they cannot be forgotten. They are NOT done: see docs/roadmap.md M8 and M10.
describe('open items for M8/M10', () => {
  it.todo(
    'M8: a PER_CONVERSATION_BURST request over the limit is actually answered 429 (needs the authenticated user and the conversation id as keys)',
  );
  it.todo(
    'M8: the global JWT guard runs after the rate limiter (a flood of requests with bad tokens is answered 429, not 401)',
  );
  it.todo(
    'M10: message send and typing events are limited per user and conversation (REST and Socket.IO)',
  );
});
