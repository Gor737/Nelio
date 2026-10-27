// Roadmap M9 prerequisite: a value accepted by the shared code-point helper is NEVER rejected by the SQL CHECK of the column it is
// stored in, for every limited column. Property-style: for each column, candidate strings in several scripts and lengths around
// the limits are really inserted through the real table (each in a transaction that is rolled back), and the helper's verdict is
// compared with the database's. The same data also proves the test is sensitive: the naive `.length` check would have violated it.
import { TEXT_LIMITS } from '../../src/common/constants/limits.js';
import { isValidText } from '../../src/common/decorators/text-length.decorator.js';
import { createPool } from '../support/database.js';
import { LIMITED_COLUMNS } from '../support/text-limit-columns.js';

const pool = createPool(2);
afterAll(() => pool.end());

/** A tiny deterministic generator (mulberry32), so a failure is reproducible. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABETS: Record<string, string> = {
  ascii: 'a',
  armenian: 'ա',
  emoji: '😀',
  combining: 'é',
  zwjFamily: '👨‍👩‍👧',
  flag: '🇦🇲',
  mixed: 'aա😀é',
};

/** Exactly `length` code points made of the repeated `unit` (cut by code points, never inside a surrogate pair). */
function made(unit: string, length: number): string {
  if (length === 0) return '';
  const points = Array.from(unit);
  const out: string[] = [];
  for (let i = 0; i < length; i++) out.push(points[i % points.length]);
  return out.join('');
}

interface Outcome {
  column: string;
  alphabet: string;
  codePoints: number;
  value: string;
  helper: boolean;
  database: 'accepted' | 'check' | 'error';
  sqlstate?: string;
}

