// Unit tests for the RateLimiter service: which keys each class counts in each phase (Decision 167).
import { RATE_LIMIT_CLASSES } from '../../src/common/constants/rate-limit-classes.js';
import { RateLimiter } from '../../src/common/guards/rate-limiter.js';

let limiter: RateLimiter;
beforeEach(() => {
  limiter = new RateLimiter();
});
afterEach(() => limiter.onModuleDestroy());

const spend = (times: number, fn: () => { allowed: boolean }) =>
  Array.from({ length: times }, () => fn().allowed);

describe('RateLimiter', () => {
  describe('pre-auth phase (ip, email)', () => {
    it('STRICT counts the ip and the email separately: five requests pass, the sixth is refused', () => {
      const hit = () =>
        limiter.consume(
          'STRICT',
          { ip: '1.1.1.1', email: 'a@x.test' },
          'pre-auth',
        );
      expect(spend(5, hit).every(Boolean)).toBe(true);
      expect(hit()).toMatchObject({ allowed: false });
      expect(hit().retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });

    it('the email counter limits one address across many IPs, case-insensitively', () => {
      for (let i = 0; i < 5; i++)
        limiter.consume(
          'STRICT',
          { ip: `10.0.0.${i}`, email: 'Victim@X.test ' },
          'pre-auth',
        );
      expect(
        limiter.consume(
          'STRICT',
          { ip: '10.0.0.99', email: 'victim@x.test' },
          'pre-auth',
        ).allowed,
      ).toBe(false);
    });

    it('a request without an email is counted by ip only', () => {
      const hit = () =>
        limiter.consume('STRICT', { ip: '2.2.2.2' }, 'pre-auth');
      expect(spend(5, hit).every(Boolean)).toBe(true);
      expect(hit().allowed).toBe(false);
    });

    it('classes keep separate budgets for the same ip', () => {
      spend(6, () => limiter.consume('STRICT', { ip: '3.3.3.3' }, 'pre-auth'));
      expect(
        limiter.consume('DEFAULT', { ip: '3.3.3.3' }, 'pre-auth').allowed,
      ).toBe(true);
    });

    it('consumes nothing for a class that has no pre-auth key (Per-conversation burst)', () => {
      limiter.consume(
        'PER_CONVERSATION_BURST',
        { ip: '4.4.4.4', userId: 'u', conversationId: 'c' },
        'pre-auth',
      );
      expect(limiter.size()).toBe(0);
    });
  });

  describe('post-auth phase (user, conversation)', () => {
    const burst = RATE_LIMIT_CLASSES.PER_CONVERSATION_BURST;

    it('Per-conversation burst: the limit is per user per conversation (the 31st is refused)', () => {
      const hit = () =>
        limiter.consume(
          'PER_CONVERSATION_BURST',
          { userId: 'u1', conversationId: 'c1' },
          'post-auth',
        );
      expect(burst.limit).toBe(30);
      expect(spend(30, hit).every(Boolean)).toBe(true);
      expect(hit()).toMatchObject({ allowed: false });
    });

    it('another conversation and another user have their own budget; the same user is not limited by a busy conversation', () => {
      spend(31, () =>
        limiter.consume(
          'PER_CONVERSATION_BURST',
          { userId: 'u1', conversationId: 'c1' },
          'post-auth',
        ),
      );
      expect(
        limiter.consume(
          'PER_CONVERSATION_BURST',
          { userId: 'u1', conversationId: 'c2' },
          'post-auth',
        ).allowed,
      ).toBe(true);
      expect(
        limiter.consume(
          'PER_CONVERSATION_BURST',
          { userId: 'u2', conversationId: 'c1' },
          'post-auth',
        ).allowed,
      ).toBe(true);
    });

    it('many users in one conversation do not share one 30-message budget', () => {
      for (let u = 0; u < 5; u++)
        expect(
          spend(30, () =>
            limiter.consume(
              'PER_CONVERSATION_BURST',
              { userId: `u${u}`, conversationId: 'c' },
              'post-auth',
            ),
          ).every(Boolean),
        ).toBe(true);
    });

    it('a missing conversation id is counted as one shared "no conversation" bucket: stricter, never unlimited', () => {
      const hit = () =>
        limiter.consume(
          'PER_CONVERSATION_BURST',
          { userId: 'u1' },
          'post-auth',
        );
      expect(spend(30, hit).every(Boolean)).toBe(true);
      expect(hit().allowed).toBe(false);
    });

    it('TIGHT counts the user in this phase (and the ip in the other one)', () => {
      const hit = () =>
        limiter.consume('TIGHT', { userId: 'u1', ip: '5.5.5.5' }, 'post-auth');
      expect(spend(20, hit).every(Boolean)).toBe(true);
      expect(hit().allowed).toBe(false);
      expect(
        limiter.consume('TIGHT', { ip: '5.5.5.5' }, 'pre-auth').allowed,
      ).toBe(true); // the ip counter is untouched here
    });

    it('does nothing without a user, and for a class with no user key', () => {
      expect(limiter.consume('TIGHT', {}, 'post-auth').allowed).toBe(true);
      limiter.consume('STRICT', { userId: 'u' }, 'post-auth');
      limiter.consume('DEFAULT', { userId: 'u' }, 'post-auth');
      expect(limiter.size()).toBe(0);
    });
  });
});
