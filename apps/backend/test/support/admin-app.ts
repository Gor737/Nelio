// The app for the M12 (Admin) integration tests: the real Admin module with every module it uses, the real guards, filter and pipe, the real
// database. Only the mail transport is a recorder. Events are collected from the real bus so tests can see what was announced after commit.
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import {
  EVENT_NAMES,
  type EventName,
} from '../../src/infrastructure/events/index.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import { DatabaseModule } from '../../src/infrastructure/database/index.js';
import {
  EventBus,
  EventsModule,
} from '../../src/infrastructure/events/index.js';
import { MailService } from '../../src/infrastructure/mail/index.js';
import { AdminModule } from '../../src/modules/admin/index.js';
import { AuthModule } from '../../src/modules/auth/index.js';
import { ChatModule } from '../../src/modules/chat/index.js';
import { ContentModule } from '../../src/modules/content/index.js';
import { CoursesModule } from '../../src/modules/courses/index.js';
import { EnrollmentsModule } from '../../src/modules/enrollments/index.js';
import { ProgressModule } from '../../src/modules/progress/index.js';
import { bearer, testEnv } from './integration-app.js';

export interface RecordedEvent {
  readonly name: EventName;
  readonly payload: Record<string, unknown>;
}

export interface AdminTestApp {
  readonly app: NestExpressApplication;
  /** The port, when the app listens (`listen: true`), for a Socket.IO client. */
  readonly port: number;
  readonly events: RecordedEvent[];
  /** An HTTP call as `userId` (or anonymous), each from its own client address so the throttle never interferes. */
  readonly call: (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    userId?: string,
    body?: object,
  ) => request.Test;
  readonly eventsOf: (name: EventName) => RecordedEvent[];
}

const fakeMail = {
  sendEmailVerification: () => Promise.resolve(true),
  sendPasswordReset: () => Promise.resolve(true),
  sendAlreadyRegistered: () => Promise.resolve(true),
};

export async function createAdminApp(
  options: { listen?: boolean } = {},
): Promise<AdminTestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      AuthModule,
      CoursesModule,
      ContentModule,
      EnrollmentsModule,
      ProgressModule,
      ChatModule,
      AdminModule,
    ],
    providers: GLOBAL_PROVIDERS,
  })
    .overrideProvider(MailService)
    .useValue(fakeMail)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  let port = 0;
  if (options.listen) {
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  } else await app.init();

  const events: RecordedEvent[] = [];
  const bus = app.get(EventBus);
  for (const name of EVENT_NAMES)
    bus.on(name, (payload) => {
      events.push({ name, payload: payload as Record<string, unknown> });
    });

  let counter = 0;
  const call: AdminTestApp['call'] = (method, path, userId, body) => {
    const n = counter++;
    const r = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('X-Forwarded-For', `10.13.${(n >> 8) & 255}.${n & 255}`);
    if (userId) r.set('Authorization', bearer(userId));
    return body === undefined ? r : r.send(body);
  };
  return {
    app,
    port,
    events,
    call,
    eventsOf: (name) => events.filter((e) => e.name === name),
  };
}
