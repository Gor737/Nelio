// Unit tests for the code-point length helper (roadmap M9, owner decision 2026-10-26): the DTO counts characters the way
// PostgreSQL's char_length does, with the bounds taken from TEXT_LIMITS. Whether the database really agrees, for every limited
// column, is proved in test/integration/text-limits-consistency.integration-spec.ts.
import 'reflect-metadata';
import { validate } from 'class-validator';
import { TEXT_LIMITS } from '../../src/common/constants/limits.js';
import {
  TextLength,
  codePointLength,
  isValidText,
  textLengthApi,
} from '../../src/common/decorators/text-length.decorator.js';

// Characters used below, spelled out so the intent is visible.
const ARMENIAN = 'Բարև Ձեզ'; // 8 characters, every one in the Basic Multilingual Plane (2 bytes in UTF-8)
const EMOJI = '😀'; // one character, two UTF-16 code units, 4 bytes in UTF-8
const FAMILY = '👨‍👩‍👧'; // man + ZWJ + woman + ZWJ + girl: ONE glyph, FIVE code points
const FLAG = '🇦🇲'; // two regional-indicator code points
const E_COMBINING = 'é'; // e + combining acute accent: 2 code points
const E_PRECOMPOSED = 'é'; // é as one code point
const ARMENIAN_COMBINED = 'ա̈'; // an Armenian letter plus a combining diaeresis: 2 code points

describe('codePointLength', () => {
  it.each([
    ['empty', '', 0],
    ['ASCII', 'abc', 3],
    ['Armenian', ARMENIAN, 8],
    ['one emoji', EMOJI, 1],
    ['three emoji', EMOJI.repeat(3), 3],
    ['a flag (two regional indicators)', FLAG, 2],
    ['a ZWJ family (three people and two joiners)', FAMILY, 5],
    ['combining accent, decomposed', E_COMBINING, 2],
    ['combining accent, precomposed', E_PRECOMPOSED, 1],
    ['Armenian with a combining mark', ARMENIAN_COMBINED, 2],
    ['mixed', `a${ARMENIAN}${EMOJI}`, 10],
    ['astral CJK extension B', '\u{20000}\u{20001}', 2],
    ['line breaks count as characters', 'a\r\nb', 4],
  ])('%s', (_label, value, expected) => {
    expect(codePointLength(value)).toBe(expected);
  });

  it('differs from .length exactly where a character needs two UTF-16 units (the bug this helper prevents)', () => {
    expect(EMOJI.length).toBe(2);
    expect(codePointLength(EMOJI)).toBe(1);
    expect(ARMENIAN.length).toBe(codePointLength(ARMENIAN)); // BMP text: same
    expect(FAMILY.length).toBe(8);
    expect(codePointLength(FAMILY)).toBe(5);
  });

  it('counts the same as the spread-based definition [...value].length', () => {
    for (const value of [
      '',
      'abc',
      ARMENIAN,
      EMOJI,
      FAMILY,
      FLAG,
      `${E_COMBINING}${EMOJI}x`,
      '\u{1F600}\u{1F601}\u{1F602}',
    ])
      expect(codePointLength(value)).toBe(Array.from(value).length);
  });
});

