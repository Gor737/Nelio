// M11 exit: a full learning journey through real HTTP with real login, across Auth, Users, Courses, Content, Enrollments, Progress, Chat
// and Notifications. Only the mail transport is replaced by a recorder (it hands the test the tokens a person would click).
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import {
  DatabaseModule,
  TransactionService,
} from '../../src/infrastructure/database/index.js';
import { EventsModule } from '../../src/infrastructure/events/index.js';
import { MailService } from '../../src/infrastructure/mail/index.js';
import { AuthModule } from '../../src/modules/auth/index.js';
import { ChatModule } from '../../src/modules/chat/index.js';
import { ContentModule } from '../../src/modules/content/index.js';
import { CoursesModule } from '../../src/modules/courses/index.js';
import { EnrollmentsModule } from '../../src/modules/enrollments/index.js';
import { NotificationsModule } from '../../src/modules/notifications/index.js';
import { ProgressModule } from '../../src/modules/progress/index.js';
import {
  UserAccountService,
  UsersModule,
} from '../../src/modules/users/index.js';
import { createPool, resetData } from '../support/database.js';
import { createAdmin } from '../support/factories.js';
import { createCategory } from '../support/factories-courses.js';
import { closeApp, testEnv } from '../support/integration-app.js';

const pool = createPool(20);
let app: NestExpressApplication;
let accounts: UserAccountService;
let transactions: TransactionService;
const tokens: { kind: string; to: string; token?: string }[] = [];
const fakeMail = {
  sendEmailVerification: (to: string, input: { token: string }) => {
    tokens.push({ kind: 'verification', to, token: input.token });
    return Promise.resolve(true);
  },
  sendPasswordReset: (to: string, input: { token: string }) => {
    tokens.push({ kind: 'reset', to, token: input.token });
    return Promise.resolve(true);
  },
  sendAlreadyRegistered: (to: string) => {
    tokens.push({ kind: 'already', to });
    return Promise.resolve(true);
  },
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      UsersModule,
      AuthModule,
      CoursesModule,
      ContentModule,
      EnrollmentsModule,
      ProgressModule,
      ChatModule,
      NotificationsModule,
    ],
    providers: GLOBAL_PROVIDERS,
  })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  accounts = app.get(UserAccountService, { strict: false });
  transactions = app.get(TransactionService);
});
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  tokens.length = 0;
});

