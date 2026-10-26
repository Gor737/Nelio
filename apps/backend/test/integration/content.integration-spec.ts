// M10b: Content against the real database over HTTP: outline, sections, lessons, blocks, the lesson lifecycle, reorder, visibility,
// downloads, the archived/locked rules, and the Bug 1 scenario through the real routes.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import { DatabaseModule } from '../../src/infrastructure/database/index.js';
import {
  EventBus,
  EventsModule,
} from '../../src/infrastructure/events/index.js';
import {
  ContentModule,
  OutlineService,
} from '../../src/modules/content/index.js';
import { ProgressModule } from '../../src/modules/progress/index.js';
import { StorageDriver } from '../../src/modules/files/storage/storage-driver.js';
import { createPool, resetData } from '../support/database.js';
import { createFile, createTeacher, createUser } from '../support/factories.js';
import {
  createFileBlock,
  createLesson,
  createSection,
  createTextBlock,
  createVideoBlock,
} from '../support/factories-content.js';
import {
  addCourseTeacher,
  createPublishedCourse,
} from '../support/factories-courses.js';
import {
  type EnrollmentStatusName,
  createCompletion,
  createEnrollment,
} from '../support/factories-learning.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { holdTx, releaseAll, settlesWithin } from '../support/parallel-tx.js';
import { bearer, closeApp, testEnv } from '../support/integration-app.js';

const pool = createPool(25);
const storage = new InMemoryStorage();
let app: NestExpressApplication;
let outline: OutlineService;
const firstPublished: { courseId: string; lessonId: string }[] = [];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      ContentModule,
      ProgressModule,
    ],
    providers: GLOBAL_PROVIDERS,
  })
    .overrideProvider(StorageDriver)
    .useValue(storage)
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  outline = app.get(OutlineService, { strict: false });
  app.get(EventBus).on('lesson.first-published', (payload) => {
    firstPublished.push(payload);
  });
});
afterEach(() => releaseAll());
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  storage.reset();
  firstPublished.length = 0;
});

