// The whole AppModule against the real nelio_test database: it boots, the health endpoint answers, the OpenAPI document is
// served, and a missing JWT_SECRET stops the application before it listens.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { testDatabaseUrl } from '../support/test-database.mjs';

let app: NestExpressApplication;
const saved = { ...process.env };

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    JWT_SECRET: 'test-secret-with-more-than-thirty-two-bytes-in-it',
    SWAGGER_ENABLED: 'true',
  });
  // AppModule reads process.env when it is imported, so it is imported only after the variables above are set.
  const { AppModule } = await import('../../src/app.module.js');
  const { configureApp } = await import('../../src/app.setup.js');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
});

afterAll(async () => {
  await app.close();
  process.env = saved;
});

describe('GET /health (unprefixed, Decision 167)', () => {
  it('answers 200 with the database up', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up' });
    expect(JSON.stringify(res.body)).not.toMatch(/postgres|password|secret/i);
  });

  it('is not served under the API prefix', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('OpenAPI contract', () => {
  it('documents the health endpoint at /health with its success and error responses', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    const operation = res.body.paths['/health'].get;
    expect(Object.keys(operation.responses).sort()).toEqual([
      '200',
      '429',
      '500',
      '503',
    ]);
    expect(
      operation.responses['503'].content['application/json'].schema.$ref,
    ).toMatch(/ErrorResponseDto$/);
  });
});

describe('startup refuses an invalid configuration', () => {
  it('fails to compile the module when JWT_SECRET is missing, naming the variable but not any value', async () => {
    const { AppConfigModule } =
      await import('../../src/infrastructure/config/index.js');
    await expect(
      Test.createTestingModule({
        imports: [
          AppConfigModule.forRoot({
            NODE_ENV: 'test',
            DATABASE_URL: testDatabaseUrl(),
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/JWT_SECRET/);
  });
});
