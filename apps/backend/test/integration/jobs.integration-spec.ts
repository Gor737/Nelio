// M13a: the nightly jobs. They are registered with the scheduler at the documented times, each one runs its work through the guarded
// wrapper, the two safety-net sweepers repair real drift AND log it, and a second run changes nothing and logs no repair (Decision 162).
import { jest } from '@jest/globals';
import { SchedulerRegistry, ScheduleModule } from '@nestjs/schedule';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { configureApp } from '../../src/app.setup.js';
import { AppModule } from '../../src/app.module.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { JOB_SCHEDULE } from '../../src/common/constants/job-schedule.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import { DatabaseModule } from '../../src/infrastructure/database/index.js';
import { EventsModule } from '../../src/infrastructure/events/index.js';
import { MailService } from '../../src/infrastructure/mail/index.js';
import { AuthCleanupService } from '../../src/modules/auth/services/auth-cleanup.service.js';
import { AuthCleanupJob } from '../../src/modules/auth/services/auth-cleanup.job.js';
import { AuthModule } from '../../src/modules/auth/index.js';
import { CourseChannelService } from '../../src/modules/chat/services/course-channel.service.js';
import { ChannelReconcileJob } from '../../src/modules/chat/services/channel-reconcile.job.js';
import { ChatModule } from '../../src/modules/chat/index.js';
import { FileCleanupService } from '../../src/modules/files/services/file-cleanup.service.js';
import { FileCleanupJob } from '../../src/modules/files/services/file-cleanup.job.js';
import { FilesModule } from '../../src/modules/files/index.js';
import { NotificationRetention } from '../../src/modules/notifications/services/notification-retention.service.js';
import { NotificationRetentionJob } from '../../src/modules/notifications/services/notification-retention.job.js';
import { NotificationsModule } from '../../src/modules/notifications/index.js';
import { CompletionService } from '../../src/modules/progress/services/completion.service.js';
import { CompletionRecheckJob } from '../../src/modules/progress/services/completion-recheck.job.js';
import { ProgressModule } from '../../src/modules/progress/index.js';
import { StorageDriver } from '../../src/modules/files/storage/storage-driver.js';
import { createPool, resetData } from '../support/database.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { captureLogs, type LogCapture } from '../support/log-capture.js';
import {
  createFile,
  createRefreshToken,
  createTeacher,
  createUser,
} from '../support/factories.js';
import { addMember, createChannel } from '../support/factories-chat.js';
import { createLesson, createSection } from '../support/factories-content.js';
import {
  addCourseTeacher,
  createNotification,
  createPublishedCourse,
} from '../support/factories-courses.js';
import {
  createCompletion,
  createEnrollment,
} from '../support/factories-learning.js';
import { testEnv } from '../support/integration-app.js';

const pool = createPool();
let app: NestExpressApplication;
let logs: LogCapture | undefined;

const fakeMail = {
  sendEmailVerification: () => Promise.resolve(true),
  sendPasswordReset: () => Promise.resolve(true),
  sendAlreadyRegistered: () => Promise.resolve(true),
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv()),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      ScheduleModule.forRoot(),
      AuthModule,
      FilesModule,
      NotificationsModule,
      ChatModule,
      ProgressModule,
    ],
    providers: GLOBAL_PROVIDERS,
  })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .overrideProvider(StorageDriver)
    .useValue(new InMemoryStorage())
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app); // the JSON logger, whose output the tests capture
  await app.init();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => resetData(pool));
afterEach(() => {
  logs?.restore();
  logs = undefined;
});

const run = async <T>(work: () => Promise<T>) => {
  logs = captureLogs();
  const result = await work();
  const output = logs.output();
  logs.restore();
  logs = undefined;
  return { result, output };
};