let counter = 0;
const ip = () => `10.5.${(counter >> 8) & 255}.${counter++ & 255}`;
const api = (userId: string) => {
  const base = (m: 'get' | 'post' | 'patch' | 'delete' | 'put', path: string) =>
    request(app.getHttpServer())
      [m](`/api/v1${path}`)
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', ip());
  return {
    get: (path: string) => base('get', path),
    post: (path: string, body: object = {}) => base('post', path).send(body),
    patch: (path: string, body: object = {}) => base('patch', path).send(body),
    put: (path: string) => base('put', path),
    del: (path: string) => base('delete', path),
  };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface World {
  courseId: string;
  owner: { id: string };
  assistant: { id: string };
  student: { id: string };
  enrollmentId: string;
  sectionId: string;
}
async function world(
  courseOverrides: Parameters<typeof createPublishedCourse>[1] = {},
): Promise<World> {
  const courseId = await createPublishedCourse(pool, courseOverrides);
  const owner = await createTeacher(pool);
  const assistant = await createTeacher(pool);
  await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
  await addCourseTeacher(pool, courseId, assistant.id, 'ASSISTANT', owner.id);
  const student = await createUser(pool);
  const enrollmentId = await createEnrollment(pool, courseId, student.id);
  const sectionId = await createSection(pool, courseId, { position: 0 });
  return { courseId, owner, assistant, student, enrollmentId, sectionId };
}
const lesson = (
  w: World,
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' = 'PUBLISHED',
  position = 0,
  sectionId = w.sectionId,
) => createLesson(pool, w.courseId, sectionId, { status, position });
const publishedLessonWithBlock = async (w: World, position = 0) => {
  const id = await lesson(w, 'PUBLISHED', position);
  await createTextBlock(pool, id);
  return id;
};
const courseOf = (w: World) => `/courses/${w.courseId}`;
const positions = async (table: string, column: string, parent: string) =>
  (
    await pool.query<{ position: number }>(
      `SELECT position FROM ${table} WHERE ${column} = $1 ORDER BY position`,
      [parent],
    )
  ).rows.map((r) => r.position);
const lessonRow = async (id: string) =>
  (
    await pool.query<{
      status: string;
      first_published_at: Date | null;
      section_id: string;
    }>(
      'SELECT status, first_published_at, section_id FROM lessons WHERE id = $1',
      [id],
    )
  ).rows[0];
const completedAt = async (enrollmentId: string) =>
  (
    await pool.query<{ completed_at: Date | null }>(
      'SELECT completed_at FROM enrollments WHERE id = $1',
      [enrollmentId],
    )
  ).rows[0].completed_at;

describe('who may do what', () => {
  it('the Owner and an Assistant edit; an ACTIVE student, an outsider and non-ACTIVE students may not; no token is 401', async () => {
    const w = await world();
    const body = { title: 'New section' };
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections`, body)
      .expect(201);
    await api(w.assistant.id)
      .post(`${courseOf(w)}/sections`, body)
      .expect(201);
    await api(w.student.id)
      .post(`${courseOf(w)}/sections`, body)
      .expect(403);
    await api((await createUser(pool)).id)
      .post(`${courseOf(w)}/sections`, body)
      .expect(403);
    for (const status of ['PENDING', 'LEFT'] as EnrollmentStatusName[]) {
      const user = await createUser(pool);
      await createEnrollment(pool, w.courseId, user.id, { status });
      await api(user.id)
        .post(`${courseOf(w)}/sections`, body)
        .expect(403);
      await api(user.id)
        .get(`${courseOf(w)}/outline`)
        .expect(403); // no content for non-ACTIVE students
    }
    await request(app.getHttpServer())
      .post(`/api/v1${courseOf(w)}/sections`)
      .send(body)
      .expect(401);
  });

  it('another teacher (not on this course) cannot edit it', async () => {
    const w = await world();
    const stranger = await createTeacher(pool);
    await api(stranger.id)
      .post(`${courseOf(w)}/sections`, { title: 'x' })
      .expect(403);
  });
});

describe('outline and syllabus', () => {
  it('teachers see every lesson with status and block count; an ACTIVE student sees published lessons only, with no lifecycle fields', async () => {
    const w = await world();
    const draft = await lesson(w, 'DRAFT', 0);
    const published = await publishedLessonWithBlock(w, 1);
    const archived = await lesson(w, 'ARCHIVED', 2);
    await createTextBlock(pool, draft);
    await createTextBlock(pool, draft);
    await createSection(pool, w.courseId, { title: 'Empty', position: 1 });
    const teacher = (
      await api(w.owner.id)
        .get(`${courseOf(w)}/outline`)
        .expect(200)
    ).body;
    expect(teacher.sections).toHaveLength(2);
    expect(teacher.sections[0].lessons).toEqual([
      expect.objectContaining({ id: draft, status: 'DRAFT', blockCount: 2 }),
      expect.objectContaining({
        id: published,
        status: 'PUBLISHED',
        blockCount: 1,
      }),
      expect.objectContaining({
        id: archived,
        status: 'ARCHIVED',
        blockCount: 0,
      }),
    ]);
    const learner = (
      await api(w.student.id)
        .get(`${courseOf(w)}/outline`)
        .expect(200)
    ).body;
    expect(learner.sections).toHaveLength(1); // the empty section has nothing to open
    expect(learner.sections[0].lessons).toEqual([
      { id: published, title: expect.any(String), position: 1 },
    ]);
    expect(JSON.stringify(learner)).not.toMatch(
      /status|blockCount|DRAFT|ARCHIVED/,
    );
  });

  it('the public syllabus lists published lesson titles only, and omits sections with none', async () => {
    const w = await world();
    await lesson(w, 'DRAFT', 0);
    const published = await lesson(w, 'PUBLISHED', 1);
    await createSection(pool, w.courseId, { position: 1 });
    const syllabus = await outline.syllabus(w.courseId);
    expect(syllabus).toHaveLength(1);
    expect(syllabus[0].lessons).toEqual([
      { id: published, title: expect.any(String) },
    ]);
  });
});

describe('reading a lesson', () => {
  it('a teacher gets any status with the lifecycle fields; a student gets a published lesson without them; nobody gets a storage key', async () => {
    const w = await world();
    const teacherFile = await createFile(pool, w.owner.id, {
      kind: 'LESSON_ATTACHMENT',
    });
    const published = await lesson(w, 'PUBLISHED', 0);
    await createTextBlock(pool, published);
    await createVideoBlock(pool, published);
    await pool.query(
      "INSERT INTO content_blocks (lesson_id, position, type, file_id) VALUES ($1, 2, 'FILE', $2)",
      [published, teacherFile],
    );
    const draft = await lesson(w, 'DRAFT', 1);
    const asTeacher = (
      await api(w.owner.id)
        .get(`${courseOf(w)}/lessons/${draft}`)
        .expect(200)
    ).body;
    expect(asTeacher).toMatchObject({
      id: draft,
      status: 'DRAFT',
      firstPublishedAt: null,
      blocks: [],
    });
    const asStudent = (
      await api(w.student.id)
        .get(`${courseOf(w)}/lessons/${published}`)
        .expect(200)
    ).body;
    expect(Object.keys(asStudent).sort()).toEqual([
      'blocks',
      'id',
      'position',
      'sectionId',
      'title',
    ]);
    expect(asStudent.blocks.map((b: { type: string }) => b.type)).toEqual([
      'TEXT',
      'VIDEO',
      'FILE',
    ]);
    expect(asStudent.blocks[1].video).toEqual({
      provider: 'YOUTUBE',
      externalId: 'dQw4w9WgXcQ',
      embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    });
    expect(asStudent.blocks[2].file).toEqual({
      name: 'file.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    expect(JSON.stringify(asStudent)).not.toContain('files/');
  });

  it('a student gets 404 for a draft, an archived and an unpublished lesson, and for a lesson of another course', async () => {
    const w = await world();
    const other = await world();
    for (const status of ['DRAFT', 'ARCHIVED'] as const) {
      const id = await lesson(w, status, 0);
      await api(w.student.id)
        .get(`${courseOf(w)}/lessons/${id}`)
        .expect(404);
    }
    const published = await publishedLessonWithBlock(w, 1);
    await api(w.student.id)
      .get(`${courseOf(w)}/lessons/${published}`)
      .expect(200);
    await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${published}/unpublish`)
      .expect(200);
    await api(w.student.id)
      .get(`${courseOf(w)}/lessons/${published}`)
      .expect(404);
    const foreign = await publishedLessonWithBlock(other, 0);
    await api(w.student.id)
      .get(`${courseOf(w)}/lessons/${foreign}`)
      .expect(404);
    await api(w.owner.id)
      .get(`${courseOf(w)}/lessons/${foreign}`)
      .expect(404);
    await api(w.owner.id)
      .get(`${courseOf(w)}/lessons/${randomUUID()}`)
      .expect(404);
    await api(w.owner.id)
      .get(`${courseOf(w)}/lessons/nope`)
      .expect(400);
  });

  it('an archived course keeps showing published lessons to its ACTIVE students', async () => {
    const w = await world({ status: 'ARCHIVED', archivedAt: new Date() });
    const id = await publishedLessonWithBlock(w);
    await api(w.student.id)
      .get(`${courseOf(w)}/lessons/${id}`)
      .expect(200);
  });
});

