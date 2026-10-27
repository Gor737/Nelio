// The whole application (every module, the real guards, filter, pipe and database) for the M13 conformance suites. Only the outside world is
// replaced: the mail transport by a recorder and the object store by memory. Events are collected from the real bus.
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import { AuditModule } from '../../src/infrastructure/audit/index.js';
import { DatabaseModule } from '../../src/infrastructure/database/index.js';
import { EventsModule } from '../../src/infrastructure/events/index.js';
import {
  MailModule,
  MailService,
} from '../../src/infrastructure/mail/index.js';
import { RealtimeModule } from '../../src/infrastructure/realtime/index.js';
import { AdminModule } from '../../src/modules/admin/index.js';
import { AuthModule } from '../../src/modules/auth/index.js';
import { CatalogModule } from '../../src/modules/catalog/index.js';
import { ChatModule } from '../../src/modules/chat/index.js';
import { ContentModule } from '../../src/modules/content/index.js';
import { CoursesModule } from '../../src/modules/courses/index.js';
import { EnrollmentsModule } from '../../src/modules/enrollments/index.js';
import { FilesModule } from '../../src/modules/files/index.js';
import { ModerationModule } from '../../src/modules/moderation/index.js';
import { NotificationsModule } from '../../src/modules/notifications/index.js';
import { ProgressModule } from '../../src/modules/progress/index.js';
import { UsersModule } from '../../src/modules/users/index.js';
import { StorageDriver } from '../../src/modules/files/storage/storage-driver.js';
import { InMemoryStorage } from './in-memory-storage.js';
import { bearer, testEnv } from './integration-app.js';

const fakeMail = {
  sendEmailVerification: () => Promise.resolve(true),
  sendPasswordReset: () => Promise.resolve(true),
  sendAlreadyRegistered: () => Promise.resolve(true),
};

export interface FullApp {
  readonly app: NestExpressApplication;
  readonly port: number;
  readonly storage: InMemoryStorage;
  /** A call from a fresh client address, so the global throttle never interferes unless a test wants it to. */
  readonly call: (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    options?: {
      userId?: string;
      body?: object;
      headers?: Record<string, string>;
      ip?: string;
    },
  ) => request.Test;
}

export async function createFullApp(
  extraEnv: Record<string, string> = {},
  options: { listen?: boolean } = {},
): Promise<FullApp> {
  const storage = new InMemoryStorage();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1', ...extraEnv })),
      DatabaseModule,
      AuthCoreModule,
      AuditModule,
      MailModule,
      EventsModule,
      RealtimeModule,
      FilesModule,
      CatalogModule,
      ProgressModule,
      ModerationModule,
      NotificationsModule,
      UsersModule,
      ContentModule,
      ChatModule,
      AuthModule,
      CoursesModule,
      EnrollmentsModule,
      AdminModule,
    ],
    providers: GLOBAL_PROVIDERS,
  })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .overrideProvider(StorageDriver)
    .useValue(storage)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  let port = 0;
  if (options.listen) {
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  } else await app.init();

  let counter = 0;
  const call: FullApp['call'] = (method, path, opts = {}) => {
    const n = counter++;
    const r = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('X-Forwarded-For', opts.ip ?? `10.20.${(n >> 8) & 255}.${n & 255}`);
    if (opts.userId) r.set('Authorization', bearer(opts.userId));
    for (const [name, value] of Object.entries(opts.headers ?? {}))
      r.set(name, value);
    return opts.body === undefined ? r : r.send(opts.body);
  };
  return { app, port, storage, call };
}