describe('the schedule', () => {
  it('registers exactly the five jobs, at the documented UTC times', () => {
    const registry = app.get(SchedulerRegistry);
    const jobs = registry.getCronJobs();
    expect([...jobs.keys()].sort()).toEqual(
      Object.values(JOB_SCHEDULE)
        .map((j) => j.name)
        .sort(),
    );
    for (const { name, cron } of Object.values(JOB_SCHEDULE)) {
      const job = jobs.get(name);
      expect(job?.cronTime.source).toBe(cron);
      expect(job?.cronTime.timeZone).toBe('UTC');
    }
  });

  it('the application module itself imports the scheduler (without it no job would ever run)', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as {
      module?: unknown;
    }[];
    expect(imports.some((i) => i.module === ScheduleModule)).toBe(true);
  });

  it('the times are distinct and inside the quiet hours', () => {
    const times = Object.values(JOB_SCHEDULE).map((j) => j.cron);
    expect(new Set(times).size).toBe(times.length);
    for (const cron of times) expect(cron).toMatch(/^0 \d0 3 \* \* \*$/);
  });
});

describe('drift: the channel reconcile sweeper', () => {
  async function drifted() {
    const owner = await createTeacher(pool);
    const student = await createUser(pool);
    const removed = await createUser(pool);
    const courseId = await createPublishedCourse(pool);
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    const channel = await createChannel(pool, courseId);
    await addMember(pool, channel, owner.id);
    await createEnrollment(pool, courseId, student.id); // ACTIVE but NOT a member: missing
    await createEnrollment(pool, courseId, removed.id, { status: 'REMOVED' });
    await addMember(pool, channel, removed.id); // REMOVED but still a member: stale
    return { channel, student, removed };
  }
  const memberRows = async (channel: string) =>
    (
      await pool.query<{ user_id: string; left_at: Date | null }>(
        'SELECT user_id, left_at FROM conversation_members WHERE conversation_id = $1',
        [channel],
      )
    ).rows;

  it('repairs a missing member and a stale member, logs the repair, and a second run changes nothing and logs nothing', async () => {
    const { channel, student, removed } = await drifted();
    const job = app.get(ChannelReconcileJob);
    const first = await run(() => job.run());
    expect(first.result).toMatchObject({ added: 1, removed: 1 });
    expect(first.output).toContain('channel_reconcile_repaired');
    const rows = await memberRows(channel);
    expect(rows.find((r) => r.user_id === student.id)?.left_at).toBeNull();
    expect(rows.find((r) => r.user_id === removed.id)?.left_at).not.toBeNull();
    const before = JSON.stringify(rows);

    const second = await run(() => job.run());
    expect(second.result).toMatchObject({ added: 0, removed: 0 });
    expect(second.output).not.toContain('channel_reconcile_repaired');
    expect(JSON.stringify(await memberRows(channel))).toBe(before);
  });
});

describe('drift: the completion recheck sweeper', () => {
  it('completes an enrollment whose lessons are all done, logs the repair, and a second run changes nothing and logs nothing', async () => {
    const owner = await createTeacher(pool);
    const student = await createUser(pool);
    const courseId = await createPublishedCourse(pool);
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    const section = await createSection(pool, courseId);
    const lesson = await createLesson(pool, courseId, section, {
      status: 'PUBLISHED',
    });
    const enrollment = await createEnrollment(pool, courseId, student.id);
    await createCompletion(pool, enrollment, lesson, courseId); // all done, but completed_at was never set
    const completedAt = async () =>
      (
        await pool.query<{ completed_at: Date | null }>(
          'SELECT completed_at FROM enrollments WHERE id = $1',
          [enrollment],
        )
      ).rows[0].completed_at;
    expect(await completedAt()).toBeNull();

    const job = app.get(CompletionRecheckJob);
    const first = await run(() => job.run());
    expect(first.result).toMatchObject({ enrollmentsCompleted: 1 });
    expect(first.output).toContain('completion_recheck_repaired');
    const stamp = await completedAt();
    expect(stamp).not.toBeNull();

    const second = await run(() => job.run());
    expect(second.result).toMatchObject({ enrollmentsCompleted: 0 });
    expect(second.output).not.toContain('completion_recheck_repaired');
    expect(await completedAt()).toEqual(stamp);
  });
});

