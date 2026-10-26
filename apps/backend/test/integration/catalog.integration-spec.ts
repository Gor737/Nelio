// M9b: Catalog against the real database: setCourseTags (normalization, cap, replacement, concurrency) and the public reads.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { COUNT_LIMITS } from '../../src/common/constants/limits.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import {
  DatabaseModule,
  PrismaService,
  TransactionService,
  type Tx,
} from '../../src/infrastructure/database/index.js';
import { EventsModule } from '../../src/infrastructure/events/index.js';
import {
  CatalogModule,
  CourseTagsService,
} from '../../src/modules/catalog/index.js';
import { createPool, resetData } from '../support/database.js';
import {
  createCategory,
  createCourse,
  createTag,
} from '../support/factories-courses.js';
import { testEnv, closeApp } from '../support/integration-app.js';

const pool = createPool();
let app: NestExpressApplication;
let tags: CourseTagsService;
let transactions: TransactionService;
let prisma: PrismaService;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      CatalogModule,
    ],
    providers: GLOBAL_PROVIDERS,
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  tags = app.get(CourseTagsService);
  transactions = app.get(TransactionService);
  prisma = app.get(PrismaService);
});
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
beforeEach(() => resetData(pool));

const set = (courseId: string, names: unknown[]) =>
  transactions.run((tx) => tags.setCourseTags(tx, courseId, names));
const slugsOf = async (courseId: string) =>
  (
    await pool.query<{ slug: string }>(
      'SELECT t.slug FROM course_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.course_id = $1 ORDER BY t.slug',
      [courseId],
    )
  ).rows.map((r) => r.slug);
const allTags = async () =>
  (
    await pool.query<{ slug: string; name: string }>(
      'SELECT slug, name FROM tags ORDER BY slug',
    )
  ).rows;
const invalid = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as {
      code: string;
      status: number;
      errors?: { field: string; messages: string[] }[];
    };
  }
  throw new Error('expected VALIDATION_FAILED');
};

