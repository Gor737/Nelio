// Boots the real guard stack against the real test database: the real Authenticator and PrismaAuthUserLoader, the real
// CourseAccessService, every global guard in its production order, the real exception filter and pipe, plus the probe controllers.
// Nothing is faked, so these tests prove the SQL of the guards, not only their logic.
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import { DatabaseModule } from '../../src/infrastructure/database/index.js';
import { EventsModule } from '../../src/infrastructure/events/index.js';
import { ProbeModule } from './probe.module.js';
import { mintAccessToken } from './token-minter.js';
import { testDatabaseUrl } from './test-database.mjs';

export const TEST_JWT_SECRET =
  'integration-test-secret-with-more-than-thirty-two-bytes';

export const testEnv = (
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  DATABASE_URL: testDatabaseUrl(),
  JWT_SECRET: TEST_JWT_SECRET,
  FRONTEND_ORIGIN: 'http://localhost:3001',
  SWAGGER_ENABLED: 'false',
  ...extra,
});

export async function createGuardedApp(
  extraEnv: Record<string, string> = {},
): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv(extraEnv)),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      ProbeModule,
    ],
    providers: GLOBAL_PROVIDERS,
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return app;
}

export const bearer = (
  userId: string,
  options: Parameters<typeof mintAccessToken>[1] = {},
) =>
  `Bearer ${mintAccessToken(userId, { secret: TEST_JWT_SECRET, ...options })}`;

export const closeApp = (app: INestApplication | undefined) => app?.close();
