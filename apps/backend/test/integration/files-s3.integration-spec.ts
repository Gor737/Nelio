// M9a: the REAL S3 driver against a real S3-compatible server (signing, path-style addressing, public vs private objects, signed URLs,
// expiry). It runs only when S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are in the environment and the endpoint answers,
// and SKIPS ITSELF otherwise (CI has no object store). Its objects live under a random prefix inside the bucket and are deleted at the end.
//
// The bucket must exist and allow anonymous download of `public/*` only (that is how the public avatars and covers are served).
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import {
  AppConfigModule,
  loadConfig,
} from '../../src/infrastructure/config/index.js';
import { DatabaseModule } from '../../src/infrastructure/database/index.js';
import { EventsModule } from '../../src/infrastructure/events/index.js';
import { FilesService } from '../../src/modules/files/services/files.service.js';
import { S3StorageDriver } from '../../src/modules/files/storage/s3-storage.driver.js';
import { FilesModule } from '../../src/modules/files/index.js';
import { createPool, resetData } from '../support/database.js';
import { createTeacher } from '../support/factories.js';
import { SAMPLE } from '../support/in-memory-storage.js';
import { bearer, closeApp, testEnv } from '../support/integration-app.js';

const S3_KEYS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_PUBLIC_BASE_URL',
  'S3_FORCE_PATH_STYLE',
] as const;
const s3Env = Object.fromEntries(
  S3_KEYS.flatMap((key) =>
    process.env[key] ? [[key, process.env[key] as string]] : [],
  ),
);

async function storeIsReachable(): Promise<boolean> {
  if (
    !s3Env.S3_ENDPOINT ||
    !s3Env.S3_ACCESS_KEY_ID ||
    !s3Env.S3_SECRET_ACCESS_KEY
  )
    return false;
  try {
    await fetch(s3Env.S3_ENDPOINT, { signal: AbortSignal.timeout(3000) }); // any answer (even 403) means the server is there
    return true;
  } catch {
    return false;
  }
}

const available = await storeIsReachable();
const suite = available ? describe : describe.skip;
if (!available)
  console.warn(
    'files-s3.integration-spec: no S3-compatible store configured/reachable (S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY), skipped',
  );