describe('sections', () => {
  it('creates at the end, renames, validates titles, and deletes only empty sections', async () => {
    const w = await world();
    const a = (
      await api(w.owner.id)
        .post(`${courseOf(w)}/sections`, { title: '  Week 1  ' })
        .expect(201)
    ).body;
    const b = (
      await api(w.owner.id)
        .post(`${courseOf(w)}/sections`, { title: 'Շաբաթ 2 😀' })
        .expect(201)
    ).body;
    expect(a).toMatchObject({ title: 'Week 1', position: 1 }); // the factory section is at 0
    expect(b.position).toBe(2);
    expect(
      (
        await api(w.owner.id)
          .patch(`${courseOf(w)}/sections/${a.id}`, { title: 'Renamed' })
          .expect(200)
      ).body.title,
    ).toBe('Renamed');
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections`, { title: '' })
      .expect(400);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections`, { title: 'x'.repeat(121) })
      .expect(400);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections`, { title: 'x', position: 3 })
      .expect(400);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections`, { title: '😀'.repeat(120) })
      .expect(201);
    await lesson(w, 'DRAFT');
    const refused = await api(w.owner.id)
      .del(`${courseOf(w)}/sections/${w.sectionId}`)
      .expect(409);
    expect(refused.body.code).toBe('RESOURCE_CONFLICT');
    await api(w.owner.id)
      .del(`${courseOf(w)}/sections/${b.id}`)
      .expect(204);
    await api(w.owner.id)
      .del(`${courseOf(w)}/sections/${b.id}`)
      .expect(404);
  });

  it('a section of another course is 404 for rename, delete and lesson creation', async () => {
    const [w, other] = [await world(), await world()];
    await api(w.owner.id)
      .patch(`${courseOf(w)}/sections/${other.sectionId}`, { title: 'x' })
      .expect(404);
    await api(w.owner.id)
      .del(`${courseOf(w)}/sections/${other.sectionId}`)
      .expect(404);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/${other.sectionId}/lessons`, {
        title: 'x',
      })
      .expect(404);
  });

  it('twelve parallel appends all succeed with different positions', async () => {
    const w = await world();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api(w.owner.id).post(`${courseOf(w)}/sections`, { title: `S${i}` }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    const list = await positions('sections', 'course_id', w.courseId);
    expect(list).toEqual(Array.from({ length: 13 }, (_, i) => i));
  });

  it('reorder rewrites the whole list; a stale, partial, foreign or duplicated list is refused and changes nothing', async () => {
    const w = await world();
    const b = await createSection(pool, w.courseId, { position: 1 });
    const c = await createSection(pool, w.courseId, { position: 2 });
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/reorder`, { ids: [c, w.sectionId, b] })
      .expect(204);
    expect(
      (
        await pool.query<{ id: string }>(
          'SELECT id FROM sections WHERE course_id = $1 ORDER BY position',
          [w.courseId],
        )
      ).rows.map((r) => r.id),
    ).toEqual([c, w.sectionId, b]);
    const stale = await api(w.owner.id)
      .post(`${courseOf(w)}/sections/reorder`, { ids: [c, w.sectionId] })
      .expect(409);
    expect(stale.body.code).toBe('ORDER_MISMATCH');
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/reorder`, {
        ids: [c, w.sectionId, b, randomUUID()],
      })
      .expect(409);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/reorder`, {
        ids: [c, w.sectionId, randomUUID()],
      })
      .expect(409);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/reorder`, { ids: [c, c, b] })
      .expect(400);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/reorder`, { ids: ['nope'] })
      .expect(400);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/reorder`, {})
      .expect(400);
    expect(
      (
        await pool.query<{ id: string }>(
          'SELECT id FROM sections WHERE course_id = $1 ORDER BY position',
          [w.courseId],
        )
      ).rows.map((r) => r.id),
    ).toEqual([c, w.sectionId, b]);
  });

  it('a reorder that raced with a delete of another section is the stale case: 409, nothing half-written', async () => {
    const w = await world();
    const b = await createSection(pool, w.courseId, { position: 1 });
    const loaded = [w.sectionId, b];
    await api(w.owner.id)
      .del(`${courseOf(w)}/sections/${b}`)
      .expect(204);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/reorder`, { ids: [b, w.sectionId] })
      .expect(409);
    expect(loaded).toHaveLength(2);
  });
});

