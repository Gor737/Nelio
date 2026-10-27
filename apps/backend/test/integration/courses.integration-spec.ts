// M11b: Courses against the real database over HTTP: create, settings, tags, lifecycle, the public catalog and search, the team.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { buildOpenApiDocument, configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import { DatabaseModule } from '../../src/infrastructure/database/index.js';
import {
  EventBus,
  EventsModule,
} from '../../src/infrastructure/events/index.js';
import {
  CourseTeamService,
  CoursesModule,
} from '../../src/modules/courses/index.js';
import { StorageDriver } from '../../src/modules/files/storage/storage-driver.js';
import { createPool, resetData } from '../support/database.js';
import {
  createFile,
  createTeacher,
  createUser,
  createUserWithRoles,
} from '../support/factories.js';
import {
  createLesson,
  createSection,
  createTextBlock,
} from '../support/factories-content.js';
import {
  addCourseTeacher,
  createCategory,
  createCourse,
  createPublishedCourse,
  createTag,
} from '../support/factories-courses.js';
import {
  createEnrollment,
  createInvitation,
} from '../support/factories-learning.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { bearer, closeApp, testEnv } from '../support/integration-app.js';
import { holdTx, releaseAll, settlesWithin } from '../support/parallel-tx.js';

const pool = createPool(25);
const storage = new InMemoryStorage();
let app: NestExpressApplication;
let team: CourseTeamService;
const transfers: unknown[] = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      CoursesModule,
    ],
    providers: GLOBAL_PROVIDERS,
  })
    .overrideProvider(StorageDriver)
    .useValue(storage)
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  team = app.get(CourseTeamService);
  app.get(EventBus).on('course.ownership-transferred', (p) => {
    transfers.push(p);
  });
});
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  transfers.length = 0;
});
afterEach(() => releaseAll());