let counter = 0;
const ip = () => `10.12.${(counter >> 8) & 255}.${counter++ & 255}`;
const call = (
  m: 'get' | 'post' | 'put' | 'patch',
  path: string,
  token?: string,
  body?: object,
) => {
  const r = request(app.getHttpServer())
    [m](`/api/v1${path}`)
    .set('X-Forwarded-For', ip());
  if (token) r.set('Authorization', `Bearer ${token}`);
  return body === undefined ? r : r.send(body);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PASSWORD = 'a perfectly fine passphrase';

/** Registers, verifies the email from the "mail", and logs in: returns the access token, the refresh cookie and the user id. */
async function signUp(email: string, fullName: string) {
  await call('post', '/auth/register', undefined, {
    email,
    fullName,
    password: PASSWORD,
  }).expect(202);
  const mail = tokens.find(
    (t) => t.kind === 'verification' && t.to === email,
  ) as { token: string };
  await call('post', '/auth/verify-email', undefined, {
    token: mail.token,
  }).expect(204);
  const res = await call('post', '/auth/login', undefined, {
    email,
    password: PASSWORD,
  }).expect(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('nelio_refresh='),
  ) as string;
  const me = await call('get', '/me', res.body.accessToken).expect(200);
  return {
    token: res.body.accessToken as string,
    cookie: cookie.split(';')[0],
    id: me.body.id as string,
  };
}

describe('a full learning journey', () => {
  it('a teacher is approved and publishes a course; a student finds it, enrolls, learns, completes it, chats and gets notified', async () => {
    // --- the teacher: sign up, apply, an Admin approves (through the Users primitives), log in again to get the new role
    const teacher = await signUp('teacher@example.test', 'Teacher Tamar');
    await call('post', '/me/teacher-application', teacher.token, {
      message: 'I have taught Armenian for ten years.',
    }).expect(201);
    const admin = await createAdmin(pool);
    await transactions.run((tx) =>
      accounts.approveApplication(tx, {
        userId: teacher.id,
        decidedBy: admin.id,
        note: 'Welcome',
      }),
    );
    expect(
      (await call('get', '/me', teacher.token).expect(200)).body.roles,
    ).toContainEqual({ role: 'TEACHER', status: 'ACTIVE' });

    // --- the teacher builds the course
    const categoryId = await createCategory(pool);
    const course = (
      await call('post', '/courses', teacher.token, {
        title: 'Armenian for beginners',
        enrollmentPolicy: 'OPEN',
        summary: 'Learn the alphabet and everyday phrases.',
        categoryId,
      }).expect(201)
    ).body;
    await call('put', `/courses/${course.id}/tags`, teacher.token, {
      names: ['Armenian', 'language'],
    }).expect(200);
    const section = (
      await call('post', `/courses/${course.id}/sections`, teacher.token, {
        title: 'Week 1',
      }).expect(201)
    ).body;
    const lesson = (
      await call(
        'post',
        `/courses/${course.id}/sections/${section.id}/lessons`,
        teacher.token,
        { title: 'The alphabet' },
      ).expect(201)
    ).body;
    await call(
      'post',
      `/courses/${course.id}/lessons/${lesson.id}/blocks`,
      teacher.token,
      { type: 'TEXT', textBody: '# Ա Բ Գ\n\nThe first letters.' },
    ).expect(201);
    await call(
      'post',
      `/courses/${course.id}/lessons/${lesson.id}/blocks`,
      teacher.token,
      { type: 'VIDEO', videoUrl: 'https://youtu.be/dQw4w9WgXcQ' },
    ).expect(201);
    await call('post', `/courses/${course.id}/publish`, teacher.token).expect(
      409,
    ); // no published lesson yet
    await call(
      'post',
      `/courses/${course.id}/lessons/${lesson.id}/publish`,
      teacher.token,
    ).expect(200);
    expect(
      (
        await call(
          'post',
          `/courses/${course.id}/publish`,
          teacher.token,
        ).expect(200)
      ).body.status,
    ).toBe('PUBLISHED');

    // --- the student: sign up, find the course in the public catalog by searching in Armenian and English, read the syllabus
    const student = await signUp('student@example.test', 'Student Anna');
    const found = (
      await call(
        'get',
        `/courses?q=${encodeURIComponent('Armenian begin')}`,
      ).expect(200)
    ).body;
    expect(found.items.map((c: { id: string }) => c.id)).toEqual([course.id]);
    expect(
      (await call('get', `/courses/${course.id}/syllabus`).expect(200)).body[0]
        .lessons[0].title,
    ).toBe('The alphabet');
    await call('get', `/courses/${course.id}/outline`, student.token).expect(
      403,
    ); // not enrolled: no content

    // --- she enrolls (OPEN), reads the lesson, remembers her place and completes the course
    expect(
      (
        await call(
          'post',
          `/courses/${course.id}/enrollments`,
          student.token,
        ).expect(201)
      ).body.status,
    ).toBe('ACTIVE');
    const outline = (
      await call('get', `/courses/${course.id}/outline`, student.token).expect(
        200,
      )
    ).body;
    expect(outline.sections[0].lessons).toEqual([
      { id: lesson.id, title: 'The alphabet', position: 0 },
    ]);
    const content = (
      await call(
        'get',
        `/courses/${course.id}/lessons/${lesson.id}`,
        student.token,
      ).expect(200)
    ).body;
    expect(content.blocks.map((b: { type: string }) => b.type)).toEqual([
      'TEXT',
      'VIDEO',
    ]);
    await call(
      'put',
      `/courses/${course.id}/enrollments/me/last-visited`,
      student.token,
      { lessonId: lesson.id },
    ).expect(204);
    const done = (
      await call(
        'put',
        `/courses/${course.id}/lessons/${lesson.id}/completion`,
        student.token,
      ).expect(200)
    ).body;
    expect(done).toMatchObject({
      courseCompleted: true,
      progress: { percent: 100 },
    });
    const mine = (
      await call(
        'get',
        `/courses/${course.id}/enrollments/me`,
        student.token,
      ).expect(200)
    ).body;
    expect(mine).toMatchObject({
      status: 'ACTIVE',
      lastVisitedLessonId: lesson.id,
    });
    expect(mine.completedAt).not.toBeNull();

    // --- the course channel: the student and the teacher talk
    const channel = (
      await call('get', `/courses/${course.id}/channel`, student.token).expect(
        200,
      )
    ).body;
    expect(channel).toMatchObject({
      type: 'COURSE_CHANNEL',
      title: 'Armenian for beginners',
      memberCount: 2,
    });
    await call('post', `/conversations/${channel.id}/messages`, student.token, {
      body: 'Barev! I finished lesson 1.',
      clientId: '0a6e1b52-33f3-4f36-8c57-6a2f5a6a7b11',
    }).expect(201);
    const history = (
      await call(
        'get',
        `/conversations/${channel.id}/messages`,
        teacher.token,
      ).expect(200)
    ).body;
    expect(history.items.map((m: { body: string }) => m.body)).toEqual([
      'Barev! I finished lesson 1.',
    ]);

    // --- the teacher adds a second lesson: the completed student keeps her completion (percent drops) and is notified
    const lesson2 = (
      await call(
        'post',
        `/courses/${course.id}/sections/${section.id}/lessons`,
        teacher.token,
        { title: 'Greetings' },
      ).expect(201)
    ).body;
    await call(
      'post',
      `/courses/${course.id}/lessons/${lesson2.id}/blocks`,
      teacher.token,
      { type: 'TEXT', textBody: 'Barev dzez.' },
    ).expect(201);
    await call(
      'post',
      `/courses/${course.id}/lessons/${lesson2.id}/publish`,
      teacher.token,
    ).expect(200);
    await sleep(300);
    const after = (
      await call(
        'get',
        `/courses/${course.id}/enrollments/me`,
        student.token,
      ).expect(200)
    ).body;
    expect(after.completedAt).not.toBeNull();
    expect(after.progress.percent).toBe(50);
    const notifications = (
      await call('get', '/me/notifications', student.token).expect(200)
    ).body.items;
    expect(notifications).toEqual([
      expect.objectContaining({
        type: 'LESSON_PUBLISHED',
        courseId: course.id,
        data: expect.objectContaining({ lessonTitle: 'Greetings' }),
      }),
    ]);
    expect(
      (
        await call(
          'get',
          '/me/notifications/unread-count',
          student.token,
        ).expect(200)
      ).body.count,
    ).toBe(1);

    // --- the session machinery: refresh rotates, logout ends the session
    const refreshed = await call('post', '/auth/refresh', undefined)
      .set('Cookie', student.cookie)
      .expect(200);
    await call('get', '/me/enrollments', refreshed.body.accessToken).expect(
      200,
    );
    const next = (
      refreshed.headers['set-cookie'] as unknown as string[]
    )[0].split(';')[0];
    await call('post', '/auth/logout', undefined)
      .set('Cookie', next)
      .expect(204);
    await call('post', '/auth/refresh', undefined)
      .set('Cookie', next)
      .expect(401);
    expect(
      (await call('get', '/me/enrollments', student.token).expect(200)).body
        .items[0],
    ).toMatchObject({ courseId: course.id });
  });
});