describe('isValidText with TEXT_LIMITS.TAG_NAME (2 to 30 characters)', () => {
  const tag = TEXT_LIMITS.TAG_NAME;

  it('ASCII: both bounds are inclusive', () => {
    expect(isValidText('a', tag)).toBe(false);
    expect(isValidText('ab', tag)).toBe(true);
    expect(isValidText('x'.repeat(30), tag)).toBe(true);
    expect(isValidText('x'.repeat(31), tag)).toBe(false);
  });

  it('Armenian: counted in characters, not bytes (30 Armenian letters are 60 bytes and still valid)', () => {
    expect(isValidText('ա', tag)).toBe(false);
    expect(isValidText('աբ', tag)).toBe(true);
    expect(isValidText('ա'.repeat(30), tag)).toBe(true);
    expect(isValidText('ա'.repeat(31), tag)).toBe(false);
    expect(Buffer.byteLength('ա'.repeat(30))).toBe(60);
  });

  it('emoji: ONE emoji is one character, so it is too short for a minimum of 2; two emoji are enough (.length would say 2 for one)', () => {
    expect(isValidText(EMOJI, tag)).toBe(false);
    expect(isValidText(EMOJI.repeat(2), tag)).toBe(true);
    expect(isValidText(EMOJI.repeat(30), tag)).toBe(true);
    expect(isValidText(EMOJI.repeat(31), tag)).toBe(false);
    expect(EMOJI.length >= tag.min).toBe(true); // the naive check would have accepted a single emoji
  });

  it('combining characters: the decomposed form counts 2, the precomposed form counts 1', () => {
    expect(isValidText(E_PRECOMPOSED, tag)).toBe(false);
    expect(isValidText(E_COMBINING, tag)).toBe(true);
    expect(isValidText(ARMENIAN_COMBINED, tag)).toBe(true);
    expect(isValidText(E_COMBINING.repeat(15), tag)).toBe(true); // 30 code points
    expect(isValidText(E_COMBINING.repeat(16), tag)).toBe(false); // 32
  });

  it('a ZWJ family counts 5 and a flag counts 2', () => {
    expect(isValidText(FAMILY.repeat(6), tag)).toBe(true); // 30
    expect(isValidText(FAMILY.repeat(7), tag)).toBe(false); // 35
    expect(isValidText(FLAG, tag)).toBe(true);
  });

  it('a limit with no minimum (COURSE_DESCRIPTION, 0 to 5000) accepts the empty string', () => {
    expect(isValidText('', TEXT_LIMITS.COURSE_DESCRIPTION)).toBe(true);
    expect(isValidText('x'.repeat(5000), TEXT_LIMITS.COURSE_DESCRIPTION)).toBe(
      true,
    );
    expect(isValidText('x'.repeat(5001), TEXT_LIMITS.COURSE_DESCRIPTION)).toBe(
      false,
    );
    expect(
      isValidText(EMOJI.repeat(5000), TEXT_LIMITS.COURSE_DESCRIPTION),
    ).toBe(true); // 10 000 UTF-16 units
  });

  it('rejects values PostgreSQL cannot store, whatever their length', () => {
    expect(isValidText('ab\u0000cd', tag)).toBe(false); // NUL: 22021 in PostgreSQL
    expect(isValidText('\u0000\u0000', tag)).toBe(false);
    expect(isValidText('ab\uD83D', tag)).toBe(false); // lone high surrogate
    expect(isValidText('ab\uDE00', tag)).toBe(false); // lone low surrogate
    expect(isValidText('\uDE00\uD83D', tag)).toBe(false); // reversed pair
    expect(isValidText('ab😀', tag)).toBe(true); // a proper pair is fine
  });

  it('rejects anything that is not a string', () => {
    for (const value of [undefined, null, 12, ['ab'], { length: 5 }, true])
      expect(isValidText(value, tag)).toBe(false);
  });

  it('control characters other than NUL are valid text (PostgreSQL stores them; trimming is the service`s business)', () => {
    expect(isValidText('a\tb\nc', tag)).toBe(true);
  });
});

describe('textLengthApi', () => {
  it('gives the OpenAPI minLength/maxLength of a range (JSON Schema counts characters, like the helper)', () => {
    expect(textLengthApi(TEXT_LIMITS.COURSE_TITLE)).toEqual({
      minLength: 3,
      maxLength: 120,
    });
    expect(textLengthApi(TEXT_LIMITS.COURSE_DESCRIPTION)).toEqual({
      maxLength: 5000,
    }); // no minLength when the minimum is 0
  });
});

describe('@TextLength as a DTO decorator', () => {
  class TagDto {
    @TextLength(TEXT_LIMITS.TAG_NAME)
    name!: string;
  }
  class OptionalDto {
    @TextLength(TEXT_LIMITS.COURSE_DESCRIPTION)
    description?: string;
  }
  const dto = <T extends object>(
    type: new () => T,
    values: Record<string, unknown>,
  ) => Object.assign(new type(), values);
  const messagesOf = async (object: object) =>
    (await validate(object)).flatMap((e) => Object.values(e.constraints ?? {}));

  it('accepts a value inside the limit and says nothing', async () => {
    expect(await messagesOf(dto(TagDto, { name: 'courses' }))).toEqual([]);
    expect(await messagesOf(dto(TagDto, { name: EMOJI.repeat(2) }))).toEqual(
      [],
    );
  });

  it('rejects a single emoji for a minimum of 2 (where @Length would accept it) and names the limit in the message', async () => {
    const messages = await messagesOf(dto(TagDto, { name: EMOJI }));
    expect(messages).toEqual([
      'name must be between 2 and 30 characters and must not contain NUL or broken surrogate characters',
    ]);
  });

  it('rejects too short, too long, NUL, a non-string and a missing value', async () => {
    for (const name of ['a', 'x'.repeat(31), 'ab\u0000', 42, undefined, null])
      expect((await messagesOf(dto(TagDto, { name }))).length).toBeGreaterThan(
        0,
      );
  });

  it('for a limit with no minimum the message states only the maximum', async () => {
    const messages = await messagesOf(
      dto(OptionalDto, { description: 'x'.repeat(5001) }),
    );
    expect(
      messages.some((m) =>
        m.startsWith('description must be at most 5000 characters'),
      ),
    ).toBe(true);
  });

  it('the bounds come from the constant: changing TEXT_LIMITS.TAG_NAME would change the validator (it holds the same object values)', () => {
    const range = {
      min: TEXT_LIMITS.TAG_NAME.min,
      max: TEXT_LIMITS.TAG_NAME.max,
    };
    expect([range.min, range.max]).toEqual([2, 30]);
    expect(isValidText('x'.repeat(range.max), TEXT_LIMITS.TAG_NAME)).toBe(
      isValidText('x'.repeat(range.max), range),
    );
  });
});