describe('lessons', () => {
  it('creates a DRAFT at the end of the section, renames it, and validates the title', async () => {
    const w = await world();
    const first = (
      await api(w.owner.id)
        .post(`${courseOf(w)}/sections/${w.sectionId}/lessons`, {
          title: ' Alphabet ',
        })
        .expect(201)
    ).body;
    const second = (
      await api(w.assistant.id)
        .post(`${courseOf(w)}/sections/${w.sectionId}/lessons`, {
          title: 'Numbers',
        })
        .expect(201)
    ).body;
    expect(first).toMatchObject({
      title: 'Alphabet',
      status: 'DRAFT',
      position: 0,
      firstPublishedAt: null,
      sectionId: w.sectionId,
    });
    expect(second.position).toBe(1);
    expect(
      (
        await api(w.owner.id)
          .patch(`${courseOf(w)}/lessons/${first.id}`, { title: 'ABC' })
          .expect(200)
      ).body.title,
    ).toBe('ABC');
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/${w.sectionId}/lessons`, { title: '' })
      .expect(400);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/${w.sectionId}/lessons`, {
        title: 'x'.repeat(151),
      })
      .expect(400);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/${w.sectionId}/lessons`, {
        title: '😀'.repeat(150),
      })
      .expect(201);
    await api(w.owner.id)
      .patch(`${courseOf(w)}/lessons/${first.id}`, { status: 'PUBLISHED' })
      .expect(400); // no generic status patch
  });

  it('twelve parallel appends to one section all succeed with different positions', async () => {
    const w = await world();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api(w.owner.id).post(`${courseOf(w)}/sections/${w.sectionId}/lessons`, {
          title: `L${i}`,
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect(await positions('lessons', 'section_id', w.sectionId)).toEqual(
      Array.from({ length: 12 }, (_, i) => i),
    );
  });

  it('reorder is a full-list rewrite: a stale list is 409 ORDER_MISMATCH, a lesson of another section is refused', async () => {
    const w = await world();
    const [a, b, c] = [
      await lesson(w, 'DRAFT', 0),
      await lesson(w, 'DRAFT', 1),
      await lesson(w, 'DRAFT', 2),
    ];
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/${w.sectionId}/lessons/reorder`, {
        ids: [c, a, b],
      })
      .expect(204);
    expect(
      (
        await pool.query<{ id: string }>(
          'SELECT id FROM lessons WHERE section_id = $1 ORDER BY position',
          [w.sectionId],
        )
      ).rows.map((r) => r.id),
    ).toEqual([c, a, b]);
    expect(
      (
        await api(w.owner.id)
          .post(`${courseOf(w)}/sections/${w.sectionId}/lessons/reorder`, {
            ids: [a, b],
          })
          .expect(409)
      ).body.code,
    ).toBe('ORDER_MISMATCH');
    const otherSection = await createSection(pool, w.courseId, { position: 1 });
    const elsewhere = await lesson(w, 'DRAFT', 0, otherSection);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/${w.sectionId}/lessons/reorder`, {
        ids: [c, a, b, elsewhere],
      })
      .expect(409);
    await api(w.owner.id)
      .post(`${courseOf(w)}/sections/${randomUUID()}/lessons/reorder`, {
        ids: [],
      })
      .expect(404);
  });

  it("move puts the lesson at the end of another section of the same course; another course's section or lesson is 404", async () => {
    const [w, other] = [await world(), await world()];
    const target = await createSection(pool, w.courseId, { position: 1 });
    await lesson(w, 'DRAFT', 0, target);
    const moving = await lesson(w, 'PUBLISHED', 0);
    const res = await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${moving}/move`, { sectionId: target })
      .expect(200);
    expect(res.body).toMatchObject({
      id: moving,
      sectionId: target,
      position: 1,
      status: 'PUBLISHED',
    });
    await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${moving}/move`, {
        sectionId: other.sectionId,
      })
      .expect(404);
    const foreign = await lesson(other, 'DRAFT');
    await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${foreign}/move`, { sectionId: target })
      .expect(404);
    await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${moving}/move`, { sectionId: 'nope' })
      .expect(400);
    expect((await lessonRow(moving)).section_id).toBe(target);
  });

  it('a lesson id from another course is 404 for every lesson route', async () => {
    const [w, other] = [await world(), await world()];
    const foreign = await lesson(other, 'DRAFT');
    await createTextBlock(pool, foreign);
    for (const [method, path, body] of [
      ['patch', `/lessons/${foreign}`, { title: 'x' }],
      ['post', `/lessons/${foreign}/publish`, {}],
      ['post', `/lessons/${foreign}/unpublish`, {}],
      ['post', `/lessons/${foreign}/archive`, {}],
      ['del', `/lessons/${foreign}`, undefined],
      ['post', `/lessons/${foreign}/blocks`, { type: 'TEXT', textBody: 'x' }],
      ['post', `/lessons/${foreign}/blocks/reorder`, { ids: [] }],
    ] as const) {
      const call = api(w.owner.id);
      const res = await (method === 'del'
        ? call.del(courseOf(w) + path)
        : call[method](courseOf(w) + path, body));
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
    expect((await lessonRow(foreign)).status).toBe('DRAFT');
  });
});

describe('lesson lifecycle', () => {
  it('publishing needs at least one block; the first publication sets first_published_at and notifies once', async () => {
    const w = await world();
    const id = await lesson(w, 'DRAFT');
    const refused = await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${id}/publish`)
      .expect(409);
    expect(refused.body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await lessonRow(id)).status).toBe('DRAFT');
    await createTextBlock(pool, id);
    const res = await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${id}/publish`)
      .expect(200);
    expect(res.body).toMatchObject({ id, status: 'PUBLISHED' });
    expect(res.body.firstPublishedAt).not.toBeNull();
    await sleep(100);
    expect(firstPublished).toEqual([{ courseId: w.courseId, lessonId: id }]);
    // unpublish and publish again: first_published_at is kept, nobody is notified a second time
    await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${id}/unpublish`)
      .expect(200);
    const again = await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${id}/publish`)
      .expect(200);
    expect(again.body.firstPublishedAt).toBe(res.body.firstPublishedAt);
    await sleep(100);
    expect(firstPublished).toHaveLength(1);
  });

  it('allows exactly DRAFT->PUBLISHED, PUBLISHED->DRAFT, PUBLISHED->ARCHIVED and ARCHIVED->PUBLISHED; everything else is 409 INVALID_STATE_TRANSITION', async () => {
    const w = await world();
    const attempt = async (
      status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED',
      action: 'publish' | 'unpublish' | 'archive',
    ) => {
      const id = await lesson(w, status);
      await createTextBlock(pool, id);
      return api(w.owner.id).post(`${courseOf(w)}/lessons/${id}/${action}`);
    };
    const allowed: [
      Parameters<typeof attempt>[0],
      Parameters<typeof attempt>[1],
      string,
    ][] = [
      ['DRAFT', 'publish', 'PUBLISHED'],
      ['PUBLISHED', 'unpublish', 'DRAFT'],
      ['PUBLISHED', 'archive', 'ARCHIVED'],
      ['ARCHIVED', 'publish', 'PUBLISHED'],
    ];
    for (const [from, action, to] of allowed)
      expect((await attempt(from, action)).body.status).toBe(to);
    for (const [from, action] of [
      ['DRAFT', 'unpublish'],
      ['DRAFT', 'archive'],
      ['PUBLISHED', 'publish'],
      ['ARCHIVED', 'unpublish'],
      ['ARCHIVED', 'archive'],
    ] as const) {
      const res = await attempt(from, action);
      expect([from, action, res.status, res.body.code]).toEqual([
        from,
        action,
        409,
        'INVALID_STATE_TRANSITION',
      ]);
    }
  });

  it('unpublishing or archiving the last lesson a student had not finished completes their course in the same transaction; publishing never does', async () => {
    for (const action of ['unpublish', 'archive'] as const) {
      const w = await world();
      const [a, b] = [
        await publishedLessonWithBlock(w, 0),
        await publishedLessonWithBlock(w, 1),
      ];
      await createCompletion(pool, w.enrollmentId, a, w.courseId);
      expect(await completedAt(w.enrollmentId)).toBeNull();
      await api(w.owner.id)
        .post(`${courseOf(w)}/lessons/${b}/${action}`)
        .expect(200);
      expect(await completedAt(w.enrollmentId)).not.toBeNull();
    }
    const w = await world();
    const [a, draft] = [
      await publishedLessonWithBlock(w, 0),
      await lesson(w, 'DRAFT', 1),
    ];
    await createTextBlock(pool, draft);
    await createCompletion(pool, w.enrollmentId, a, w.courseId);
    await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${draft}/publish`)
      .expect(200);
    expect(await completedAt(w.enrollmentId)).toBeNull();
  });

  it('Bug 1 through the real routes: the student marks the last lesson while the teacher unpublishes the other; the course always ends completed (20 races)', async () => {
    for (let round = 0; round < 20; round++) {
      const w = await world();
      const [a, b, c] = [
        await publishedLessonWithBlock(w, 0),
        await publishedLessonWithBlock(w, 1),
        await publishedLessonWithBlock(w, 2),
      ];
      await createCompletion(pool, w.enrollmentId, a, w.courseId);
      const [mark, unpublish] = await Promise.all([
        api(w.student.id).put(`${courseOf(w)}/lessons/${b}/completion`),
        api(w.owner.id).post(`${courseOf(w)}/lessons/${c}/unpublish`),
      ]);
      expect([mark.status, unpublish.status]).toEqual([200, 200]);
      expect(await completedAt(w.enrollmentId)).not.toBeNull();
    }
  }, 90_000);
});