/** Tries to store the value in a transaction that is always rolled back. */
async function attempt(
  store: (q: typeof pool, value: string) => Promise<unknown>,
  value: string,
): Promise<Pick<Outcome, 'database' | 'sqlstate'>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await store(client as unknown as typeof pool, value);
      return { database: 'accepted' };
    } catch (error) {
      const code = (error as { code?: string }).code;
      return { database: code === '23514' ? 'check' : 'error', sqlstate: code };
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const outcomes: Outcome[] = [];

describe('a value accepted by the helper is never rejected by the database', () => {
  const random = prng(20261026);

  beforeAll(async () => {
    for (const column of LIMITED_COLUMNS) {
      const range = TEXT_LIMITS[column.limit];
      const edges = [
        range.min - 1,
        range.min,
        range.min + 1,
        range.max - 1,
        range.max,
        range.max + 1,
      ];
      const randoms = Array.from({ length: 4 }, () =>
        Math.floor(random() * (range.max + 4)),
      );
      const lengths = [...new Set([...edges, ...randoms])].filter(
        (n) => n >= 0,
      );
      for (const [alphabet, unit] of Object.entries(ALPHABETS)) {
        for (const codePoints of lengths) {
          const value = made(unit, codePoints);
          const result = await attempt(column.store, value);
          outcomes.push({
            column: column.constraint,
            alphabet,
            codePoints,
            value,
            helper: isValidText(value, range),
            ...result,
          });
        }
      }
    }
  }, 300_000);

  it('checked every limited column with every alphabet around its limits', () => {
    expect(new Set(outcomes.map((o) => o.column)).size).toBe(
      LIMITED_COLUMNS.length,
    );
    expect(new Set(outcomes.map((o) => o.alphabet)).size).toBe(
      Object.keys(ALPHABETS).length,
    );
    expect(outcomes.length).toBeGreaterThan(1000);
  });

  it('PROPERTY: helper accepts => database accepts (no CHECK violation, no other error)', () => {
    const violations = outcomes.filter(
      (o) => o.helper && o.database !== 'accepted',
    );
    expect(
      violations.map(
        (o) =>
          `${o.column} ${o.alphabet} ${o.codePoints} -> ${o.database} ${o.sqlstate ?? ''}`,
      ),
    ).toEqual([]);
    expect(outcomes.filter((o) => o.helper).length).toBeGreaterThan(500); // the property is not vacuous
  });

  it('CONVERSE for length: helper rejects only because of length => the database rejects with the CHECK of that column', () => {
    const wrong = outcomes.filter((o) => !o.helper && o.database !== 'check');
    expect(
      wrong.map(
        (o) =>
          `${o.column} ${o.alphabet} ${o.codePoints} -> ${o.database} ${o.sqlstate ?? ''}`,
      ),
    ).toEqual([]);
    expect(outcomes.filter((o) => !o.helper).length).toBeGreaterThan(100);
  });

  it('both bounds are exact in the database for every column and alphabet: min and max accepted, min-1 and max+1 rejected', () => {
    for (const column of LIMITED_COLUMNS) {
      const range = TEXT_LIMITS[column.limit];
      const of = (codePoints: number) =>
        outcomes.filter(
          (o) => o.column === column.constraint && o.codePoints === codePoints,
        );
      for (const o of of(range.min))
        expect([column.constraint, o.alphabet, o.database]).toEqual([
          column.constraint,
          o.alphabet,
          'accepted',
        ]);
      for (const o of of(range.max))
        expect([column.constraint, o.alphabet, o.database]).toEqual([
          column.constraint,
          o.alphabet,
          'accepted',
        ]);
      if (range.min > 0)
        for (const o of of(range.min - 1))
          expect([column.constraint, o.alphabet, o.database]).toEqual([
            column.constraint,
            o.alphabet,
            'check',
          ]);
      for (const o of of(range.max + 1))
        expect([column.constraint, o.alphabet, o.database]).toEqual([
          column.constraint,
          o.alphabet,
          'check',
        ]);
    }
  });

  it('SENSITIVITY: the naive `.length` check violates the property on this data (so the test would catch it)', () => {
    const naive = outcomes.filter((o) => {
      const range =
        TEXT_LIMITS[
          LIMITED_COLUMNS.find((c) => c.constraint === o.column)!.limit
        ];
      const naiveAccepts =
        o.value.length >= range.min && o.value.length <= range.max;
      return naiveAccepts && o.database !== 'accepted';
    });
    expect(naive.length).toBeGreaterThan(0);
    // the concrete case from the owner's note: ONE emoji for the 2-character tag minimum. `.length` is 2, so the naive check
    // accepts it; PostgreSQL counts one character and refuses it with the CHECK (a 500 in production).
    const oneEmojiTag = outcomes.find(
      (o) =>
        o.column === 'tags_name_length' &&
        o.alphabet === 'emoji' &&
        o.codePoints === 1,
    )!;
    expect(oneEmojiTag.value.length).toBe(2);
    expect(oneEmojiTag.database).toBe('check');
    expect(oneEmojiTag.helper).toBe(false);
    expect(new Set(naive.map((o) => o.alphabet))).toEqual(
      new Set(['emoji', 'zwjFamily', 'flag', 'mixed']),
    );
    // ...and the same naive check would also have rejected valid values (a single emoji for a minimum of 1, for example).
    const tooStrict = outcomes.filter((o) => {
      const range =
        TEXT_LIMITS[
          LIMITED_COLUMNS.find((c) => c.constraint === o.column)!.limit
        ];
      return (
        !(o.value.length >= range.min && o.value.length <= range.max) &&
        o.database === 'accepted'
      );
    });
    expect(tooStrict.length).toBeGreaterThan(0);
  });
});

describe('characters PostgreSQL cannot store', () => {
  const column = LIMITED_COLUMNS.find(
    (c) => c.constraint === 'courses_title_length',
  )!;
  const range = TEXT_LIMITS[column.limit];

  it('a NUL character: the helper rejects it, and the database does refuse it (so no 500 can come from a value the helper accepts)', async () => {
    for (const value of [
      'abc\u0000def',
      '\u0000\u0000\u0000',
      `ok${'\u0000'}`,
    ]) {
      expect(isValidText(value, range)).toBe(false);
      expect((await attempt(column.store, value)).database).not.toBe(
        'accepted',
      );
    }
  });

  it('a lone surrogate: the helper rejects it (the driver would silently replace it with U+FFFD)', () => {
    for (const value of ['abc\uD83D', 'abc\uDE00', '\uDE00\uD83D'])
      expect(isValidText(value, range)).toBe(false);
  });

  it('a value with every kind of ordinary character the helper accepts is stored', async () => {
    const value = `Բարև 😀 é \t line\nbreak "quotes" 'apostrophes' <tag> ; -- DROP`;
    expect(isValidText(value, range)).toBe(true);
    expect((await attempt(column.store, value)).database).toBe('accepted');
  });
});