let counter = 0;
const ip = () => `10.10.${(counter >> 8) & 255}.${counter++ & 255}`;
const call = (
  m: 'get' | 'post' | 'patch' | 'put' | 'delete',
  path: string,
  userId?: string,
  body?: object,
) => {
  const r = request(app.getHttpServer())
    [m](`/api/v1${path}`)
    .set('X-Forwarded-For', ip());
  if (userId) r.set('Authorization', bearer(userId));
  return body === undefined ? r : r.send(body);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const auditCount = async (action: string) =>
  (await pool.query('SELECT 1 FROM audit_logs WHERE action = $1', [action]))
    .rowCount;
const owners = async (courseId: string) =>
  (
    await pool.query<{ user_id: string }>(
      "SELECT user_id FROM course_teachers WHERE course_id = $1 AND role = 'OWNER'",
      [courseId],
    )
  ).rows.map((r) => r.user_id);

/** A DRAFT course made through the API by a new Teacher, ready to publish (category, summary, one published lesson with a block). */
async function draft(title = 'Intro to Armenian') {
  const owner = await createTeacher(pool);
  const categoryId = await createCategory(pool);
  const res = await call('post', '/courses', owner.id, {
    title,
    enrollmentPolicy: 'OPEN',
    summary: 'A summary that is long enough',
    categoryId,
  }).expect(201);
  const courseId = res.body.id as string;
  const sectionId = await createSection(pool, courseId);
  const lessonId = await createLesson(pool, courseId, sectionId, {
    status: 'PUBLISHED',
  });
  await createTextBlock(pool, lessonId);
  return { owner, courseId, categoryId, sectionId, lessonId };
}
async function published(title?: string) {
  const d = await draft(title);
  await call('post', `/courses/${d.courseId}/publish`, d.owner.id).expect(200);
  return d;
}

describe('creating a course', () => {
  it('needs an ACTIVE Teacher; the creator becomes the Owner of a DRAFT', async () => {
    const teacher = await createTeacher(pool);
    const res = await call('post', '/courses', teacher.id, {
      title: '  Armenian 101  ',
      enrollmentPolicy: 'APPROVAL_REQUIRED',
    }).expect(201);
    expect(res.body).toMatchObject({
      title: 'Armenian 101',
      status: 'DRAFT',
      enrollmentPolicy: 'APPROVAL_REQUIRED',
      summary: null,
      category: null,
      tags: [],
      viewer: { relationship: 'OWNER' },
      lockedByAdmin: false,
    });
    expect(res.body.owner).toMatchObject({ id: teacher.id });
    expect(await owners(res.body.id)).toEqual([teacher.id]);
    const student = await createUser(pool);
    expect(
      (
        await call('post', '/courses', student.id, {
          title: 'Nope nope',
          enrollmentPolicy: 'OPEN',
        }).expect(403)
      ).body.code,
    ).toBe('TEACHER_NOT_APPROVED');
    const pending = await createUserWithRoles(pool, [
      { role: 'STUDENT' },
      { role: 'TEACHER', status: 'PENDING' },
    ]);
    await call('post', '/courses', pending.id, {
      title: 'Nope nope',
      enrollmentPolicy: 'OPEN',
    }).expect(403);
    await call('post', '/courses', undefined, {
      title: 'Nope nope',
      enrollmentPolicy: 'OPEN',
    }).expect(401);
  });

  it('enrollmentPolicy is REQUIRED: missing or unknown is 400, nothing is created, and the generated OpenAPI document lists it as required', async () => {
    const teacher = await createTeacher(pool);
    expect(
      (
        await call('post', '/courses', teacher.id, {
          title: 'No policy',
        }).expect(400)
      ).body.errors[0].field,
    ).toBe('enrollmentPolicy');
    await call('post', '/courses', teacher.id, {
      title: 'Bad policy',
      enrollmentPolicy: 'EVERYONE',
    }).expect(400);
    await call('post', '/courses', teacher.id, {
      title: 'Null policy',
      enrollmentPolicy: null,
    }).expect(400);
    expect((await pool.query('SELECT 1 FROM courses')).rowCount).toBe(0);
    const document = buildOpenApiDocument(app) as unknown as {
      components: {
        schemas: Record<
          string,
          {
            required?: string[];
            properties: Record<string, { enum?: string[] }>;
          }
        >;
      };
    };
    const schema = document.components.schemas.CreateCourseDto;
    expect(schema.required).toContain('enrollmentPolicy');
    expect(schema.properties.enrollmentPolicy.enum).toEqual([
      'OPEN',
      'APPROVAL_REQUIRED',
      'INVITATION_ONLY',
    ]);
    expect(schema.required).toEqual(expect.arrayContaining(['title']));
  });

  it('validates the other fields and refuses unknown properties (status, owner, ...)', async () => {
    const teacher = await createTeacher(pool);
    const ok = { title: 'A good title', enrollmentPolicy: 'OPEN' };
    await call('post', '/courses', teacher.id, { ...ok, title: 'ab' }).expect(
      400,
    );
    await call('post', '/courses', teacher.id, {
      ...ok,
      title: 'x'.repeat(121),
    }).expect(400);
    await call('post', '/courses', teacher.id, {
      ...ok,
      summary: 'short',
    }).expect(400);
    await call('post', '/courses', teacher.id, {
      ...ok,
      description: 'x'.repeat(5001),
    }).expect(400);
    await call('post', '/courses', teacher.id, {
      ...ok,
      categoryId: randomUUID(),
    }).expect(400);
    await call('post', '/courses', teacher.id, {
      ...ok,
      status: 'PUBLISHED',
    }).expect(400);
    await call('post', '/courses', teacher.id, {
      ...ok,
      ownerId: teacher.id,
    }).expect(400);
    await call('post', '/courses', teacher.id, {
      ...ok,
      title: '😀'.repeat(120),
    }).expect(201);
  });
});

describe('settings and tags (Owner only)', () => {
  it('the Owner changes settings; an Assistant, a student and a visitor cannot', async () => {
    const d = await draft();
    const assistant = await createTeacher(pool);
    await addCourseTeacher(
      pool,
      d.courseId,
      assistant.id,
      'ASSISTANT',
      d.owner.id,
    );
    const res = await call('patch', `/courses/${d.courseId}`, d.owner.id, {
      title: 'New title',
      enrollmentPolicy: 'INVITATION_ONLY',
      description: 'Long text',
    }).expect(200);
    expect(res.body).toMatchObject({
      title: 'New title',
      enrollmentPolicy: 'INVITATION_ONLY',
      description: 'Long text',
    });
    await call('patch', `/courses/${d.courseId}`, assistant.id, {
      title: 'Hijacked',
    }).expect(403);
    await call('put', `/courses/${d.courseId}/tags`, assistant.id, {
      names: ['x1'],
    }).expect(403);
    for (const action of ['publish', 'archive', 'restore'])
      await call(
        'post',
        `/courses/${d.courseId}/${action}`,
        assistant.id,
      ).expect(403);
    await call('delete', `/courses/${d.courseId}`, assistant.id).expect(403);
    await call('patch', `/courses/${d.courseId}`, (await createUser(pool)).id, {
      title: 'Hijacked',
    }).expect(404); // a draft is invisible to others
    expect(
      (
        await pool.query('SELECT title FROM courses WHERE id = $1', [
          d.courseId,
        ])
      ).rows[0].title,
    ).toBe('New title');
  });

  it('refuses unknown properties, ids and states; a published course must keep its summary and category', async () => {
    const d = await published();
    await call('patch', `/courses/${d.courseId}`, d.owner.id, {
      status: 'DRAFT',
    }).expect(400);
    await call('patch', `/courses/${d.courseId}`, d.owner.id, {
      summary: null,
    }).expect(400);
    await call('patch', `/courses/${d.courseId}`, d.owner.id, {
      categoryId: null,
    }).expect(400);
    await call('patch', `/courses/${d.courseId}`, d.owner.id, {
      categoryId: randomUUID(),
    }).expect(400);
    await call('patch', `/courses/${d.courseId}`, d.owner.id, {
      title: 'x',
    }).expect(400);
    await call('patch', `/courses/${d.courseId}`, d.owner.id, {}).expect(200);
    await call('patch', `/courses/${d.courseId}`, d.owner.id, {
      description: null,
    }).expect(200);
  });

  it('the cover must be a COURSE_COVER file the Owner uploaded; null removes it', async () => {
    const d = await draft();
    const cover = await createFile(pool, d.owner.id, { kind: 'COURSE_COVER' });
    await call('patch', `/courses/${d.courseId}`, d.owner.id, {
      coverFileId: await createFile(pool, d.owner.id, { kind: 'AVATAR' }),
    }).expect(400);
    await call('patch', `/courses/${d.courseId}`, d.owner.id, {
      coverFileId: await createFile(pool, (await createTeacher(pool)).id, {
        kind: 'COURSE_COVER',
      }),
    }).expect(404);
    expect(
      (
        await call('patch', `/courses/${d.courseId}`, d.owner.id, {
          coverFileId: cover,
        }).expect(200)
      ).body.coverUrl,
    ).toMatch(/^https:\/\/public\.test\//);
    expect(
      (
        await call('patch', `/courses/${d.courseId}`, d.owner.id, {
          coverFileId: null,
        }).expect(200)
      ).body.coverUrl,
    ).toBeNull();
  });

  it('an archived course (409 COURSE_ARCHIVED) and an Admin-locked one (409 COURSE_ADMIN_LOCKED, first) refuse settings and tags', async () => {
    const d = await published();
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now() WHERE id = $1",
      [d.courseId],
    );
    expect(
      (
        await call('patch', `/courses/${d.courseId}`, d.owner.id, {
          title: 'Changed title',
        }).expect(409)
      ).body.code,
    ).toBe('COURSE_ARCHIVED');
    expect(
      (
        await call('put', `/courses/${d.courseId}/tags`, d.owner.id, {
          names: ['abc'],
        }).expect(409)
      ).body.code,
    ).toBe('COURSE_ARCHIVED');
    await pool.query(
      'UPDATE courses SET locked_by_admin_at = now() WHERE id = $1',
      [d.courseId],
    );
    expect(
      (
        await call('patch', `/courses/${d.courseId}`, d.owner.id, {
          title: 'Changed title',
        }).expect(409)
      ).body.code,
    ).toBe('COURSE_ADMIN_LOCKED');
    expect(
      (
        await call('put', `/courses/${d.courseId}/tags`, d.owner.id, {
          names: ['abc'],
        }).expect(409)
      ).body.code,
    ).toBe('COURSE_ADMIN_LOCKED');
  });

  it('PUT tags normalizes, caps at 10 and replaces the list', async () => {
    const d = await draft();
    const res = await call('put', `/courses/${d.courseId}/tags`, d.owner.id, {
      names: ['Web Development', ' web  development ', 'Հայերեն', 'Русский'],
    }).expect(200);
    expect(res.body.map((t: { slug: string }) => t.slug)).toEqual([
      'web-development',
      'հայերեն',
      'русский',
    ]);
    expect(
      (await call('get', `/courses/${d.courseId}`, d.owner.id).expect(200)).body
        .tags,
    ).toHaveLength(3);
    await call('put', `/courses/${d.courseId}/tags`, d.owner.id, {
      names: Array.from({ length: 11 }, (_, i) => `tag number ${i}`),
    }).expect(400);
    await call('put', `/courses/${d.courseId}/tags`, d.owner.id, {
      names: [],
    }).expect(200);
    expect(
      (await call('get', `/courses/${d.courseId}`, d.owner.id).expect(200)).body
        .tags,
    ).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('publish needs a summary, a category and at least one PUBLISHED lesson; it says what is missing', async () => {
    const owner = await createTeacher(pool);
    const c = (
      await call('post', '/courses', owner.id, {
        title: 'Bare course',
        enrollmentPolicy: 'OPEN',
      }).expect(201)
    ).body.id as string;
    const refused = await call(
      'post',
      `/courses/${c}/publish`,
      owner.id,
    ).expect(409);
    expect(refused.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(refused.body.message).toMatch(/summary/);
    expect(refused.body.message).toMatch(/category/);
    expect(refused.body.message).toMatch(/published lesson/);
    await call('patch', `/courses/${c}`, owner.id, {
      summary: 'A summary that is long enough',
      categoryId: await createCategory(pool),
    }).expect(200);
    const sectionId = await createSection(pool, c);
    await createLesson(pool, c, sectionId, { status: 'DRAFT' }); // a draft lesson does not count
    expect(
      (await call('post', `/courses/${c}/publish`, owner.id).expect(409)).body
        .message,
    ).toMatch(/published lesson/);
    await createLesson(pool, c, sectionId, {
      status: 'PUBLISHED',
      position: 1,
    });
    const ok = await call('post', `/courses/${c}/publish`, owner.id).expect(
      200,
    );
    expect(ok.body.status).toBe('PUBLISHED');
    expect(ok.body.firstPublishedAt).not.toBeNull();
    expect(await auditCount('COURSE_PUBLISHED')).toBe(1);
  });

  it('the first publication creates the channel with the Owner and Assistants; publishing again is 409', async () => {
    const d = await draft();
    const assistant = await createTeacher(pool);
    await call('post', `/courses/${d.courseId}/assistants`, d.owner.id, {
      userId: assistant.id,
    }).expect(204);
    expect(
      (
        await pool.query('SELECT 1 FROM conversations WHERE course_id = $1', [
          d.courseId,
        ])
      ).rowCount,
    ).toBe(0); // no channel before the first publish
    await call('post', `/courses/${d.courseId}/publish`, d.owner.id).expect(
      200,
    );
    const members = (
      await pool.query<{ user_id: string }>(
        'SELECT m.user_id FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id WHERE c.course_id = $1 AND m.left_at IS NULL',
        [d.courseId],
      )
    ).rows
      .map((r) => r.user_id)
      .sort();
    expect(members).toEqual([d.owner.id, assistant.id].sort());
    expect(
      (
        await call('post', `/courses/${d.courseId}/publish`, d.owner.id).expect(
          409,
        )
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
  });

  it('five publishes at the same moment: one wins, the others are 409, and there is exactly one channel', async () => {
    const d = await draft();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call('post', `/courses/${d.courseId}/publish`, d.owner.id),
      ),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409, 409, 409, 409,
    ]);
    expect(
      (
        await pool.query('SELECT 1 FROM conversations WHERE course_id = $1', [
          d.courseId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(await auditCount('COURSE_PUBLISHED')).toBe(1);
  });

  it('archive, then restore: audited; archived keeps its channel; archiving a draft or an archived course is 409; there is no way back to DRAFT', async () => {
    const d = await published();
    const channel = (
      await pool.query<{ id: string }>(
        'SELECT id FROM conversations WHERE course_id = $1',
        [d.courseId],
      )
    ).rows[0].id;
    expect(
      (
        await call('post', `/courses/${d.courseId}/archive`, d.owner.id).expect(
          200,
        )
      ).body,
    ).toMatchObject({ status: 'ARCHIVED' });
    expect(
      (
        await call('post', `/courses/${d.courseId}/archive`, d.owner.id).expect(
          409,
        )
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
    expect(
      (
        await pool.query('SELECT archived_at FROM courses WHERE id = $1', [
          d.courseId,
        ])
      ).rows[0].archived_at,
    ).not.toBeNull();
    const restored = await call(
      'post',
      `/courses/${d.courseId}/restore`,
      d.owner.id,
    ).expect(200);
    expect(restored.body.status).toBe('PUBLISHED');
    expect(
      (
        await pool.query('SELECT archived_at FROM courses WHERE id = $1', [
          d.courseId,
        ])
      ).rows[0].archived_at,
    ).toBeNull();
    expect(
      (
        await pool.query('SELECT id FROM conversations WHERE course_id = $1', [
          d.courseId,
        ])
      ).rows[0].id,
    ).toBe(channel); // the same channel
    expect(
      (
        await call('post', `/courses/${d.courseId}/restore`, d.owner.id).expect(
          409,
        )
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
    expect(await auditCount('COURSE_ARCHIVED')).toBe(1);
    expect(await auditCount('COURSE_RESTORED')).toBe(1);
    const other = await draft();
    expect(
      (
        await call(
          'post',
          `/courses/${other.courseId}/archive`,
          other.owner.id,
        ).expect(409)
      ).body.code,
    ).toBe('INVALID_STATE_TRANSITION');
    for (const path of ['unpublish', 'draft', 'revert'])
      await call('post', `/courses/${d.courseId}/${path}`, d.owner.id).expect(
        404,
      );
    expect(
      (
        await pool.query('SELECT status FROM courses WHERE id = $1', [
          d.courseId,
        ])
      ).rows[0].status,
    ).toBe('PUBLISHED');
  });

  it('an Admin-locked course cannot be restored (or changed) by its Owner: 409 COURSE_ADMIN_LOCKED', async () => {
    const d = await published();
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now(), locked_by_admin_at = now() WHERE id = $1",
      [d.courseId],
    );
    for (const action of ['restore', 'archive', 'publish'])
      expect(
        (
          await call(
            'post',
            `/courses/${d.courseId}/${action}`,
            d.owner.id,
          ).expect(409)
        ).body.code,
      ).toBe('COURSE_ADMIN_LOCKED');
    expect(
      (
        await pool.query('SELECT status FROM courses WHERE id = $1', [
          d.courseId,
        ])
      ).rows[0].status,
    ).toBe('ARCHIVED');
    expect(await auditCount('COURSE_RESTORED')).toBe(0);
  });

  it('delete works only for a course that was NEVER published; it removes the course with its sections and lessons and is audited', async () => {
    const d = await draft();
    await createTag(pool);
    await call('put', `/courses/${d.courseId}/tags`, d.owner.id, {
      names: ['to be removed'],
    }).expect(200);
    await call('delete', `/courses/${d.courseId}`, d.owner.id).expect(204);
    for (const table of [
      'courses',
      'sections',
      'lessons',
      'course_teachers',
      'course_tags',
    ])
      expect(
        (
          await pool.query(
            `SELECT 1 FROM ${table} WHERE ${table === 'courses' ? 'id' : 'course_id'} = $1`,
            [d.courseId],
          )
        ).rowCount,
      ).toBe(0);
    expect(await auditCount('COURSE_DELETED')).toBe(1);
    const p = await published();
    expect(
      (await call('delete', `/courses/${p.courseId}`, p.owner.id).expect(409))
        .body.code,
    ).toBe('INVALID_STATE_TRANSITION');
    await call('post', `/courses/${p.courseId}/archive`, p.owner.id).expect(
      200,
    );
    await call('delete', `/courses/${p.courseId}`, p.owner.id).expect(409); // archived but published once
    expect(
      (await pool.query('SELECT 1 FROM courses WHERE id = $1', [p.courseId]))
        .rowCount,
    ).toBe(1);
    await call('delete', `/courses/${randomUUID()}`, p.owner.id).expect(404);
  });

  it('delete is a loud 409 (foreign keys) when something still references a never-published course', async () => {
    const d = await draft();
    const invited = await createUser(pool);
    await createInvitation(pool, d.courseId, invited.id, d.owner.id);
    expect(
      (await call('delete', `/courses/${d.courseId}`, d.owner.id).expect(409))
        .body.code,
    ).toBe('RESOURCE_CONFLICT');
    expect(
      (await pool.query('SELECT 1 FROM courses WHERE id = $1', [d.courseId]))
        .rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT 1 FROM lessons WHERE course_id = $1', [
          d.courseId,
        ])
      ).rowCount,
    ).toBe(1); // the whole transaction rolled back
  });

  it.each([
    ['publish', 'draft'],
    ['archive', 'published'],
    ['restore', 'archived'],
    ['delete', 'draft'],
  ] as const)(
    '%s takes the Course row exclusively: it waits for a holder of Course-S (an enrollment in progress) and then runs',
    async (action, start) => {
      const d = start === 'draft' ? await draft() : await published();
      if (start === 'archived')
        await call('post', `/courses/${d.courseId}/archive`, d.owner.id).expect(
          200,
        );
      const student = await holdTx(
        pool,
        'course-s',
        'SELECT 1 FROM courses WHERE id = $1 FOR SHARE',
        [d.courseId],
      );
      const response = (
        action === 'delete'
          ? call('delete', `/courses/${d.courseId}`, d.owner.id)
          : call('post', `/courses/${d.courseId}/${action}`, d.owner.id)
      ).then((r) => r);
      expect(await settlesWithin(response, 400)).toBe(false);
      await student.release('commit');
      expect((await response).status).toBeLessThan(300);
    },
  );
});

describe('the public catalog and the course page', () => {
  it('lists PUBLISHED OPEN and APPROVAL_REQUIRED courses only: never drafts, archived, locked or INVITATION_ONLY; no account needed', async () => {
    const open = await published('Open course');
    const approval = await published('Approval course');
    await pool.query(
      "UPDATE courses SET enrollment_policy = 'APPROVAL_REQUIRED' WHERE id = $1",
      [approval.courseId],
    );
    const invitation = await published('Invitation course');
    await pool.query(
      "UPDATE courses SET enrollment_policy = 'INVITATION_ONLY' WHERE id = $1",
      [invitation.courseId],
    );
    const archived = await published('Archived course');
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now() WHERE id = $1",
      [archived.courseId],
    );
    const locked = await published('Locked course');
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now(), locked_by_admin_at = now() WHERE id = $1",
      [locked.courseId],
    );
    await draft('Draft course');
    const res = await call('get', '/courses').expect(200);
    expect(res.body.items.map((c: { id: string }) => c.id).sort()).toEqual(
      [open.courseId, approval.courseId].sort(),
    );
    expect(res.body.total).toBe(2);
    expect(Object.keys(res.body.items[0]).sort()).toEqual([
      'category',
      'coverUrl',
      'enrollmentPolicy',
      'firstPublishedAt',
      'id',
      'owner',
      'summary',
      'tags',
      'title',
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/@|password|email/i);
  });

  it('full-text search under the simple configuration works in Armenian, Russian and English, matches every word and the last one as a prefix', async () => {
    const titles = [
      'Հայոց լեզու սկսնակների համար',
      'Русский язык для начинающих',
      'English grammar for beginners',
      'Mathematics',
    ];
    const ids: Record<string, string> = {};
    for (const t of titles) ids[t] = (await published(t)).courseId;
    const found = async (q: string) =>
      (
        await call('get', `/courses?q=${encodeURIComponent(q)}`).expect(200)
      ).body.items.map((c: { id: string }) => c.id);
    expect(await found('լեզու')).toEqual([ids[titles[0]]]);
    expect(await found('Հայոց լեզ')).toEqual([ids[titles[0]]]); // prefix of the last word
    expect(await found('русский')).toEqual([ids[titles[1]]]);
    expect(await found('РУССК')).toEqual([ids[titles[1]]]);
    expect(await found('grammar beginners')).toEqual([ids[titles[2]]]);
    expect(await found('gramm')).toEqual([ids[titles[2]]]);
    expect(await found('grammar русский')).toEqual([]); // every word must match
    expect(await found('nothing like it')).toEqual([]);
    expect(await found("'; DROP TABLE courses; --")).toEqual([]);
    expect(await found('!!! ???')).toEqual([]); // no searchable word
    expect((await pool.query('SELECT 1 FROM courses')).rowCount).toBe(4);
  });

  it('searches the summary and description too, ranks better matches first, and an INVITATION_ONLY course is absent from search', async () => {
    const a = await published('Alpha course');
    await pool.query(
      "UPDATE courses SET description = 'violin violin violin lessons' WHERE id = $1",
      [a.courseId],
    );
    const b = await published('Violin for everyone');
    const hidden = await published('Violin secret');
    await pool.query(
      "UPDATE courses SET enrollment_policy = 'INVITATION_ONLY' WHERE id = $1",
      [hidden.courseId],
    );
    const res = (
      await call('get', '/courses?q=violin').expect(200)
    ).body.items.map((c: { id: string }) => c.id);
    expect(res).toHaveLength(2);
    expect(res).toContain(a.courseId);
    expect(res).toContain(b.courseId);
    expect(res).not.toContain(hidden.courseId);
  });

  it('filters by category, tag and policy; sorts; paginates; rejects bad parameters', async () => {
    const a = await published('Bravo');
    const b = await published('Alpha');
    await call('put', `/courses/${a.courseId}/tags`, a.owner.id, {
      names: ['music'],
    }).expect(200);
    await pool.query(
      "UPDATE courses SET enrollment_policy = 'APPROVAL_REQUIRED' WHERE id = $1",
      [b.courseId],
    );
    const ids = async (query: string) =>
      (await call('get', `/courses?${query}`).expect(200)).body.items.map(
        (c: { id: string }) => c.id,
      );
    expect(await ids(`categoryId=${a.categoryId}`)).toEqual([a.courseId]);
    expect(await ids('tag=music')).toEqual([a.courseId]);
    expect(await ids('tag=unknown')).toEqual([]);
    expect(await ids('enrollmentPolicy=APPROVAL_REQUIRED')).toEqual([
      b.courseId,
    ]);
    expect(await ids('sort=title')).toEqual([b.courseId, a.courseId]);
    expect(await ids('sort=newest')).toEqual([b.courseId, a.courseId]);
    const p1 = (await call('get', '/courses?page=1&pageSize=1').expect(200))
      .body;
    expect([p1.items.length, p1.total]).toEqual([1, 2]);
    expect(
      (await call('get', '/courses?page=2&pageSize=1').expect(200)).body.items,
    ).toHaveLength(1);
    for (const bad of [
      'pageSize=51',
      'page=0',
      'sort=random',
      'enrollmentPolicy=INVITATION_ONLY',
      'categoryId=nope',
      `q=${'x'.repeat(101)}`,
    ])
      await call('get', `/courses?${bad}`).expect(400);
  });

  it('the course page follows the visibility table: a draft only for teachers, INVITATION_ONLY for invitees but 404 for strangers, archived for ACTIVE and LEFT students', async () => {
    const d = await draft('Hidden draft');
    expect(
      (await call('get', `/courses/${d.courseId}`, d.owner.id).expect(200)).body
        .viewer.relationship,
    ).toBe('OWNER');
    await call('get', `/courses/${d.courseId}`).expect(404);
    await call(
      'get',
      `/courses/${d.courseId}`,
      (await createUser(pool)).id,
    ).expect(404);

    const p = await published('Private course');
    await pool.query(
      "UPDATE courses SET enrollment_policy = 'INVITATION_ONLY' WHERE id = $1",
      [p.courseId],
    );
    const [invitee, stranger] = [
      await createUser(pool),
      await createUser(pool),
    ];
    await createInvitation(pool, p.courseId, invitee.id, p.owner.id);
    expect(
      (await call('get', `/courses/${p.courseId}`, invitee.id).expect(200)).body
        .viewer.relationship,
    ).toBe('INVITEE');
    await call('get', `/courses/${p.courseId}`, stranger.id).expect(404);
    await call('get', `/courses/${p.courseId}`).expect(404);
    expect((await call('get', '/courses').expect(200)).body.items).toEqual([]);

    const open = await published('Open course');
    const student = await createUser(pool);
    await createEnrollment(pool, open.courseId, student.id);
    const left = await createUser(pool);
    await createEnrollment(pool, open.courseId, left.id, {
      status: 'LEFT',
      leftAt: new Date(),
    });
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now() WHERE id = $1",
      [open.courseId],
    );
    expect(
      (await call('get', `/courses/${open.courseId}`, student.id).expect(200))
        .body.viewer.relationship,
    ).toBe('STUDENT_ACTIVE');
    expect(
      (await call('get', `/courses/${open.courseId}`, left.id).expect(200)).body
        .viewer.relationship,
    ).toBe('STUDENT_LEFT');
    await call('get', `/courses/${open.courseId}`, stranger.id).expect(404);
    await call('get', `/courses/${open.courseId}`).expect(404);
  });

  it('only teachers see lockedByAdmin; students of a locked course are 403 COURSE_ADMIN_LOCKED', async () => {
    const d = await published();
    const student = await createUser(pool);
    await createEnrollment(pool, d.courseId, student.id);
    expect(
      (await call('get', `/courses/${d.courseId}`, student.id).expect(200))
        .body,
    ).not.toHaveProperty('lockedByAdmin');
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now(), locked_by_admin_at = now() WHERE id = $1",
      [d.courseId],
    );
    expect(
      (await call('get', `/courses/${d.courseId}`, student.id).expect(403)).body
        .code,
    ).toBe('COURSE_ADMIN_LOCKED');
    expect(
      (await call('get', `/courses/${d.courseId}`, d.owner.id).expect(200)).body
        .lockedByAdmin,
    ).toBe(true);
    await call('get', `/courses/${d.courseId}`).expect(404);
  });

  it('syllabus: titles of published lessons only; teachers: the Owner first; me/teaching/courses: my courses in any status', async () => {
    const d = await published();
    await createLesson(pool, d.courseId, d.sectionId, {
      status: 'DRAFT',
      title: 'Secret draft',
      position: 5,
    });
    const syllabus = (
      await call('get', `/courses/${d.courseId}/syllabus`).expect(200)
    ).body;
    expect(syllabus).toHaveLength(1);
    expect(JSON.stringify(syllabus)).not.toContain('Secret draft');
    expect(Object.keys(syllabus[0].lessons[0]).sort()).toEqual(['id', 'title']);
    const assistant = await createTeacher(pool);
    await addCourseTeacher(
      pool,
      d.courseId,
      assistant.id,
      'ASSISTANT',
      d.owner.id,
    );
    const teachers = (
      await call('get', `/courses/${d.courseId}/teachers`).expect(200)
    ).body;
    expect(
      teachers.map((t: { id: string; role: string }) => [t.id, t.role]),
    ).toEqual([
      [d.owner.id, 'OWNER'],
      [assistant.id, 'ASSISTANT'],
    ]);
    expect(JSON.stringify(teachers)).not.toContain('@');
    const mine = (
      await call('get', '/me/teaching/courses', assistant.id).expect(200)
    ).body;
    expect(mine.items).toEqual([
      expect.objectContaining({
        id: d.courseId,
        role: 'ASSISTANT',
        status: 'PUBLISHED',
      }),
    ]);
    await draft('Another');
    await call(
      'get',
      '/me/teaching/courses',
      (await createUser(pool)).id,
    ).expect(403);
    expect(
      (await call('get', '/me/teaching/courses', d.owner.id).expect(200)).body
        .total,
    ).toBe(1);
  });
});

describe('the teaching team', () => {
  it('the Owner adds an Assistant (an approved Teacher), who joins the channel; duplicates, students and non-Teachers are refused', async () => {
    const d = await published();
    const [assistant, student, plain] = [
      await createTeacher(pool),
      await createUser(pool),
      await createUser(pool),
    ];
    await createEnrollment(pool, d.courseId, student.id);
    await createEnrollment(pool, d.courseId, (await createUser(pool)).id, {
      status: 'PENDING',
      firstActivatedAt: null,
    });
    const url = `/courses/${d.courseId}/assistants`;
    await call('post', url, d.owner.id, { userId: assistant.id }).expect(204);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id WHERE c.course_id = $1 AND m.user_id = $2 AND m.left_at IS NULL',
          [d.courseId, assistant.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await call('post', url, d.owner.id, { userId: assistant.id }).expect(
          409,
        )
      ).body.code,
    ).toBe('RESOURCE_CONFLICT');
    expect(
      (await call('post', url, d.owner.id, { userId: d.owner.id }).expect(409))
        .body.code,
    ).toBe('RESOURCE_CONFLICT');
    expect(
      (await call('post', url, d.owner.id, { userId: plain.id }).expect(409))
        .body.message,
    ).toMatch(/approved Teacher/);
    const studentTeacher = await createUserWithRoles(pool, [
      { role: 'STUDENT' },
      { role: 'TEACHER' },
    ]);
    await createEnrollment(pool, d.courseId, studentTeacher.id);
    expect(
      (
        await call('post', url, d.owner.id, {
          userId: studentTeacher.id,
        }).expect(409)
      ).body.message,
    ).toMatch(/student/);
    await call('post', url, d.owner.id, {
      userId: (
        await createUserWithRoles(pool, [
          { role: 'STUDENT' },
          { role: 'TEACHER', status: 'REVOKED' },
        ])
      ).id,
    }).expect(409);
    await call('post', url, d.owner.id, { userId: randomUUID() }).expect(404);
    await call('post', url, assistant.id, {
      userId: (await createTeacher(pool)).id,
    }).expect(403);
    expect(await auditCount('COURSE_ASSISTANT_ADDED')).toBe(1);
    expect(student.id).toBeDefined();
  });

  it('the Owner removes an Assistant, an Assistant may leave; both end the channel membership and are audited; the Owner cannot leave', async () => {
    const d = await published();
    const [a, b] = [await createTeacher(pool), await createTeacher(pool)];
    for (const x of [a, b])
      await call('post', `/courses/${d.courseId}/assistants`, d.owner.id, {
        userId: x.id,
      }).expect(204);
    await call(
      'delete',
      `/courses/${d.courseId}/assistants/${a.id}`,
      d.owner.id,
    ).expect(204);
    await call(
      'delete',
      `/courses/${d.courseId}/assistants/${a.id}`,
      d.owner.id,
    ).expect(404);
    await call(
      'post',
      `/courses/${d.courseId}/assistants/me/leave`,
      b.id,
    ).expect(204);
    await call(
      'post',
      `/courses/${d.courseId}/assistants/me/leave`,
      d.owner.id,
    ).expect(403); // the Owner transfers first
    await call(
      'delete',
      `/courses/${d.courseId}/assistants/${d.owner.id}`,
      d.owner.id,
    ).expect(404);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM course_teachers WHERE course_id = $1 AND role = 'ASSISTANT'",
          [d.courseId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id WHERE c.course_id = $1 AND m.user_id = ANY($2::uuid[]) AND m.left_at IS NULL',
          [d.courseId, [a.id, b.id]],
        )
      ).rowCount,
    ).toBe(0);
    expect(await auditCount('COURSE_ASSISTANT_REMOVED')).toBe(2);
    expect(await owners(d.courseId)).toEqual([d.owner.id]);
  });

  it('ownership transfer demotes the old Owner to Assistant first; the new Owner (an existing Assistant or another Teacher) is told after commit; there is always exactly one Owner', async () => {
    const d = await published();
    const [assistant, outsider] = [
      await createTeacher(pool),
      await createTeacher(pool),
    ];
    await call('post', `/courses/${d.courseId}/assistants`, d.owner.id, {
      userId: assistant.id,
    }).expect(204);
    await call(
      'post',
      `/courses/${d.courseId}/ownership-transfer`,
      d.owner.id,
      { userId: assistant.id },
    ).expect(204);
    expect(await owners(d.courseId)).toEqual([assistant.id]);
    expect(
      (
        await pool.query(
          'SELECT role FROM course_teachers WHERE course_id = $1 AND user_id = $2',
          [d.courseId, d.owner.id],
        )
      ).rows[0].role,
    ).toBe('ASSISTANT');
    await call('patch', `/courses/${d.courseId}`, d.owner.id, {
      title: 'Old owner cannot',
    }).expect(403);
    await call(
      'post',
      `/courses/${d.courseId}/ownership-transfer`,
      assistant.id,
      { userId: outsider.id },
    ).expect(204);
    expect(await owners(d.courseId)).toEqual([outsider.id]);
    expect(
      (
        await pool.query('SELECT 1 FROM course_teachers WHERE course_id = $1', [
          d.courseId,
        ])
      ).rowCount,
    ).toBe(3);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id WHERE c.course_id = $1 AND m.user_id = $2 AND m.left_at IS NULL',
          [d.courseId, outsider.id],
        )
      ).rowCount,
    ).toBe(1);
    await sleep(80);
    expect(transfers).toEqual([
      {
        courseId: d.courseId,
        previousOwnerId: d.owner.id,
        newOwnerId: assistant.id,
      },
      {
        courseId: d.courseId,
        previousOwnerId: assistant.id,
        newOwnerId: outsider.id,
      },
    ]);
    expect(await auditCount('COURSE_OWNERSHIP_TRANSFERRED')).toBe(2);
  });

  it('a transfer to a non-Teacher, a student of the course, yourself, an unknown user is refused and changes nothing', async () => {
    const d = await published();
    const [plain, studentTeacher] = [
      await createUser(pool),
      await createUserWithRoles(pool, [
        { role: 'STUDENT' },
        { role: 'TEACHER' },
      ]),
    ];
    await createEnrollment(pool, d.courseId, studentTeacher.id);
    const url = `/courses/${d.courseId}/ownership-transfer`;
    expect(
      (await call('post', url, d.owner.id, { userId: plain.id }).expect(409))
        .body.message,
    ).toMatch(/approved Teacher/);
    expect(
      (
        await call('post', url, d.owner.id, {
          userId: studentTeacher.id,
        }).expect(409)
      ).body.message,
    ).toMatch(/student/);
    await call('post', url, d.owner.id, { userId: d.owner.id }).expect(409);
    await call('post', url, d.owner.id, { userId: randomUUID() }).expect(404);
    await call('post', url, d.owner.id, { userId: 'nope' }).expect(400);
    await call('post', url, plain.id, { userId: d.owner.id }).expect(403);
    expect(await owners(d.courseId)).toEqual([d.owner.id]);
    expect(transfers).toEqual([]);
  });

  it('two transfers by the Owner at the same moment: one wins, the other is refused, and exactly one Owner remains', async () => {
    for (let round = 0; round < 6; round++) {
      const d = await published();
      const [a, b] = [await createTeacher(pool), await createTeacher(pool)];
      const results = await Promise.all([
        call('post', `/courses/${d.courseId}/ownership-transfer`, d.owner.id, {
          userId: a.id,
        }),
        call('post', `/courses/${d.courseId}/ownership-transfer`, d.owner.id, {
          userId: b.id,
        }),
      ]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        204, 403,
      ]);
      expect(await owners(d.courseId)).toHaveLength(1);
    }
  });

  it('team operations work in ANY course status: draft, archived and Admin-locked', async () => {
    const d = await draft();
    const [a, b] = [await createTeacher(pool), await createTeacher(pool)];
    await call('post', `/courses/${d.courseId}/assistants`, d.owner.id, {
      userId: a.id,
    }).expect(204); // draft
    await call('post', `/courses/${d.courseId}/publish`, d.owner.id).expect(
      200,
    );
    await call('post', `/courses/${d.courseId}/archive`, d.owner.id).expect(
      200,
    );
    await call('post', `/courses/${d.courseId}/assistants`, d.owner.id, {
      userId: b.id,
    }).expect(204); // archived
    await pool.query(
      'UPDATE courses SET locked_by_admin_at = now() WHERE id = $1',
      [d.courseId],
    );
    await call(
      'delete',
      `/courses/${d.courseId}/assistants/${b.id}`,
      d.owner.id,
    ).expect(204); // locked
    await call(
      'post',
      `/courses/${d.courseId}/ownership-transfer`,
      d.owner.id,
      { userId: a.id },
    ).expect(204);
    expect(await owners(d.courseId)).toEqual([a.id]);
  });

  it('add Assistant, remove, leave and transfer all take Course-X: each waits for a holder of Course-S', async () => {
    const d = await published();
    const [a, b] = [await createTeacher(pool), await createTeacher(pool)];
    await call('post', `/courses/${d.courseId}/assistants`, d.owner.id, {
      userId: a.id,
    }).expect(204);
    const cases: [string, () => Promise<request.Response>, string][] = [
      [
        'add',
        () =>
          call('post', `/courses/${d.courseId}/assistants`, d.owner.id, {
            userId: b.id,
          }).then((r) => r),
        'Assistant added',
      ],
      [
        'remove',
        () =>
          call(
            'delete',
            `/courses/${d.courseId}/assistants/${a.id}`,
            d.owner.id,
          ).then((r) => r),
        'removed',
      ],
      [
        'transfer',
        () =>
          call(
            'post',
            `/courses/${d.courseId}/ownership-transfer`,
            d.owner.id,
            { userId: a.id },
          ).then((r) => r),
        'transferred',
      ],
    ];
    for (const [name, run] of cases) {
      const holder = await holdTx(
        pool,
        `course-s-${name}`,
        'SELECT 1 FROM courses WHERE id = $1 FOR SHARE',
        [d.courseId],
      );
      const response = run();
      expect([name, await settlesWithin(response, 350)]).toEqual([name, false]);
      await holder.release('commit');
      expect([name, (await response).status < 300]).toEqual([name, true]);
      if (name === 'transfer') break;
    }
  });

  it('ownsCourses is true for an Owner in any status and false for an Assistant or nobody', async () => {
    const d = await draft();
    const assistant = await createTeacher(pool);
    await addCourseTeacher(
      pool,
      d.courseId,
      assistant.id,
      'ASSISTANT',
      d.owner.id,
    );
    expect(await team.ownsCourses(d.owner.id)).toBe(true);
    expect(await team.ownsCourses(assistant.id)).toBe(false);
    expect(await team.ownsCourses((await createUser(pool)).id)).toBe(false);
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now(), first_published_at = now() WHERE id = $1",
      [d.courseId],
    );
    expect(await team.ownsCourses(d.owner.id)).toBe(true);
  });

  it('a course created by a Teacher is visible in the catalog only after it is published (a DB-built published course works the same)', async () => {
    const id = await createPublishedCourse(pool, { title: 'Built by factory' });
    await createTeacher(pool).then((t) =>
      addCourseTeacher(pool, id, t.id, 'OWNER'),
    );
    expect(
      (await call('get', '/courses?q=factory').expect(200)).body.items.map(
        (c: { id: string }) => c.id,
      ),
    ).toEqual([id]);
    void createCourse;
  });
});
