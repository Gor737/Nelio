import { describe, expect, it } from '@jest/globals';
import {
  EMAIL_TOKEN_TYPES,
  emailTokenLifetime,
} from '../../src/common/constants/email-tokens.js';
import { TIME_LIMITS } from '../../src/common/constants/limits.js';
import {
  emailVerification,
  passwordReset,
} from '../../src/infrastructure/mail/mail.templates.js';

const HOUR = 60 * 60 * 1000;
const url = 'http://localhost:3001/x?token=abc';

describe('email token lifetimes (M11a: the email and the stored expiry state the same lifetime)', () => {
  it('verification lasts 24 hours and a reset 1 hour (architecture section 11)', () => {
    expect(emailTokenLifetime('EMAIL_VERIFICATION')).toEqual({
      ttlMs: 24 * HOUR,
      validForHours: 24,
    });
    expect(emailTokenLifetime('PASSWORD_RESET')).toEqual({
      ttlMs: HOUR,
      validForHours: 1,
    });
    expect(TIME_LIMITS.EMAIL_VERIFICATION_TOKEN_TTL_MS).toBe(24 * HOUR);
    expect(TIME_LIMITS.PASSWORD_RESET_TOKEN_TTL_MS).toBe(HOUR);
  });

  it.each(EMAIL_TOKEN_TYPES)(
    '%s: the hours in the email are exactly the stored lifetime in hours',
    (type) => {
      const { ttlMs, validForHours } = emailTokenLifetime(type);
      expect(validForHours * HOUR).toBe(ttlMs);
      const mail =
        type === 'EMAIL_VERIFICATION'
          ? emailVerification({ fullName: 'Ani', url, validForHours })
          : passwordReset({ fullName: 'Ani', url, validForHours });
      const hours = /(\d+) hours?/.exec(mail.text);
      expect(Number(hours?.[1])).toBe(ttlMs / HOUR);
    },
  );

  it('the old single constant is gone, so nothing can still use one lifetime for both', () => {
    expect(Object.keys(TIME_LIMITS)).not.toContain('EMAIL_TOKEN_TTL_MS');
  });
});
