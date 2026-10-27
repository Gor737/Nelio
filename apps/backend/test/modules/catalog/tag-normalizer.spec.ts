// Unit tests for tag normalization (Decisions 44 and 62, roadmap M9b: "normalization"). The rules are proposed defaults, section 13.
import {
  normalizeTag,
  normalizeTagPrefix,
} from '../../../src/modules/catalog/services/tag-normalizer.js';

const ok = (raw: string) => {
  const result = normalizeTag(raw);
  if (!result.ok)
    throw new Error(`expected "${raw}" to be a valid tag: ${result.problem}`);
  return result.tag;
};
const problem = (raw: unknown) => {
  const result = normalizeTag(raw);
  return result.ok ? undefined : result.problem;
};

describe('normalizeTag', () => {
  it.each([
    ['javascript', 'javascript', 'javascript'],
    ['JavaScript', 'javascript', 'javascript'],
    ['  JAVASCRIPT  ', 'javascript', 'javascript'],
    ['Web   Development', 'web development', 'web-development'],
    ['web-development', 'web-development', 'web-development'],
    ['Web \t\n Development', 'web development', 'web-development'],
    ['C++', 'c++', 'c++'],
    ['C#', 'c#', 'c#'],
    ['node.js', 'node.js', 'node.js'],
    ['Python 3', 'python 3', 'python-3'],
    ['2024', '2024', '2024'],
  ])('%j -> name %j, slug %j', (raw, name, slug) => {
    expect(ok(raw)).toEqual({ name, slug });
  });

  it('different spellings of one tag give one slug (so they are one tag)', () => {
    const slugs = new Set(
      [
        'Machine Learning',
        'machine learning',
        ' MACHINE   LEARNING ',
        'machine-learning',
      ].map((raw) => ok(raw).slug),
    );
    expect(slugs).toEqual(new Set(['machine-learning']));
  });

  it('keeps tags that differ in more than spelling apart: c++, c# and f# are three tags', () => {
    expect(new Set(['C++', 'C#', 'F#'].map((raw) => ok(raw).slug)).size).toBe(
      3,
    );
  });

  it('a one-letter tag such as "C" or "R" is refused: the approved minimum for a tag name is 2 characters', () => {
    expect(problem('C')).toMatch(/between 2 and 30/);
    expect(problem('R')).toMatch(/between 2 and 30/);
    expect(problem('R ')).toMatch(/between 2 and 30/);
  });

  it('Armenian text is lowercased with the Unicode case mapping', () => {
    expect(ok('Բարև Աշխարհ')).toEqual({
      name: 'բարև աշխարհ',
      slug: 'բարև-աշխարհ',
    });
    expect(ok('ԾՐԱԳՐԱՎՈՐՈՒՄ').name).toBe('ծրագրավորում');
  });

  it('keeps the Armenian letter և (U+0587) as it is: NFKC alone would rewrite it as եւ and change the spelling of the word', () => {
    expect('Բարև'.normalize('NFKC')).toBe('Բարեւ'); // the trap
    expect(ok('Բարև').name).toBe('բարև');
    expect(normalizeTagPrefix('Բարև')).toBe('բարև');
    expect(ok('ԵՒ ԵՎ').name).toBe('եւ եվ'); // other letters are lowercased as usual
    for (const ligature of ['\ufb13', '\ufb14', '\ufb15', '\ufb16', '\ufb17'])
      expect(ok(`aa${ligature}`).name).toBe(`aa${ligature}`);
  });

  it('applies NFKC: full-width letters, ligatures and decomposed accents become their canonical form', () => {
    expect(ok('ＪａｖａＳｃｒｉｐｔ').name).toBe('javascript'); // full-width Latin
    expect(ok('ﬁnance').name).toBe('finance'); // the fi ligature
    expect(ok('café').name).toBe('café'); // e + combining acute -> é, one character
    expect(ok('café').slug).toBe(ok('café').slug);
  });

  it('removes invisible and control characters, so look-alike duplicates cannot exist', () => {
    const plain = ok('react').slug;
    for (const hidden of ['​', '‌', '‍', '⁠', '﻿', '­'])
      expect(ok(`re${hidden}act`).slug).toBe(plain);
    expect(ok('re\u0007act').name).toBe('re act'); // a control character becomes a separator
    expect(ok('​hello​').name).toBe('hello');
  });

  describe('length is counted in code points AFTER cleaning (2 to 30)', () => {
    it('too short after cleaning', () => {
      expect(problem('a')).toMatch(/between 2 and 30 characters/);
      expect(problem('  a  ')).toMatch(/between 2 and 30/);
      expect(problem('')).toMatch(/between 2 and 30/);
      expect(problem('   ')).toMatch(/between 2 and 30/);
      expect(problem('​​')).toMatch(/between 2 and 30/);
    });

    it('the bounds are exact, with ASCII, Armenian and astral characters', () => {
      expect(problem('ab')).toBeUndefined();
      expect(problem('x'.repeat(30))).toBeUndefined();
      expect(problem('x'.repeat(31))).toMatch(/between 2 and 30/);
      expect(problem('ա'.repeat(30))).toBeUndefined();
      expect(problem('ա'.repeat(31))).toMatch(/between 2 and 30/);
      expect(problem('𝒜𝒷'.repeat(15))).toBeUndefined(); // 30 mathematical letters, NFKC folds them to plain a/b
    });

    it('a name that is too long before cleaning but fine after is accepted (cleaning happens first)', () => {
      expect(
        problem(`${' '.repeat(40)}react${' '.repeat(40)}`),
      ).toBeUndefined();
      expect(problem(`re${'​'.repeat(50)}act`)).toBeUndefined();
    });

    it('a name that is fine before NFKC but too long after it is refused (the stored value is what is limited)', () => {
      expect(problem('㍿'.repeat(10))).toMatch(/between 2 and 30/); // each expands to 4 characters: 40
    });
  });

  it('requires a letter or a digit', () => {
    for (const raw of ['!!', '--', '😀😀', '+-+', '...'])
      expect(problem(raw)).toBe('must contain at least one letter or digit');
    expect(problem('+1')).toBeUndefined();
  });

  it('refuses what is not text', () => {
    for (const raw of [undefined, null, 42, {}, ['a'], true])
      expect(problem(raw)).toBe('must be a string');
    expect(problem('ab\u0000cd')).toBeUndefined(); // NUL is a control character: cleaned to a space, like any other
    expect(ok('ab\u0000cd').name).toBe('ab cd');
    expect(problem('ab\uD83D')).toMatch(/between 2 and 30/); // a lone surrogate never reaches the database (text validity check)
  });

  it('the result always satisfies the database CHECK (2-30 characters)', () => {
    for (const raw of [
      'ab',
      'x'.repeat(30),
      'ա'.repeat(30),
      'a b',
      'ＡＢ',
      'a​b',
    ]) {
      const tag = ok(raw);
      const length = Array.from(tag.name).length;
      expect(length).toBeGreaterThanOrEqual(2);
      expect(length).toBeLessThanOrEqual(30);
    }
  });
});

describe('normalizeTagPrefix (search)', () => {
  it.each([
    ['Java', 'java'],
    ['  java', 'java'],
    ['web dev', 'web-dev'],
    ['web   dev', 'web-dev'],
    ['Web-', 'web-'],
    ['web ', 'web-'],
    ['Բար', 'բար'],
    ['ＪＡＶＡ', 'java'],
    ['re​act', 'react'],
    ['a', 'a'],
    ['', ''],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeTagPrefix(raw)).toBe(expected);
  });
});
