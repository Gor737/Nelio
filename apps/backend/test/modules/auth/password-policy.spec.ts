import { describe, expect, it } from '@jest/globals';
import { checkPassword } from '../../../src/modules/auth/services/password-policy.js';

describe('checkPassword (Decision 146)', () => {
  it.each([
    ['correct horse battery'],
    ['a-very-long-passphrase-with-words'],
    ['ա'.repeat(5) + 'բ'.repeat(5)], // 10 Armenian code points
    ['😀😀😀😀😀😀😀😀😀🙂'], // 10 emoji: 20 UTF-16 units but 10 characters
    ['x'.repeat(127) + 'y'], // 128: the maximum
    ['no composition rules apply here'],
  ])('accepts %s', (password) => {
    expect(checkPassword(password)).toBeNull();
  });

  it.each([
    ['short', 'length'],
    ['123456789', 'length'], // 9 characters
    ['x'.repeat(129), 'length'],
    ['😀'.repeat(9), 'length'], // 9 characters although 18 UTF-16 units
    ['password123', 'common'],
    ['PASSWORD123', 'common'],
    ['Password123', 'common'],
    ['qwertyuiop', 'common'],
    ['1234567890', 'common'],
    ['iloveyou123', 'common'],
    ['password123!!', 'common'], // a common password with symbols added
    ['letmein1234', 'common'],
    ['aaaaaaaaaaaa', 'common'], // one repeated character
    ['😀😀😀😀😀😀😀😀😀😀', 'common'],
  ])('refuses %s (%s)', (password) => {
    expect(checkPassword(password)).not.toBeNull();
  });

  it('counts code points, so the limits match the database and the DTO helper', () => {
    expect(checkPassword('😀'.repeat(5) + '🙂'.repeat(5))).toBeNull();
    expect(checkPassword('😀'.repeat(4) + '🙂'.repeat(5))).toMatchObject({
      message: expect.stringContaining('10-128'),
    });
  });
});