describe('the cleanup jobs', () => {
  it('Auth: removes tokens that expired more than a day ago, keeps the others, and is a no-op the second time', async () => {
    const user = await createUser(pool);
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    await createRefreshToken(pool, user.id, {
      familyStartedAt: old,
      expiresAt: old,
    });
    await createRefreshToken(pool, user.id); // alive
    await pool.query(
      `INSERT INTO email_tokens (user_id, type, token_hash, expires_at) VALUES
         ($1, 'EMAIL_VERIFICATION', 'expired-hash', now() - interval '3 days'),
         ($1, 'PASSWORD_RESET', 'alive-hash', now() + interval '1 hour')`,
      [user.id],
    );
    const job = app.get(AuthCleanupJob);
    expect(await job.run()).toEqual({ refreshTokens: 1, emailTokens: 1 });
    expect((await pool.query('SELECT 1 FROM refresh_tokens')).rowCount).toBe(1);
    expect((await pool.query('SELECT 1 FROM email_tokens')).rowCount).toBe(1);
    expect(await job.run()).toEqual({ refreshTokens: 0, emailTokens: 0 });
  });

  it('Files: deletes an unreferenced file after the grace period, keeps a recent and a referenced one', async () => {
    const user = await createUser(pool);
    const orphan = await createFile(pool, user.id);
    const recent = await createFile(pool, user.id);
    const avatar = await createFile(pool, user.id);
    await pool.query(
      "UPDATE file_assets SET created_at = now() - interval '2 days' WHERE id = ANY($1::uuid[])",
      [[orphan, avatar]],
    );
    await pool.query('UPDATE users SET avatar_file_id = $2 WHERE id = $1', [
      user.id,
      avatar,
    ]);
    const job = app.get(FileCleanupJob);
    expect(await job.run()).toMatchObject({ deleted: 1 });
    const left = (
      await pool.query<{ id: string }>('SELECT id FROM file_assets')
    ).rows.map((r) => r.id);
    expect(left.sort()).toEqual([recent, avatar].sort());
    expect(await job.run()).toMatchObject({ deleted: 0 });
  });

  it('Notifications: purges old READ notifications only; unread and recent ones stay', async () => {
    const user = await createUser(pool);
    const day = 24 * 3600 * 1000;
    const oldRead = await createNotification(pool, user.id, {
      readAt: new Date(Date.now() - 100 * day),
    });
    const oldUnread = await createNotification(pool, user.id);
    await pool.query(
      "UPDATE notifications SET created_at = now() - interval '200 days' WHERE id = $1",
      [oldUnread],
    );
    const recentRead = await createNotification(pool, user.id, {
      readAt: new Date(Date.now() - 5 * day),
    });
    const job = app.get(NotificationRetentionJob);
    expect(await job.run()).toBe(1);
    const left = (
      await pool.query<{ id: string }>('SELECT id FROM notifications')
    ).rows.map((r) => r.id);
    expect(left.sort()).toEqual([oldUnread, recentRead].sort());
    expect(left).not.toContain(oldRead);
    expect(await job.run()).toBe(0);
  });
});

describe('a failing job never escapes into the scheduler', () => {
  const cases: [
    string,
    () => { run: () => Promise<unknown> | undefined },
    () => object,
    string,
  ][] = [
    [
      'Auth cleanup',
      () => app.get(AuthCleanupJob),
      () => app.get(AuthCleanupService),
      'run',
    ],
    [
      'file cleanup',
      () => app.get(FileCleanupJob),
      () => app.get(FileCleanupService),
      'run',
    ],
    [
      'notification retention',
      () => app.get(NotificationRetentionJob),
      () => app.get(NotificationRetention),
      'purgeOldRead',
    ],
    [
      'channel reconcile',
      () => app.get(ChannelReconcileJob),
      () => app.get(CourseChannelService),
      'reconcileAll',
    ],
    [
      'completion recheck',
      () => app.get(CompletionRecheckJob),
      () => app.get(CompletionService),
      'recheckAllCourses',
    ],
  ];
  it.each(cases)(
    '%s: the error is logged by name, the job resolves, and the next run works',
    async (_name, job, service, method) => {
      const target = service() as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      const spy = jest
        .spyOn(target, method)
        .mockRejectedValueOnce(new RangeError('private details'));
      const failed = await run(() => job().run() as Promise<unknown>);
      expect(failed.result).toBeUndefined();
      expect(failed.output).toContain('job_failed');
      expect(failed.output).toContain('RangeError');
      expect(failed.output).not.toContain('private details');
      spy.mockRestore();
      const next = await run(() => job().run() as Promise<unknown>);
      expect(next.output).not.toContain('job_failed');
      expect(next.result).toBeDefined();
    },
  );
});