describe('setCourseTags', () => {
  it('creates the tags, links them to the course, and returns them in the order given', async () => {
    const course = await createCourse(pool);
    const result = await set(course, ['Web Development', 'Armenian', 'SQL']);
    expect(result.map((t) => t.slug)).toEqual([
      'web-development',
      'armenian',
      'sql',
    ]);
    expect(result.map((t) => t.name)).toEqual([
      'web development',
      'armenian',
      'sql',
    ]);
    expect(await slugsOf(course)).toEqual([
      'armenian',
      'sql',
      'web-development',
    ]);
    expect((await allTags()).length).toBe(3);
  });

  it('normalizes: other spellings reuse the existing tag instead of creating a second one', async () => {
    const [a, b] = [await createCourse(pool), await createCourse(pool)];
    const first = await set(a, ['JavaScript']);
    const second = await set(b, ['  javascript ', 'JAVASCRIPT', 'JavaScript']);
    expect(second).toHaveLength(1); // three spellings of one tag count once
    expect(second[0].id).toBe(first[0].id);
    expect(await allTags()).toEqual([
      { slug: 'javascript', name: 'javascript' },
    ]);
  });

  it('the first spelling wins the stored name; a later one never renames it', async () => {
    const course = await createCourse(pool);
    await createTag(pool, {
      name: 'machine learning',
      slug: 'machine-learning',
    }); // an older tag, named by someone else
    const result = await set(course, ['Machine   Learning']);
    expect(result[0].name).toBe('machine learning');
    expect((await allTags()).length).toBe(1);
  });

  it('replaces the set: kept tags stay, removed links go, new tags are added; tag rows are never deleted', async () => {
    const course = await createCourse(pool);
    await set(course, ['alpha', 'beta', 'gamma']);
    await set(course, ['beta', 'delta']);
    expect(await slugsOf(course)).toEqual(['beta', 'delta']);
    expect((await allTags()).map((t) => t.slug)).toEqual([
      'alpha',
      'beta',
      'delta',
      'gamma',
    ]); // unused tags remain (an Admin merges them)
    await set(course, []);
    expect(await slugsOf(course)).toEqual([]);
  });

  it('setting the same tags again changes nothing (idempotent)', async () => {
    const course = await createCourse(pool);
    const one = await set(course, ['alpha', 'beta']);
    const two = await set(course, ['beta', 'alpha']);
    expect(two.map((t) => t.id)).toEqual([one[1].id, one[0].id]);
    expect(await slugsOf(course)).toEqual(['alpha', 'beta']);
  });

  it('other courses keep their tags', async () => {
    const [a, b] = [await createCourse(pool), await createCourse(pool)];
    await set(a, ['shared', 'only-a']);
    await set(b, ['shared']);
    await set(a, []);
    expect(await slugsOf(a)).toEqual([]);
    expect(await slugsOf(b)).toEqual(['shared']);
  });

  describe('cap and validation: 400 VALIDATION_FAILED, and nothing is written', () => {
    it(`${COUNT_LIMITS.TAGS_PER_COURSE_MAX} distinct tags are fine, one more is refused`, async () => {
      const course = await createCourse(pool);
      const names = Array.from(
        { length: COUNT_LIMITS.TAGS_PER_COURSE_MAX + 1 },
        (_, i) => `tag number ${i}`,
      );
      await set(course, names.slice(0, COUNT_LIMITS.TAGS_PER_COURSE_MAX));
      const error = await invalid(set(course, names));
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      expect(error.errors).toEqual([
        {
          field: 'tags',
          messages: [
            `a course can have at most ${COUNT_LIMITS.TAGS_PER_COURSE_MAX} tags`,
          ],
        },
      ]);
      expect(await slugsOf(course)).toHaveLength(
        COUNT_LIMITS.TAGS_PER_COURSE_MAX,
      ); // the earlier set is untouched
      expect((await allTags()).length).toBe(COUNT_LIMITS.TAGS_PER_COURSE_MAX); // the eleventh tag was not created either
    });

    it('spelling variants count once toward the cap', async () => {
      const course = await createCourse(pool);
      const variants = Array.from({ length: 30 }, (_, i) =>
        i % 2 ? 'ALPHA' : ' alpha ',
      );
      await expect(
        set(course, [
          ...variants,
          ...Array.from({ length: 9 }, (_, i) => `other ${i}`),
        ]),
      ).resolves.toHaveLength(10);
    });

    it('lists every bad entry with its index, and writes nothing (not even the good ones)', async () => {
      const course = await createCourse(pool);
      const error = await invalid(
        set(course, ['good tag', 'x', 'y'.repeat(31), '!!', 42, 'fine']),
      );
      expect(error.errors?.map((e) => e.field)).toEqual([
        'tags[1]',
        'tags[2]',
        'tags[3]',
        'tags[4]',
      ]);
      expect(error.errors?.[3].messages).toEqual(['tag must be a string']);
      expect(await allTags()).toEqual([]);
      expect(await slugsOf(course)).toEqual([]);
    });

    it('rejects something that is not an array', async () => {
      const course = await createCourse(pool);
      expect(
        (await invalid(set(course, 'javascript' as unknown as unknown[])))
          .errors,
      ).toEqual([{ field: 'tags', messages: ['tags must be an array'] }]);
    });
  });

  describe('concurrency: identical new tags created at the same time', () => {
    it('never fail, never deadlock and never duplicate, even when the transactions list the tags in opposite orders', async () => {
      const rounds = 15;
      for (let round = 0; round < rounds; round++) {
        const [a, b] = [await createCourse(pool), await createCourse(pool)];
        const names = [
          `new ${round} one`,
          `new ${round} two`,
          `new ${round} three`,
          `new ${round} four`,
        ];
        // plain interactive transactions WITHOUT the retry helper: if the ascending insert order did not prevent deadlocks, this would fail
        const run = (courseId: string, order: string[]) =>
          prisma.$transaction((tx: Tx) =>
            tags.setCourseTags(tx, courseId, order),
          );
        const [ra, rb] = await Promise.all([
          run(a, names),
          run(b, [...names].reverse()),
        ]);
        expect(ra).toHaveLength(4);
        expect(new Set([...ra, ...rb].map((t) => t.id)).size).toBe(4); // the same four tag rows for both
      }
      const { rows } = await pool.query(
        'SELECT slug, count(*)::int AS n FROM tags GROUP BY slug HAVING count(*) > 1',
      );
      expect(rows).toEqual([]);
      expect((await allTags()).length).toBe(rounds * 4);
    }, 60_000);

    it('many transactions creating the same brand-new tags in shuffled orders at once all succeed, with exactly one row per tag', async () => {
      const rounds = 30;
      const parallel = 12;
      let seed = 12345;
      const random = () =>
        (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; // deterministic
      const shuffled = <T>(items: T[]) => [...items].sort(() => random() - 0.5);
      for (let round = 0; round < rounds; round++) {
        const names = Array.from(
          { length: COUNT_LIMITS.TAGS_PER_COURSE_MAX },
          (_, i) => `round ${round} tag ${String.fromCharCode(97 + i)}`,
        );
        const courses = await Promise.all(
          Array.from({ length: parallel }, () => createCourse(pool)),
        );
        // plain interactive transactions WITHOUT the retry helper: a deadlock would surface as an error here
        const results = await Promise.all(
          courses.map((course) =>
            prisma.$transaction((tx: Tx) =>
              tags.setCourseTags(tx, course, shuffled(names)),
            ),
          ),
        );
        for (const r of results)
          expect(r).toHaveLength(COUNT_LIMITS.TAGS_PER_COURSE_MAX);
        expect(new Set(results.flatMap((r) => r.map((t) => t.id))).size).toBe(
          COUNT_LIMITS.TAGS_PER_COURSE_MAX,
        );
      }
      const { rows } = await pool.query(
        'SELECT slug FROM tags GROUP BY slug HAVING count(*) > 1',
      );
      expect(rows).toEqual([]);
      expect((await allTags()).length).toBe(
        rounds * COUNT_LIMITS.TAGS_PER_COURSE_MAX,
      );
    }, 120_000);

    it('a transaction that rolls back leaves no tags and no links behind', async () => {
      const course = await createCourse(pool);
      await expect(
        prisma.$transaction(async (tx: Tx) => {
          await tags.setCourseTags(tx, course, ['will vanish']);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await allTags()).toEqual([]);
      expect(await slugsOf(course)).toEqual([]);
    });

    it('a tag merged away between creating it and linking it makes the link insert fail with a foreign-key error (an accepted race: 409)', async () => {
      const course = await createCourse(pool);
      const attempt = prisma.$transaction(async (tx: Tx) => {
        const result = await tags.setCourseTags(tx, course, ['racy tag']);
        return result;
      });
      await expect(attempt).resolves.toHaveLength(1);
      // The accepted race itself (an Admin merge deleting the tag row mid-flight) is exercised in M12 with the merge endpoint; here we only
      // pin that the link has a real foreign key behind it:
      const tagId = (await allTags()).length;
      expect(tagId).toBe(1);
      await expect(
        pool.query(
          'INSERT INTO course_tags (course_id, tag_id) VALUES ($1, uuidv7())',
          [course],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });
});

describe('GET /categories (public)', () => {
  it('lists every category by name with only id, name and slug; empty when there are none', async () => {
    expect(
      (await request(app.getHttpServer()).get('/api/v1/categories').expect(200))
        .body,
    ).toEqual([]);
    const [b, a, c] = [
      await createCategory(pool, { name: 'Business', slug: 'business' }),
      await createCategory(pool, { name: 'Art', slug: 'art' }),
      await createCategory(pool, {
        name: 'Բնագիտություն',
        slug: 'bnagitutyun',
      }),
    ];
    const res = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .expect(200);
    expect(res.body.map((x: { id: string }) => x.id)).toEqual([a, b, c]);
    expect(Object.keys(res.body[0]).sort()).toEqual(['id', 'name', 'slug']);
  });

  it('needs no token, and a broken token is ignored on a public route', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', 'Bearer garbage')
      .expect(200);
  });
});

describe('GET /tags (public autocomplete)', () => {
  const get = (query = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/tags${query}`)
      .set(
        'X-Forwarded-For',
        `10.2.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      );
  const names = async (query = '') =>
    (await get(query).expect(200)).body.map((t: { name: string }) => t.name);

  it('returns tags by prefix, case- and space-insensitively, the most used first', async () => {
    const [c1, c2, c3] = [
      await createCourse(pool),
      await createCourse(pool),
      await createCourse(pool),
    ];
    await set(c1, ['java', 'javascript', 'python']);
    await set(c2, ['javascript', 'java script tricks']);
    await set(c3, ['javascript']);
    expect(await names('?q=jav')).toEqual([
      'javascript',
      'java',
      'java script tricks',
    ]); // 3, 1, 1 uses; ties by name
    expect(await names('?q=JAV')).toEqual([
      'javascript',
      'java',
      'java script tricks',
    ]);
    expect(await names('?q=%20java')).toEqual([
      'javascript',
      'java',
      'java script tricks',
    ]);
    expect(await names('?q=java%20s')).toEqual(['java script tricks']);
    expect(await names('?q=py')).toEqual(['python']);
    expect(await names('?q=zzz')).toEqual([]);
  });

  it('without q it returns the most used tags, at most 20', async () => {
    const course = await createCourse(pool);
    await set(course, ['popular']);
    for (let i = 0; i < 25; i++)
      await createTag(pool, {
        name: `filler ${String(i).padStart(2, '0')}`,
        slug: `filler-${String(i).padStart(2, '0')}`,
      });
    const list = await names();
    expect(list).toHaveLength(COUNT_LIMITS.TAG_AUTOCOMPLETE_MAX_RESULTS);
    expect(list[0]).toBe('popular');
  });

  it('limit lowers the number of results; more than 20 or less than 1 or a non-number is 400', async () => {
    for (let i = 0; i < 5; i++)
      await createTag(pool, { name: `tag ${i}`, slug: `tag-${i}` });
    expect(await names('?limit=3')).toHaveLength(3);
    for (const bad of [
      '?limit=21',
      '?limit=0',
      '?limit=-1',
      '?limit=abc',
      '?limit=1.5',
    ])
      expect((await get(bad).expect(400)).body.code).toBe('VALIDATION_FAILED');
  });

  it('% and _ typed by the user are literal characters, not wildcards', async () => {
    await createTag(pool, { name: 'ab', slug: 'ab' });
    await createTag(pool, { name: 'a_b', slug: 'a_b' });
    await createTag(pool, { name: '100%', slug: '100%' });
    expect(await names('?q=%25')).toEqual([]); // "%" alone is not "everything"
    expect(await names('?q=a_')).toEqual(['a_b']); // "_" is not "any one character" (that would also match "ab")
    expect(await names('?q=100%25')).toEqual(['100%']);
    expect(await names('?q=%5C')).toEqual([]); // a backslash
  });

  it('is safe against SQL injection and rejects an over-long or broken q', async () => {
    await createTag(pool, { name: 'safe', slug: 'safe' });
    expect(await names("?q=' OR '1'='1")).toEqual([]);
    expect(await names('?q=safe%27%3B%20DROP%20TABLE%20tags%3B--')).toEqual([]);
    expect(
      (await pool.query("SELECT 1 FROM tags WHERE slug = 'safe'")).rowCount,
    ).toBe(1);
    expect((await get(`?q=${'x'.repeat(31)}`).expect(400)).body.code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await get('?q=').expect(400)).body.code).toBe('VALIDATION_FAILED');
    expect((await get('?q=a%00b').expect(400)).body.code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await get('?extra=1').expect(400)).body.code).toBe(
      'VALIDATION_FAILED',
    ); // unknown query parameter
  });

  it('works for Armenian tags (prefix typed with different case)', async () => {
    const course = await createCourse(pool);
    await set(course, ['Ծրագրավորում', 'Բարև']);
    expect(await names('?q=%D4%BE%D6%80')).toEqual(['ծրագրավորում']); // "Ծր"
    expect(await names('?q=%D5%A2%D5%A1%D6%80')).toEqual(['բարև']); // "բար"
  });

  it('needs no token; the response has only id, name and slug', async () => {
    await createTag(pool, { name: 'open', slug: 'open' });
    const res = await get('?q=op').expect(200);
    expect(Object.keys(res.body[0]).sort()).toEqual(['id', 'name', 'slug']);
  });
});