suite('S3StorageDriver against a real S3-compatible store', () => {
  const config = () => loadConfig(testEnv(s3Env));
  const driver = new S3StorageDriver(config());
  const runId = randomUUID();
  const created: string[] = [];
  const publicKey = (name: string) => `public/avatars/m9-test-${runId}-${name}`;
  const privateKey = (name: string) =>
    `private/attachments/m9-test-${runId}-${name}`;
  const track = (key: string) => (created.push(key), key);

  afterAll(async () => {
    for (const key of created) await driver.delete(key).catch(() => undefined);
  });

  describe('public objects (anonymous read under public/)', () => {
    it('put makes the object readable at publicUrl with the stored type and a long cache lifetime', async () => {
      const key = track(publicKey('a.png'));
      const body = SAMPLE.png(2048);
      await driver.put(key, body, 'image/png');
      const res = await fetch(driver.publicUrl(key));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    });

    it('a public URL is a pure function of the key (no request is made) and the key is URL-encoded', () => {
      expect(driver.publicUrl('public/avatars/a b.png')).toBe(
        `${config().storage.publicBaseUrl}/public/avatars/a%20b.png`,
      );
    });
  });

  describe('private objects (attachments)', () => {
    it('are NOT readable anonymously, even though the bucket allows anonymous read of public/', async () => {
      const key = track(privateKey('secret.pdf'));
      await driver.put(key, SAMPLE.pdf(512), 'application/pdf');
      const anonymous = await fetch(`${config().storage.publicBaseUrl}/${key}`);
      expect(anonymous.status).toBeGreaterThanOrEqual(400);
      expect(anonymous.status).toBeLessThan(500);
    });

    it('are readable through a signed URL, which forces a download under the original name', async () => {
      const key = track(privateKey('notes.pdf'));
      const body = SAMPLE.pdf(1024);
      await driver.put(key, body, 'application/pdf');
      const url = await driver.signedGetUrl(key, {
        expiresInSeconds: 300,
        downloadName: 'Բարև notes.pdf',
        contentType: 'application/pdf',
      });
      expect(url).toContain('X-Amz-Signature=');
      expect(url).toContain('X-Amz-Expires=300');
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
      const disposition = res.headers.get('content-disposition') ?? '';
      expect(disposition).toContain('attachment;');
      expect(disposition).toContain(
        `filename*=UTF-8''${encodeURIComponent('Բարև')}%20notes.pdf`,
      );
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    });

    it('a signed URL stops working after it expires', async () => {
      const key = track(privateKey('short.pdf'));
      await driver.put(key, SAMPLE.pdf(128), 'application/pdf');
      const url = await driver.signedGetUrl(key, { expiresInSeconds: 1 });
      expect((await fetch(url)).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      expect((await fetch(url)).status).toBe(403);
    }, 15_000);

    it('a tampered signed URL is refused (another key, with the signature of the first)', async () => {
      const [one, two] = [
        track(privateKey('one.pdf')),
        track(privateKey('two.pdf')),
      ];
      await driver.put(one, SAMPLE.pdf(64), 'application/pdf');
      await driver.put(two, SAMPLE.pdf(64), 'application/pdf');
      const url = await driver.signedGetUrl(one, { expiresInSeconds: 300 });
      const forged = url
        .replace(
          encodeURIComponent('m9-test-' + runId + '-one.pdf'),
          'm9-test-' + runId + '-two.pdf',
        )
        .replace(`m9-test-${runId}-one.pdf`, `m9-test-${runId}-two.pdf`);
      expect((await fetch(forged)).status).toBe(403);
    });
  });

  describe('delete', () => {
    it('removes the object, and deleting a missing object is not an error', async () => {
      const key = publicKey('gone.png');
      await driver.put(key, SAMPLE.png(64), 'image/png');
      expect((await fetch(driver.publicUrl(key))).status).toBe(200);
      await driver.delete(key);
      expect((await fetch(driver.publicUrl(key))).status).toBe(404);
      await expect(driver.delete(key)).resolves.toBeUndefined();
      await expect(
        driver.delete(publicKey('never-existed.png')),
      ).resolves.toBeUndefined();
    });
  });

  describe('failures are 503 and reveal nothing', () => {
    const failing = (overrides: Record<string, string>) =>
      new S3StorageDriver(loadConfig(testEnv({ ...s3Env, ...overrides })));

    it('wrong credentials', async () => {
      const bad = failing({
        S3_ACCESS_KEY_ID: 'wrong',
        S3_SECRET_ACCESS_KEY: 'definitely-wrong-secret-value',
      });
      const error = await bad
        .put(publicKey('x.png'), SAMPLE.png(), 'image/png')
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
      expect(JSON.stringify(error)).not.toContain(
        'definitely-wrong-secret-value',
      );
      expect((error as Error).message).toBe(
        'File storage is temporarily unavailable',
      );
    });

    it('a bucket that does not exist', async () => {
      const missing = failing({
        S3_BUCKET: `no-such-bucket-${runId.slice(0, 8)}`,
      });
      await expect(
        missing.put(publicKey('x.png'), SAMPLE.png(), 'image/png'),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    });

    it('an endpoint nobody listens on', async () => {
      const dead = failing({
        S3_ENDPOINT: 'http://127.0.0.1:1',
        S3_PUBLIC_BASE_URL: 'http://127.0.0.1:1/x',
      });
      await expect(
        dead.put(publicKey('x.png'), SAMPLE.png(), 'image/png'),
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    }, 30_000);

    it('storage that is not configured at all (no credentials) is 503 "not configured", and the application still starts', async () => {
      const unconfigured = new S3StorageDriver(
        loadConfig(testEnv({ MINIO_ROOT_USER: '', MINIO_ROOT_PASSWORD: '' })),
      );
      expect(
        loadConfig(testEnv({ MINIO_ROOT_USER: '', MINIO_ROOT_PASSWORD: '' }))
          .storage.accessKeyId,
      ).toBeUndefined();
      const error = await unconfigured
        .put(publicKey('x.png'), SAMPLE.png(), 'image/png')
        .catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'File storage is not configured',
      });
    });
  });
});

suite('Files over HTTP with the real S3 driver', () => {
  const pool = createPool();
  let app: NestExpressApplication;
  let files: FilesService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(testEnv({ ...s3Env, TRUST_PROXY: '1' })),
        EventsModule,
        DatabaseModule,
        AuthCoreModule,
        FilesModule,
      ],
      providers: GLOBAL_PROVIDERS,
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    files = app.get(FilesService);
  });
  afterAll(async () => {
    await closeApp(app);
    await pool.end();
  });
  beforeEach(() => resetData(pool));

  const send = (userId: string, kind: string, data: Buffer, name: string) =>
    request(app.getHttpServer())
      .post('/api/v1/files')
      .set('Authorization', bearer(userId))
      .set(
        'X-Forwarded-For',
        `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      )
      .field('kind', kind)
      .attach('file', data, name);

  it('uploads an avatar that is then readable at its public URL, an attachment that is only readable through a signed URL, and delete removes the object', async () => {
    const teacher = await createTeacher(pool);
    const avatar = (
      await send(
        teacher.id,
        'COURSE_COVER',
        SAMPLE.jpeg(4096),
        'cover.jpg',
      ).expect(201)
    ).body;
    const publicRes = await fetch(avatar.url);
    expect(publicRes.status).toBe(200);
    expect(publicRes.headers.get('content-type')).toBe('image/jpeg');
    expect(
      Buffer.from(await publicRes.arrayBuffer()).equals(SAMPLE.jpeg(4096)),
    ).toBe(true);

    const attachment = (
      await send(
        teacher.id,
        'LESSON_ATTACHMENT',
        SAMPLE.pdf(2048),
        'handout.pdf',
      ).expect(201)
    ).body;
    expect(attachment.url).toBeNull();
    const signed = await files.signedDownload(attachment.id);
    const download = await fetch(signed.url);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain(
      'handout.pdf',
    );
    expect(
      Buffer.from(await download.arrayBuffer()).equals(SAMPLE.pdf(2048)),
    ).toBe(true);

    await request(app.getHttpServer())
      .delete(`/api/v1/files/${avatar.id}`)
      .set('Authorization', bearer(teacher.id))
      .expect(204);
    expect((await fetch(avatar.url)).status).toBe(404);
    await request(app.getHttpServer())
      .delete(`/api/v1/files/${attachment.id}`)
      .set('Authorization', bearer(teacher.id))
      .expect(204);
    expect((await fetch(signed.url)).status).toBe(404);
  });
});
