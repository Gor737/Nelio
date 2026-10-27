import { TEXT_LIMITS } from '../../../common/constants/limits.js';
import { codePointLength } from '../../../common/decorators/index.js';

/**
 * Passwords (Decision 146): 10-128 characters (counted in code points), NO composition rules, and not a very common password.
 * The common-password check is a small built-in list of passwords that are long enough to pass the length rule yet are the first ones an
 * attacker tries (a proposed default: docs/proposed-defaults.md section 15). Comparison ignores case, and also rejects such a password
 * with up to six digits or symbols added at the end, and a single repeated character.
 */
const COMMON = [
  '1234567890',
  '12345678910',
  '123456789012',
  '0123456789',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  '1q2w3e4r5t6y',
  'qwertyuiop',
  'qwertyuiop1',
  'qwerty1234',
  'qwerty12345',
  'qwertyuiopasdfghjkl',
  'asdfghjkl1',
  'asdfghjkl',
  'zxcvbnm123',
  'zxcvbnmasdf',
  'password12',
  'password123',
  'password1234',
  'password1!',
  'password!',
  'passw0rd123',
  'p@ssw0rd123',
  'p@ssword123',
  'p@ssw0rd!!',
  'password01',
  'password001',
  'iloveyou12',
  'iloveyou123',
  'iloveyou1234',
  'letmein123',
  'letmein1234',
  'welcome123',
  'welcome1234',
  'welcome12345',
  'adminadmin',
  'admin12345',
  'admin123456',
  'administrator',
  'abc1234567',
  'abcdefghij',
  'abcd123456',
  'abcdef1234',
  'qazwsxedc',
  'qazwsxedc123',
  'monkey1234',
  'dragon1234',
  'football123',
  'baseball123',
  'superman123',
  'trustno1234',
  'sunshine123',
  'princess123',
  'starwars123',
  'whatever123',
  'internet123',
  'computer123',
  'michael1234',
  'jordan23456',
  'changeme123',
  'changeme12',
  'default1234',
  'test123456',
  'testtest12',
  'master12345',
  'login12345',
  'hello12345',
  'freedom123',
  'shadow12345',
  'killer12345',
  'pass123456',
  'pass1234567',
  'nelio12345',
  'nelio123456',
  'armenia123',
  'yerevan123',
  'barev12345',
  'barevdzez',
  'hayastan123',
];
const COMMON_SET = new Set(COMMON);

/** Words that stay guessable when digits or symbols are added to the end (up to six). */
const BASE_WORDS = new Set([
  'password',
  'passw0rd',
  'p@ssword',
  'p@ssw0rd',
  'qwerty',
  'qwertyuiop',
  'iloveyou',
  'letmein',
  'welcome',
  'admin',
  'administrator',
  'changeme',
  'dragon',
  'monkey',
  'football',
  'baseball',
  'superman',
  'sunshine',
  'princess',
  'starwars',
  'whatever',
  'internet',
  'computer',
  'master',
  'login',
  'hello',
  'freedom',
  'shadow',
  'killer',
  'trustno',
  'default',
  'testtest',
  'nelio',
  'armenia',
  'yerevan',
  'barev',
  'barevdzez',
  'hayastan',
  'abcdef',
  'asdfghjkl',
  'zxcvbnm',
  'qazwsx',
]);

const REASON = 'This password is too common; choose a less predictable one';

export interface PasswordProblem {
  readonly message: string;
}

/** Returns why a password is refused, or null when it is acceptable. Length is checked with the shared code-point helper. */
export function checkPassword(password: string): PasswordProblem | null {
  const length = codePointLength(password);
  const { min, max } = TEXT_LIMITS.PASSWORD;
  if (length < min || length > max)
    return { message: `The password must be ${min}-${max} characters long` };
  const lower = password.toLowerCase();
  if (new Set(Array.from(lower)).size === 1) return { message: REASON };
  if (COMMON_SET.has(lower)) return { message: REASON };
  const base = lower.replace(/[0-9!@#$%^&*._-]+$/u, '');
  const suffix = lower.length - base.length;
  if (
    suffix >= 1 &&
    suffix <= 6 &&
    base.length >= 4 &&
    (COMMON_SET.has(base) || BASE_WORDS.has(base))
  )
    return { message: REASON };
  return null;
}