describe("the Course row is the mutex between students' progress and teachers' structure changes (Decision 160)", () => {
  const lock = (courseId: string, mode: 'FOR SHARE' | 'FOR NO KEY UPDATE') =>
    holdTx(
      pool,
      `course-${mode}`,
      `SELECT 1 FROM courses WHERE id = $1 ${mode}`,
      [courseId],
    );

  it.each([
    [
      'unpublish a lesson',
      (w: World, l: string) =>
        api(w.owner.id).post(`${courseOf(w)}/lessons/${l}/unpublish`),
    ],
    [
      'archive a lesson',
      (w: World, l: string) =>
        api(w.owner.id).post(`${courseOf(w)}/lessons/${l}/archive`),
    ],
    [
      'publish a lesson',
      (w: World, l: string) =>
        api(w.owner.id).post(`${courseOf(w)}/lessons/${l}/publish`),
    ],
    [
      'add a section',
      (w: World) =>
        api(w.owner.id).post(`${courseOf(w)}/sections`, { title: 'x' }),
    ],
    [
      'reorder sections',
      (w: World) =>
        api(w.owner.id).post(`${courseOf(w)}/sections/reorder`, {
          ids: [w.sectionId],
        }),
    ],
    [
      'move a lesson',
      (w: World, l: string) =>
        api(w.owner.id).post(`${courseOf(w)}/lessons/${l}/move`, {
          sectionId: w.sectionId,
        }),
    ],
  ])(
    '%s waits for a student who holds Course-S (marking a lesson), then runs',
    async (_name, call) => {
      const w = await world();
      const l = await publishedLessonWithBlock(w);
      const student = await lock(w.courseId, 'FOR SHARE');
      const response = call(w, l).then((r) => r);
      expect(await settlesWithin(response, 400)).toBe(false);
      await student.release('commit');
      expect((await response).status).toBeLessThan(500); // it ran (publishing an already published lesson is a 409, not a hang)
    },
  );

  it('a student marking a lesson waits for a teacher who holds Course-X (a structure change in progress)', async () => {
    const w = await world();
    const [a, b] = [
      await publishedLessonWithBlock(w, 0),
      await publishedLessonWithBlock(w, 1),
    ];
    await createCompletion(pool, w.enrollmentId, a, w.courseId);
    const teacher = await lock(w.courseId, 'FOR NO KEY UPDATE');
    const response = api(w.student.id)
      .put(`${courseOf(w)}/lessons/${b}/completion`)
      .then((r) => r);
    expect(await settlesWithin(response, 400)).toBe(false);
    await teacher.release('commit');
    expect((await response).status).toBe(200);
  });

  it('plain edits (rename, blocks) do not take the Course lock: they run while a student holds it', async () => {
    const w = await world();
    const l = await lesson(w, 'DRAFT');
    const student = await lock(w.courseId, 'FOR SHARE');
    await api(w.owner.id)
      .patch(`${courseOf(w)}/lessons/${l}`, { title: 'Renamed' })
      .expect(200);
    await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${l}/blocks`, {
        type: 'TEXT',
        textBody: 'x',
      })
      .expect(201);
    await student.release('commit');
  });
});

describe('permanent deletion of a lesson', () => {
  it('only a lesson that is not published, was never published and has no completions can be deleted', async () => {
    const w = await world();
    const never = await lesson(w, 'DRAFT');
    const neverArchived = await createLesson(pool, w.courseId, w.sectionId, {
      status: 'ARCHIVED',
      firstPublishedAt: null,
    });
    await api(w.owner.id)
      .del(`${courseOf(w)}/lessons/${never}`)
      .expect(204);
    await api(w.owner.id)
      .del(`${courseOf(w)}/lessons/${neverArchived}`)
      .expect(204); // ARCHIVED but never published
    const published = await publishedLessonWithBlock(w, 5);
    const whilePublished = await api(w.owner.id)
      .del(`${courseOf(w)}/lessons/${published}`)
      .expect(409);
    expect(whilePublished.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(whilePublished.body.message).toMatch(/unpublish it first/);
    await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${published}/archive`)
      .expect(200);
    await api(w.owner.id)
      .del(`${courseOf(w)}/lessons/${published}`)
      .expect(409); // archived, but it was published once
    await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${published}/publish`)
      .expect(200);
    await api(w.owner.id)
      .post(`${courseOf(w)}/lessons/${published}/unpublish`)
      .expect(200);
    await api(w.owner.id)
      .del(`${courseOf(w)}/lessons/${published}`)
      .expect(409); // unpublished, but it was published once
    expect(
      (await pool.query('SELECT 1 FROM lessons WHERE id = $1', [published]))
        .rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT 1 FROM lessons WHERE id = ANY($1::uuid[])', [
          [never, neverArchived],
        ])
      ).rowCount,
    ).toBe(0);
  });

  it('a lesson with a completion cannot be deleted, even when it is no longer flagged as published once', async () => {
    const w = await world();
    const completed = await createLesson(pool, w.courseId, w.sectionId, {
      status: 'PUBLISHED',
      firstPublishedAt: new Date(),
    });
    await createCompletion(pool, w.enrollmentId, completed, w.courseId);
    // rows built outside the application: the lesson was published, completed, then forced back to a never-published DRAFT
    await pool.query(
      "UPDATE lessons SET status = 'DRAFT', first_published_at = NULL WHERE id = $1",
      [completed],
    );
    const res = await api(w.owner.id)
      .del(`${courseOf(w)}/lessons/${completed}`)
      .expect(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.message).toMatch(/completed/);
  });
});

describe('blocks', () => {
  it('TEXT: stores Markdown as text up to 20000 characters (code points); more is 400', async () => {
    const w = await world();
    const id = await lesson(w, 'DRAFT');
    const url = `${courseOf(w)}/lessons/${id}/blocks`;
    const created = (
      await api(w.owner.id)
        .post(url, {
          type: 'TEXT',
          textBody: '# Title\n\n**bold** `code` <script>alert(1)</script>',
        })
        .expect(201)
    ).body;
    expect(created).toMatchObject({
      type: 'TEXT',
      position: 0,
      textBody: '# Title\n\n**bold** `code` <script>alert(1)</script>',
      video: null,
      file: null,
    });
    await api(w.owner.id)
      .post(url, { type: 'TEXT', textBody: '😀'.repeat(20_000) })
      .expect(201);
    await api(w.owner.id)
      .post(url, { type: 'TEXT', textBody: 'x'.repeat(20_001) })
      .expect(400);
    await api(w.owner.id).post(url, { type: 'TEXT', textBody: '' }).expect(400);
    await api(w.owner.id).post(url, { type: 'TEXT' }).expect(400);
    await api(w.owner.id)
      .post(url, { type: 'IMAGE', textBody: 'x' })
      .expect(400);
    await api(w.owner.id)
      .post(url, {
        type: 'TEXT',
        textBody: 'x',
        videoUrl: 'https://youtu.be/dQw4w9WgXcQ',
      })
      .expect(400);
    await api(w.owner.id)
      .post(url, { type: 'TEXT', textBody: 'x', fileId: randomUUID() })
      .expect(400);
  });

  it('VIDEO: only YouTube and Vimeo; the provider and id are stored and the embed URL is built by the server', async () => {
    const w = await world();
    const id = await lesson(w, 'DRAFT');
    const url = `${courseOf(w)}/lessons/${id}/blocks`;
    const yt = (
      await api(w.owner.id)
        .post(url, {
          type: 'VIDEO',
          videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5',
        })
        .expect(201)
    ).body;
    expect(yt.video).toEqual({
      provider: 'YOUTUBE',
      externalId: 'dQw4w9WgXcQ',
      embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    });
    const vimeo = (
      await api(w.owner.id)
        .post(url, { type: 'VIDEO', videoUrl: 'https://vimeo.com/76979871' })
        .expect(201)
    ).body;
    expect(vimeo.video).toEqual({
      provider: 'VIMEO',
      externalId: '76979871',
      embedUrl: 'https://player.vimeo.com/video/76979871',
    });
    const row = (
      await pool.query(
        'SELECT video_provider, video_external_id, text_body FROM content_blocks WHERE id = $1',
        [yt.id],
      )
    ).rows[0];
    expect(row).toEqual({
      video_provider: 'YOUTUBE',
      video_external_id: 'dQw4w9WgXcQ',
      text_body: null,
    });
    for (const hostile of [
      'https://www.dailymotion.com/video/x7tgad0',
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ"onload="x',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'not a url',
      '',
    ]) {
      const res = await api(w.owner.id).post(url, {
        type: 'VIDEO',
        videoUrl: hostile,
      });
      expect([hostile, res.status]).toEqual([hostile, 400]);
    }
    const bad = await api(w.owner.id)
      .post(url, { type: 'VIDEO', videoUrl: 'https://vimeo.com/abc' })
      .expect(400);
    expect(bad.body.errors[0].field).toBe('videoUrl');
    await api(w.owner.id)
      .post(url, {
        type: 'VIDEO',
        videoUrl: `https://youtu.be/dQw4w9WgXcQ?${'x'.repeat(300)}`,
      })
      .expect(400);
    expect(
      (
        await pool.query('SELECT 1 FROM content_blocks WHERE lesson_id = $1', [
          id,
        ])
      ).rowCount,
    ).toBe(2);
  });

  it('FILE: the file must be your own LESSON_ATTACHMENT that no other block uses', async () => {
    const w = await world();
    const id = await lesson(w, 'DRAFT');
    const other = await lesson(w, 'DRAFT', 1);
    const url = `${courseOf(w)}/lessons/${id}/blocks`;
    const mine = await createFile(pool, w.owner.id, {
      kind: 'LESSON_ATTACHMENT',
    });
    const assistants = await createFile(pool, w.assistant.id, {
      kind: 'LESSON_ATTACHMENT',
    });
    const avatar = await createFile(pool, w.owner.id, { kind: 'AVATAR' });
    const cover = await createFile(pool, w.owner.id, { kind: 'COURSE_COVER' });
    const created = (
      await api(w.owner.id)
        .post(url, { type: 'FILE', fileId: mine })
        .expect(201)
    ).body;
    expect(created).toMatchObject({
      type: 'FILE',
      file: { name: 'file.png', mimeType: 'image/png', sizeBytes: 1024 },
      textBody: null,
      video: null,
    });
    expect(JSON.stringify(created)).not.toContain('files/');
    await api(w.owner.id)
      .post(url, { type: 'FILE', fileId: assistants })
      .expect(404); // somebody else's upload
    await api(w.owner.id)
      .post(url, { type: 'FILE', fileId: randomUUID() })
      .expect(404);
    expect(
      (
        await api(w.owner.id)
          .post(url, { type: 'FILE', fileId: avatar })
          .expect(400)
      ).body.errors[0].field,
    ).toBe('fileId');
    await api(w.owner.id)
      .post(url, { type: 'FILE', fileId: cover })
      .expect(400);
    expect(
      (
        await api(w.owner.id)
          .post(url, { type: 'FILE', fileId: mine })
          .expect(409)
      ).body.code,
    ).toBe('RESOURCE_CONFLICT');
    expect(
      (
        await api(w.owner.id)
          .post(`${courseOf(w)}/lessons/${other}/blocks`, {
            type: 'FILE',
            fileId: mine,
          })
          .expect(409)
      ).body.code,
    ).toBe('RESOURCE_CONFLICT');
    await api(w.assistant.id)
      .post(url, { type: 'FILE', fileId: assistants })
      .expect(201);
    await api(w.owner.id).post(url, { type: 'FILE' }).expect(400);
  });

  it('the same file used by two blocks at the same moment: one wins, the other is 409', async () => {
    const w = await world();
    const [a, b] = [await lesson(w, 'DRAFT', 0), await lesson(w, 'DRAFT', 1)];
    const file = await createFile(pool, w.owner.id, {
      kind: 'LESSON_ATTACHMENT',
    });
    const results = await Promise.all([
      api(w.owner.id).post(`${courseOf(w)}/lessons/${a}/blocks`, {
        type: 'FILE',
        fileId: file,
      }),
      api(w.owner.id).post(`${courseOf(w)}/lessons/${b}/blocks`, {
        type: 'FILE',
        fileId: file,
      }),
    ]);
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
      201, 409,
    ]);
  });

  it('PATCH changes a text or video block; a file block cannot change; fields of the wrong type are 400', async () => {
    const w = await world();
    const id = await lesson(w, 'DRAFT');
    const text = await createTextBlock(pool, id);
    const video = await createVideoBlock(pool, id);
    const file = await createFile(pool, w.owner.id, {
      kind: 'LESSON_ATTACHMENT',
    });
    const fileBlock = await createFileBlock(pool, id, file);
    const base = `${courseOf(w)}/lessons/${id}/blocks`;
    expect(
      (
        await api(w.owner.id)
          .patch(`${base}/${text}`, { textBody: 'New text' })
          .expect(200)
      ).body.textBody,
    ).toBe('New text');
    expect(
      (
        await api(w.owner.id)
          .patch(`${base}/${video}`, { videoUrl: 'https://vimeo.com/76979871' })
          .expect(200)
      ).body.video,
    ).toMatchObject({ provider: 'VIMEO', externalId: '76979871' });
    await api(w.owner.id)
      .patch(`${base}/${video}`, { videoUrl: 'https://evil.example/x' })
      .expect(400);
    await api(w.owner.id)
      .patch(`${base}/${text}`, { videoUrl: 'https://vimeo.com/76979871' })
      .expect(400);
    await api(w.owner.id)
      .patch(`${base}/${video}`, { textBody: 'x' })
      .expect(400);
    await api(w.owner.id).patch(`${base}/${text}`, {}).expect(400);
    await api(w.owner.id)
      .patch(`${base}/${fileBlock}`, { textBody: 'x' })
      .expect(400);
    await api(w.owner.id)
      .patch(`${base}/${text}`, { type: 'VIDEO' })
      .expect(400);
    await api(w.owner.id)
      .patch(`${base}/${randomUUID()}`, { textBody: 'x' })
      .expect(404);
  });

  it('twelve parallel appends get different positions; reorder is a full-list rewrite with ORDER_MISMATCH on a stale list', async () => {
    const w = await world();
    const id = await lesson(w, 'DRAFT');
    const base = `${courseOf(w)}/lessons/${id}/blocks`;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api(w.owner.id).post(base, { type: 'TEXT', textBody: `block ${i}` }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect(await positions('content_blocks', 'lesson_id', id)).toEqual(
      Array.from({ length: 12 }, (_, i) => i),
    );
    const ids = (
      await pool.query<{ id: string }>(
        'SELECT id FROM content_blocks WHERE lesson_id = $1 ORDER BY position',
        [id],
      )
    ).rows.map((r) => r.id);
    const reversed = [...ids].reverse();
    await api(w.owner.id)
      .post(`${base}/reorder`, { ids: reversed })
      .expect(204);
    expect(
      (
        await pool.query<{ id: string }>(
          'SELECT id FROM content_blocks WHERE lesson_id = $1 ORDER BY position',
          [id],
        )
      ).rows.map((r) => r.id),
    ).toEqual(reversed);
    expect(
      (await api(w.owner.id).post(`${base}/reorder`, { ids }).expect(204))
        .status,
    ).toBe(204);
    expect(
      (
        await api(w.owner.id)
          .post(`${base}/reorder`, { ids: ids.slice(1) })
          .expect(409)
      ).body.code,
    ).toBe('ORDER_MISMATCH');
  });

  it('delete removes the block (404 the second time); a block of another lesson is 404', async () => {
    const w = await world();
    const [a, b] = [await lesson(w, 'DRAFT', 0), await lesson(w, 'DRAFT', 1)];
    const block = await createTextBlock(pool, a);
    await api(w.owner.id)
      .del(`${courseOf(w)}/lessons/${b}/blocks/${block}`)
      .expect(404);
    await api(w.owner.id)
      .del(`${courseOf(w)}/lessons/${a}/blocks/${block}`)
      .expect(204);
    await api(w.owner.id)
      .del(`${courseOf(w)}/lessons/${a}/blocks/${block}`)
      .expect(404);
  });
});

describe('downloads of file blocks', () => {
  async function withFile() {
    const w = await world();
    const lessonId = await lesson(w, 'PUBLISHED');
    const file = await createFile(pool, w.owner.id, {
      kind: 'LESSON_ATTACHMENT',
    });
    const block = await createFileBlock(pool, lessonId, file);
    return {
      w,
      lessonId,
      block,
      url: `${courseOf(w)}/lessons/${lessonId}/blocks/${block}/download`,
    };
  }

  it('teachers and ACTIVE students get a short-lived signed link', async () => {
    const { w, url } = await withFile();
    for (const user of [w.owner, w.assistant, w.student]) {
      const res = await api(user.id).get(url).expect(200);
      expect(res.body.url).toMatch(/^https:\/\/signed\.test\//);
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
    }
    expect(
      storage.signed.every((s) => s.options.expiresInSeconds === 300),
    ).toBe(true);
  });

  it('it is re-checked on every request: once the lesson is unpublished the student gets 404 at once, a teacher still gets the link', async () => {
    const { w, lessonId, url } = await withFile();
    await api(w.student.id).get(url).expect(200);
    await pool.query("UPDATE lessons SET status = 'DRAFT' WHERE id = $1", [
      lessonId,
    ]);
    await api(w.student.id).get(url).expect(404);
    await api(w.owner.id).get(url).expect(200);
    await pool.query("UPDATE lessons SET status = 'ARCHIVED' WHERE id = $1", [
      lessonId,
    ]);
    await api(w.student.id).get(url).expect(404);
  });

  it("a draft lesson's file is 404 for a student even when the ids are known; LEFT and pending students get 403; other courses and non-file blocks are 404", async () => {
    const w = await world();
    const draft = await lesson(w, 'DRAFT');
    const file = await createFile(pool, w.owner.id, {
      kind: 'LESSON_ATTACHMENT',
    });
    const block = await createFileBlock(pool, draft, file);
    await api(w.student.id)
      .get(`${courseOf(w)}/lessons/${draft}/blocks/${block}/download`)
      .expect(404);
    const left = await createUser(pool);
    await createEnrollment(pool, w.courseId, left.id, { status: 'LEFT' });
    await api(left.id)
      .get(`${courseOf(w)}/lessons/${draft}/blocks/${block}/download`)
      .expect(403);
    const other = await world();
    await api(other.owner.id)
      .get(
        `/courses/${other.courseId}/lessons/${draft}/blocks/${block}/download`,
      )
      .expect(404);
    const text = await createTextBlock(pool, draft, 'x');
    await api(w.owner.id)
      .get(`${courseOf(w)}/lessons/${draft}/blocks/${text}/download`)
      .expect(404);
    expect(storage.signed).toHaveLength(0);
  });
});

describe('an archived or Admin-locked course refuses every mutation: 409 COURSE_ARCHIVED, and COURSE_ADMIN_LOCKED takes precedence', () => {
  const cases = async (w: World) => {
    const empty = await createSection(pool, w.courseId, { position: 5 });
    const lessonId = await createLesson(pool, w.courseId, w.sectionId, {
      status: 'DRAFT',
      position: 0,
    });
    const blockId = await createTextBlock(pool, lessonId);
    const base = courseOf(w);
    return [
      ['post', `${base}/sections`, { title: 'x' }],
      ['post', `${base}/sections/reorder`, { ids: [] }],
      ['patch', `${base}/sections/${w.sectionId}`, { title: 'x' }],
      ['del', `${base}/sections/${empty}`, undefined],
      ['post', `${base}/sections/${w.sectionId}/lessons`, { title: 'x' }],
      ['post', `${base}/sections/${w.sectionId}/lessons/reorder`, { ids: [] }],
      ['patch', `${base}/lessons/${lessonId}`, { title: 'x' }],
      ['post', `${base}/lessons/${lessonId}/move`, { sectionId: empty }],
      ['post', `${base}/lessons/${lessonId}/publish`, {}],
      ['post', `${base}/lessons/${lessonId}/unpublish`, {}],
      ['post', `${base}/lessons/${lessonId}/archive`, {}],
      ['del', `${base}/lessons/${lessonId}`, undefined],
      [
        'post',
        `${base}/lessons/${lessonId}/blocks`,
        { type: 'TEXT', textBody: 'x' },
      ],
      ['post', `${base}/lessons/${lessonId}/blocks/reorder`, { ids: [] }],
      [
        'patch',
        `${base}/lessons/${lessonId}/blocks/${blockId}`,
        { textBody: 'y' },
      ],
      ['del', `${base}/lessons/${lessonId}/blocks/${blockId}`, undefined],
    ] as const;
  };
  const run = async (w: World, expected: string) => {
    for (const [method, path, body] of await cases(w)) {
      const call = api(w.owner.id);
      const res = await (method === 'del'
        ? call.del(path)
        : call[method](path, body));
      expect([method, path, res.status, res.body.code]).toEqual([
        method,
        path,
        409,
        expected,
      ]);
    }
  };

  it('archived course: 409 COURSE_ARCHIVED on all 16 mutations, nothing changes', async () => {
    const w = await world({ status: 'ARCHIVED', archivedAt: new Date() });
    const before = (
      await pool.query(
        'SELECT (SELECT count(*) FROM sections) s, (SELECT count(*) FROM lessons) l, (SELECT count(*) FROM content_blocks) b',
      )
    ).rows[0];
    await run(w, 'COURSE_ARCHIVED');
    expect(
      (
        await pool.query(
          'SELECT (SELECT count(*) FROM sections) s, (SELECT count(*) FROM lessons) l, (SELECT count(*) FROM content_blocks) b',
        )
      ).rows[0],
    ).toEqual({
      s: String(Number(before.s) + 1),
      l: String(Number(before.l) + 1),
      b: String(Number(before.b) + 1),
    });
  });

  it('Admin-locked course (locked implies archived): 409 COURSE_ADMIN_LOCKED on all 16 mutations, not COURSE_ARCHIVED', async () => {
    const w = await world({
      status: 'ARCHIVED',
      archivedAt: new Date(),
      lockedByAdminAt: new Date(),
    });
    await run(w, 'COURSE_ADMIN_LOCKED');
  });

  it('a draft and a published course are editable', async () => {
    const draft = await world({
      status: 'DRAFT',
      summary: null,
      categoryId: null,
      firstPublishedAt: null,
    });
    await api(draft.owner.id)
      .post(`${courseOf(draft)}/sections`, { title: 'x' })
      .expect(201);
    const published = await world();
    await api(published.owner.id)
      .post(`${courseOf(published)}/sections`, { title: 'x' })
      .expect(201);
  });

  it('students are shut out of a locked course (403) while the Owner keeps seeing it', async () => {
    const w = await world({
      status: 'ARCHIVED',
      archivedAt: new Date(),
      lockedByAdminAt: new Date(),
    });
    await api(w.student.id)
      .get(`${courseOf(w)}/outline`)
      .expect(403);
    await api(w.owner.id)
      .get(`${courseOf(w)}/outline`)
      .expect(200);
  });
});
