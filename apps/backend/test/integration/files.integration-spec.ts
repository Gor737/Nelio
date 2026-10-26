// M9a: the Files module over HTTP against the real database, with an in-memory storage double (the real S3 driver is tested in
// files-s3.integration-spec.ts). Docs: architecture section 16, Decisions 64, 116, 127, 167.
import { jest } from '@jest/globals';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.setup.js';
import { AuthCoreModule } from '../../src/common/auth-core.module.js';
import { FILE_LIMITS } from '../../src/common/constants/limits.js';
import { GLOBAL_PROVIDERS } from '../../src/common/global-providers.js';
import { AppConfigModule } from '../../src/infrastructure/config/index.js';
import {
  DatabaseModule,
  PrismaService,
} from '../../src/infrastructure/database/index.js';
import { EventsModule } from '../../src/infrastructure/events/index.js';
import { FileCleanupService } from '../../src/modules/files/services/file-cleanup.service.js';
import { STORAGE_KEY_PATTERN } from '../../src/modules/files/services/file-names.js';
import { FilesService } from '../../src/modules/files/services/files.service.js';
import { StorageDriver } from '../../src/modules/files/storage/storage-driver.js';
import { FilesModule } from '../../src/modules/files/index.js';
import { createPool, resetData } from '../support/database.js';
import {
  createTeacher,
  createUser,
  createUserWithRoles,
} from '../support/factories.js';
import { createCourse } from '../support/factories-courses.js';
import { createBlock, createCourseTree } from '../support/factories-content.js';
import {
  InMemoryStorage,
  SAMPLE,
  multipart,
} from '../support/in-memory-storage.js';
import { bearer, closeApp, testEnv } from '../support/integration-app.js';

const MB = 1024 * 1024;
const pool = createPool();
const storage = new InMemoryStorage();
let app: NestExpressApplication;
let prisma: PrismaService;
let files: FilesService;
let cleanup: FileCleanupService;

async function createApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppConfigModule.forRoot(testEnv({ TRUST_PROXY: '1' })),
      EventsModule,
      DatabaseModule,
      AuthCoreModule,
      FilesModule,
    ],
    providers: GLOBAL_PROVIDERS,
  })
    .overrideProvider(StorageDriver)
    .useValue(storage)
    .compile();
  const created = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(created);
  await created.init();
  return created;
}

beforeAll(async () => {
  app = await createApp();
  prisma = app.get(PrismaService);
  files = app.get(FilesService);
  cleanup = app.get(FileCleanupService);
});
afterAll(async () => {
  await closeApp(app);
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  storage.reset();
});

let clientCounter = 0;
/** Each upload comes from its own client address (one trusted proxy hop), so the TIGHT per-IP counter does not couple unrelated tests. */
const nextClientIp = () =>
  `10.${(clientCounter >> 16) & 255}.${(clientCounter >> 8) & 255}.${clientCounter++ & 255}`;
const upload = (
  userId: string,
  kind: string,
  data: Buffer,
  filename = 'file.bin',
  contentType?: string,
  clientIp = nextClientIp(),
) =>
  request(app.getHttpServer())
    .post('/api/v1/files')
    .set('Authorization', bearer(userId))
    .set('X-Forwarded-For', clientIp)
    .field('kind', kind)
    .attach('file', data, {
      filename,
      ...(contentType ? { contentType } : {}),
    });
const rowCount = async () =>
  (await pool.query('SELECT 1 FROM file_assets')).rowCount;

describe('POST /files: who may upload what', () => {
  it('any user uploads an AVATAR: 201, a public URL, the detected type, and nothing internal in the response', async () => {
    const user = await createUser(pool);
    const res = await upload(
      user.id,
      'AVATAR',
      SAMPLE.png(),
      'me.png',
      'image/png',
    ).expect(201);
    expect(Object.keys(res.body).sort()).toEqual([
      'createdAt',
      'id',
      'kind',
      'mimeType',
      'originalName',
      'sizeBytes',
      'url',
    ]);
    expect(res.body).toMatchObject({
      kind: 'AVATAR',
      originalName: 'me.png',
      mimeType: 'image/png',
      sizeBytes: 64,
    });
    expect(res.body.url).toMatch(
      /^https:\/\/public\.test\/public\/avatars\/[0-9a-f-]{36}\.png$/,
    );

    const { rows } = await pool.query(
      'SELECT * FROM file_assets WHERE id = $1',
      [res.body.id],
    );
    expect(rows[0]).toMatchObject({
      uploaded_by: user.id,
      kind: 'AVATAR',
      mime_type: 'image/png',
      original_name: 'me.png',
    });
    expect(Number(rows[0].size_bytes)).toBe(64);
    expect(rows[0].storage_key).toMatch(STORAGE_KEY_PATTERN);
    expect(storage.objects.get(rows[0].storage_key)).toMatchObject({
      contentType: 'image/png',
    });
    expect(res.body).not.toHaveProperty('storageKey');
    expect(res.body).not.toHaveProperty('uploadedBy');
  });

  it('an ACTIVE Teacher uploads a COURSE_COVER (public URL) and a LESSON_ATTACHMENT (no URL: only signed downloads)', async () => {
    const teacher = await createTeacher(pool);
    const cover = await upload(
      teacher.id,
      'COURSE_COVER',
      SAMPLE.jpeg(),
      'cover.jpg',
    ).expect(201);
    expect(cover.body.url).toMatch(
      /^https:\/\/public\.test\/public\/covers\/.+\.jpg$/,
    );
    const attachment = await upload(
      teacher.id,
      'LESSON_ATTACHMENT',
      SAMPLE.pdf(),
      'syllabus.pdf',
    ).expect(201);
    expect(attachment.body.url).toBeNull();
    expect(JSON.stringify(attachment.body)).not.toContain(
      'private/attachments',
    );
    expect(attachment.body.mimeType).toBe('application/pdf');
    const { rows } = await pool.query(
      "SELECT storage_key FROM file_assets WHERE kind = 'LESSON_ATTACHMENT'",
    );
    expect(rows[0].storage_key).toMatch(/^private\/attachments\//);
  });

  it.each(['COURSE_COVER', 'LESSON_ATTACHMENT'])(
    'a non-Teacher cannot upload a %s: 403 TEACHER_NOT_APPROVED, and nothing is stored',
    async (kind) => {
      const student = await createUser(pool);
      const pending = await createUserWithRoles(pool, [
        { role: 'STUDENT', status: 'ACTIVE' },
        { role: 'TEACHER', status: 'PENDING' },
      ]);
      const revoked = await createUserWithRoles(pool, [
        { role: 'STUDENT', status: 'ACTIVE' },
        { role: 'TEACHER', status: 'REVOKED' },
      ]);
      for (const user of [student, pending, revoked]) {
        const res = await upload(user.id, kind, SAMPLE.png()).expect(403);
        expect(res.body).toMatchObject({
          statusCode: 403,
          code: 'TEACHER_NOT_APPROVED',
        });
      }
      expect(await rowCount()).toBe(0);
      expect(storage.objects.size).toBe(0);
    },
  );

  it('401 without a token', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/files')
      .field('kind', 'AVATAR')
      .attach('file', SAMPLE.png(), 'a.png')
      .expect(401);
  });
});

describe('POST /files: 413 FILE_TOO_LARGE (per kind, on upload routes only)', () => {
  it.each([
    ['AVATAR', 'png', 2 * MB],
    ['COURSE_COVER', 'jpeg', 5 * MB],
  ] as const)(
    '%s: exactly the limit is accepted, one byte more is 413',
    async (kind, type, limit) => {
      const teacher = await createTeacher(pool);
      expect(FILE_LIMITS[kind].maxBytes).toBe(limit);
      await upload(teacher.id, kind, SAMPLE[type](limit), 'at-limit').expect(
        201,
      );
      const res = await upload(
        teacher.id,
        kind,
        SAMPLE[type](limit + 1),
        'over',
      ).expect(413);
      expect(res.body).toMatchObject({
        statusCode: 413,
        code: 'FILE_TOO_LARGE',
      });
      expect(await rowCount()).toBe(1);
      expect(storage.objects.size).toBe(1);
    },
  );

  it('a file that is fine as a cover is too large as an avatar (the limit is the kind`s, not one global number)', async () => {
    const teacher = await createTeacher(pool);
    const sixMb = SAMPLE.png(3 * MB);
    expect(
      (await upload(teacher.id, 'AVATAR', sixMb).expect(413)).body.code,
    ).toBe('FILE_TOO_LARGE');
    await upload(teacher.id, 'COURSE_COVER', sixMb).expect(201);
  });

  it('LESSON_ATTACHMENT: 25 MB is accepted and 25 MB + 1 byte is 413 (the multipart parser stops at the largest limit)', async () => {
    const teacher = await createTeacher(pool);
    await upload(teacher.id, 'LESSON_ATTACHMENT', SAMPLE.pdf(25 * MB)).expect(
      201,
    );
    const res = await upload(
      teacher.id,
      'LESSON_ATTACHMENT',
      SAMPLE.pdf(25 * MB + 1),
    ).expect(413);
    expect(res.body).toMatchObject({ statusCode: 413, code: 'FILE_TOO_LARGE' });
  }, 60_000);

  it('413 is decided before the Teacher check is irrelevant: a student over the limit for a cover still gets 403 (the kind is checked first)', async () => {
    const student = await createUser(pool);
    expect(
      (await upload(student.id, 'COURSE_COVER', SAMPLE.png(6 * MB)).expect(403))
        .body.code,
    ).toBe('TEACHER_NOT_APPROVED');
  });

  it('on a JSON route an oversized body is 400, not 413 (Decision 167): the 413 code belongs to uploads', async () => {
    const user = await createUser(pool);
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/files/${'0'.repeat(8)}-0000-0000-0000-000000000000`)
      .set('Authorization', bearer(user.id))
      .send({ pad: 'x'.repeat(300_000) });
    expect([400, 404]).toContain(res.status);
    expect(res.body.code).not.toBe('FILE_TOO_LARGE');
  });
});

describe('POST /files: 415 FILE_TYPE_NOT_ALLOWED (the real type, never the name or the claimed Content-Type)', () => {
  it.each([
    [
      'a Windows executable named .png',
      SAMPLE.exe(),
      'holiday.png',
      'image/png',
    ],
    ['an ELF binary named .pdf', SAMPLE.elf(), 'report.pdf', 'application/pdf'],
    ['a shell script named .txt', SAMPLE.script(), 'notes.txt', 'text/plain'],
    [
      'an executable that claims to be a zip',
      SAMPLE.exe(),
      'archive.zip',
      'application/zip',
    ],
  ])('every kind refuses %s', async (_label, data, filename, claimed) => {
    const teacher = await createTeacher(pool);
    for (const kind of ['AVATAR', 'COURSE_COVER', 'LESSON_ATTACHMENT']) {
      const res = await upload(
        teacher.id,
        kind,
        data,
        filename,
        claimed,
      ).expect(415);
      expect(res.body).toMatchObject({
        statusCode: 415,
        code: 'FILE_TYPE_NOT_ALLOWED',
      });
    }
    expect(await rowCount()).toBe(0);
    expect(storage.objects.size).toBe(0);
  });

  it('a type that is real but not allowed for the kind is 415: PDF, ZIP, text and SVG as an AVATAR; ZIP as a cover', async () => {
    const teacher = await createTeacher(pool);
    for (const [kind, data] of [
      ['AVATAR', SAMPLE.pdf()],
      ['AVATAR', SAMPLE.zip()],
      ['AVATAR', SAMPLE.text()],
      ['AVATAR', SAMPLE.svg()],
      ['COURSE_COVER', SAMPLE.zip()],
      ['COURSE_COVER', SAMPLE.pdf()],
    ] as const) {
      expect(
        (await upload(teacher.id, kind, data, 'x.png', 'image/png').expect(415))
          .body.code,
      ).toBe('FILE_TYPE_NOT_ALLOWED');
    }
  });

  it('unknown binary content (a GIF, random bytes) and an unlisted type are 415', async () => {
    const teacher = await createTeacher(pool);
    for (const data of [SAMPLE.gif(), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])])
      expect(
        (
          await upload(
            teacher.id,
            'LESSON_ATTACHMENT',
            data,
            'a.pdf',
            'application/pdf',
          ).expect(415)
        ).body.code,
      ).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('the answer does not say what the file was detected as', async () => {
    const teacher = await createTeacher(pool);
    const res = await upload(
      teacher.id,
      'AVATAR',
      SAMPLE.exe(),
      'a.png',
    ).expect(415);
    expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(
      /executable|windows|\belf\b|\bmz\b|\bpe\b|binary/,
    );
  });

  it('a lying extension is harmless in the other direction too: a PDF named .png is stored as a PDF, and an image claimed as an executable is an image', async () => {
    const teacher = await createTeacher(pool);
    const pdf = await upload(
      teacher.id,
      'LESSON_ATTACHMENT',
      SAMPLE.pdf(),
      'looks-like-an-image.png',
      'image/png',
    ).expect(201);
    expect(pdf.body.mimeType).toBe('application/pdf');
    expect(pdf.body.originalName).toBe('looks-like-an-image.png');
    const png = await upload(
      teacher.id,
      'AVATAR',
      SAMPLE.png(),
      'setup.exe',
      'application/x-msdownload',
    ).expect(201);
    expect(png.body.mimeType).toBe('image/png');
    const { rows } = await pool.query(
      'SELECT storage_key FROM file_assets WHERE id = $1',
      [png.body.id],
    );
    expect(rows[0].storage_key.endsWith('.png')).toBe(true); // the extension of the key follows the detected type, not "setup.exe"
  });

  it('plain text, ZIP, PDF, JPEG, PNG and WebP are accepted as attachments; text is stored as text/plain', async () => {
    const teacher = await createTeacher(pool);
    for (const [data, mime] of [
      [SAMPLE.pdf(), 'application/pdf'],
      [SAMPLE.jpeg(), 'image/jpeg'],
      [SAMPLE.png(), 'image/png'],
      [SAMPLE.webp(), 'image/webp'],
      [SAMPLE.zip(), 'application/zip'],
      [Buffer.from('Բարև Ձեզ\n'), 'text/plain'],
    ] as const)
      expect(
        (await upload(teacher.id, 'LESSON_ATTACHMENT', data, 'f').expect(201))
          .body.mimeType,
      ).toBe(mime);
  });
});

describe('POST /files: hostile file names cannot affect the key', () => {
  const send = (userId: string, filename: string) => {
    const { body, contentType } = multipart([
      { name: 'kind', value: 'AVATAR' },
      { name: 'file', filename, contentType: 'image/png', data: SAMPLE.png() },
    ]);
    return request(app.getHttpServer())
      .post('/api/v1/files')
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', nextClientIp())
      .set('Content-Type', contentType)
      .send(body);
  };
  const keyHasNone = (fragments: string[]) => {
    const keys = [...storage.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(STORAGE_KEY_PATTERN);
    for (const fragment of fragments) expect(keys[0]).not.toContain(fragment);
  };

  it.each([
    ['../../../etc/passwd', 'passwd', ['passwd', 'etc', '..']],
    ['..\\..\\windows\\system32\\config\\sam', 'sam', ['sam', 'windows', '..']],
    ['/etc/cron.d/evil', 'evil', ['evil', 'cron', 'etc']],
    ['a\u202egnp.exe', 'agnp.exe', ['exe', 'gnp']],
    ['Բարև Ձեզ.png', 'Բարև Ձեզ.png', ['Բ', 'Ձ']],
  ])(
    '%j is stored as the display name %j and the key has none of it',
    async (filename, expectedName, fragments) => {
      const user = await createUser(pool);
      const res = await send(user.id, filename).expect(201);
      expect(res.body.originalName).toBe(expectedName);
      keyHasNone(fragments);
    },
  );

  it('a 400-character name is cut to 255 characters and the key is unaffected', async () => {
    const user = await createUser(pool);
    const res = await send(user.id, `${'x'.repeat(400)}.png`).expect(201);
    expect(res.body.originalName).toBe('x'.repeat(255));
    keyHasNone(['xxxxx']);
  });

  it('a NUL byte inside the header is either refused by the parser (400) or stored as a space: never a path, never a stored name with a NUL', async () => {
    const user = await createUser(pool);
    const res = await send(user.id, 'photo.png\u0000.exe');
    expect([201, 400]).toContain(res.status);
    if (res.status === 201) {
      expect(res.body.originalName).toBe('photo.png .exe');
      keyHasNone(['exe', 'photo']);
    } else {
      expect(await rowCount()).toBe(0);
      expect(storage.objects.size).toBe(0);
    }
    const names = (
      await pool.query<{ original_name: string }>(
        'SELECT original_name FROM file_assets',
      )
    ).rows.map((r) => r.original_name);
    for (const name of names) expect(name).not.toContain('\u0000');
  });
});

describe('POST /files: malformed requests are 400 VALIDATION_FAILED', () => {
  const post = (userId: string) =>
    request(app.getHttpServer())
      .post('/api/v1/files')
      .set('Authorization', bearer(userId))
      .set('X-Forwarded-For', nextClientIp());

  it('no file, an empty file, no kind, an unknown kind, an extra field, two files, or a wrongly named part', async () => {
    const user = await createUser(pool);
    const expectInvalid = async (promise: Promise<request.Response>) => {
      const res = await promise;
      expect([res.status, res.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    };
    await expectInvalid(Promise.resolve(post(user.id).field('kind', 'AVATAR')));
    await expectInvalid(
      Promise.resolve(
        post(user.id)
          .field('kind', 'AVATAR')
          .attach('file', Buffer.alloc(0), 'empty.png'),
      ),
    );
    await expectInvalid(
      Promise.resolve(post(user.id).attach('file', SAMPLE.png(), 'a.png')),
    );
    await expectInvalid(
      Promise.resolve(
        post(user.id)
          .field('kind', 'BANNER')
          .attach('file', SAMPLE.png(), 'a.png'),
      ),
    );
    await expectInvalid(
      Promise.resolve(
        post(user.id)
          .field('kind', 'AVATAR')
          .field('role', 'ADMIN')
          .attach('file', SAMPLE.png(), 'a.png'),
      ),
    );
    await expectInvalid(
      Promise.resolve(
        post(user.id)
          .field('kind', 'AVATAR')
          .attach('file', SAMPLE.png(), 'a.png')
          .attach('file', SAMPLE.png(), 'b.png'),
      ),
    );
    await expectInvalid(
      Promise.resolve(
        post(user.id)
          .field('kind', 'AVATAR')
          .attach('upload', SAMPLE.png(), 'a.png'),
      ),
    );
    expect(await rowCount()).toBe(0);
  });

  it('a JSON body instead of multipart is 400', async () => {
    const user = await createUser(pool);
    expect(
      (await post(user.id).send({ kind: 'AVATAR' }).expect(400)).body.code,
    ).toBe('VALIDATION_FAILED');
  });
});

describe('order of effects: storage first, then metadata', () => {
  it('a storage failure leaves no row and answers 503', async () => {
    const user = await createUser(pool);
    storage.failPut = true;
    const res = await upload(user.id, 'AVATAR', SAMPLE.png()).expect(503);
    expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(await rowCount()).toBe(0);
  });

  it('a database failure after the object was written removes the object again (best effort) and answers 500', async () => {
    const user = await createUser(pool);
    const create = jest
      .spyOn(prisma.fileAsset, 'create')
      .mockRejectedValueOnce(new Error('database exploded'));
    try {
      await upload(user.id, 'AVATAR', SAMPLE.png()).expect(500);
    } finally {
      create.mockRestore();
    }
    expect(storage.calls.map((c) => c.split(' ')[0])).toEqual([
      'put',
      'delete',
    ]);
    expect(storage.objects.size).toBe(0);
    expect(await rowCount()).toBe(0);
  });
});

describe('DELETE /files/:id', () => {
  it('deletes an own unattached file: 204, the row first and then the object', async () => {
    const user = await createUser(pool);
    const id = (await upload(user.id, 'AVATAR', SAMPLE.png()).expect(201)).body
      .id;
    storage.calls.length = 0;
    await request(app.getHttpServer())
      .delete(`/api/v1/files/${id}`)
      .set('Authorization', bearer(user.id))
      .expect(204);
    expect(await rowCount()).toBe(0);
    expect(storage.objects.size).toBe(0);
    expect(storage.calls).toHaveLength(1);
    expect(storage.calls[0]).toMatch(/^delete public\/avatars\//);
  });

  it('the row is gone even when the object cannot be removed (an unreferenced object is harmless): still 204', async () => {
    const user = await createUser(pool);
    const id = (await upload(user.id, 'AVATAR', SAMPLE.png()).expect(201)).body
      .id;
    storage.failDelete = true;
    await request(app.getHttpServer())
      .delete(`/api/v1/files/${id}`)
      .set('Authorization', bearer(user.id))
      .expect(204);
    expect(await rowCount()).toBe(0);
    expect(storage.objects.size).toBe(1);
  });

  it("somebody else's file and a missing file are both 404 (existence is not revealed); a malformed id is 400; no token is 401", async () => {
    const [owner, other] = [await createUser(pool), await createUser(pool)];
    const id = (await upload(owner.id, 'AVATAR', SAMPLE.png()).expect(201)).body
      .id;
    const del = (userId: string, target: string) =>
      request(app.getHttpServer())
        .delete(`/api/v1/files/${target}`)
        .set('Authorization', bearer(userId));
    expect((await del(other.id, id).expect(404)).body.code).toBe('NOT_FOUND');
    expect(
      (await del(other.id, '018f0000-0000-7000-8000-000000000001').expect(404))
        .body,
    ).toEqual((await del(other.id, id).expect(404)).body);
    expect((await del(owner.id, 'not-a-uuid').expect(400)).body.code).toBe(
      'VALIDATION_FAILED',
    );
    await request(app.getHttpServer())
      .delete(`/api/v1/files/${id}`)
      .expect(401);
    expect(await rowCount()).toBe(1);
  });

  it('a file that is an avatar, a cover or a block attachment is 409 FILE_IN_USE and stays; it can be deleted after it is detached', async () => {
    const teacher = await createTeacher(pool);
    const [avatar, cover, attachment] = [
      (await upload(teacher.id, 'AVATAR', SAMPLE.png()).expect(201)).body
        .id as string,
      (await upload(teacher.id, 'COURSE_COVER', SAMPLE.png()).expect(201)).body
        .id as string,
      (await upload(teacher.id, 'LESSON_ATTACHMENT', SAMPLE.pdf()).expect(201))
        .body.id as string,
    ];
    await pool.query('UPDATE users SET avatar_file_id = $1 WHERE id = $2', [
      avatar,
      teacher.id,
    ]);
    const courseId = await createCourse(pool, { coverFileId: cover });
    const { lessonId } = await createCourseTree(pool, async () => courseId);
    await createBlock(pool, lessonId, { type: 'FILE', fileId: attachment });

    const del = (id: string) =>
      request(app.getHttpServer())
        .delete(`/api/v1/files/${id}`)
        .set('Authorization', bearer(teacher.id));
    for (const id of [avatar, cover, attachment]) {
      const res = await del(id).expect(409);
      expect(res.body).toMatchObject({ statusCode: 409, code: 'FILE_IN_USE' });
    }
    expect(await rowCount()).toBe(3);
    expect(storage.objects.size).toBe(3); // nothing was removed from storage either

    await pool.query('UPDATE users SET avatar_file_id = NULL WHERE id = $1', [
      teacher.id,
    ]);
    await del(avatar).expect(204);
    expect(await rowCount()).toBe(2);
  });
});

describe('FilesService: signed downloads and public URLs', () => {
  it('an attachment gets a 5-minute signed URL with the original name as the download name; the expiry is reported', async () => {
    const teacher = await createTeacher(pool);
    const id = (
      await upload(
        teacher.id,
        'LESSON_ATTACHMENT',
        SAMPLE.pdf(),
        'Course notes.pdf',
      ).expect(201)
    ).body.id;
    const before = Date.now();
    const signed = await files.signedDownload(id);
    expect(signed.url).toMatch(
      /^https:\/\/signed\.test\/private\/attachments\/.+\.pdf\?ttl=300$/,
    );
    expect(new Date(signed.expiresAt).getTime()).toBeGreaterThanOrEqual(
      before + 300_000 - 1000,
    );
    expect(new Date(signed.expiresAt).getTime()).toBeLessThanOrEqual(
      Date.now() + 300_000,
    );
    expect(storage.signed[0].options).toMatchObject({
      expiresInSeconds: 300,
      downloadName: 'Course notes.pdf',
      contentType: 'application/pdf',
    });
  });

  it('an avatar, a cover or an unknown id cannot be "downloaded" this way: NOT_FOUND', async () => {
    const teacher = await createTeacher(pool);
    const avatar = (
      await upload(teacher.id, 'AVATAR', SAMPLE.png()).expect(201)
    ).body.id;
    await expect(files.signedDownload(avatar)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      files.signedDownload('018f0000-0000-7000-8000-000000000001'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('orphan cleanup (files older than 24 h that nothing references)', () => {
  /** A stored file whose row is made `hoursOld` hours old. */
  async function storedFile(
    userId: string,
    hoursOld: number,
    kind: 'AVATAR' | 'COURSE_COVER' | 'LESSON_ATTACHMENT' = 'AVATAR',
  ) {
    const owner = kind === 'AVATAR' ? userId : (await createTeacher(pool)).id;
    const body = (
      await upload(
        owner,
        kind,
        kind === 'LESSON_ATTACHMENT' ? SAMPLE.pdf() : SAMPLE.png(),
      ).expect(201)
    ).body;
    await pool.query(
      'UPDATE file_assets SET created_at = now() - make_interval(hours => $1) WHERE id = $2',
      [hoursOld, body.id],
    );
    const { rows } = await pool.query(
      'SELECT storage_key FROM file_assets WHERE id = $1',
      [body.id],
    );
    return { id: body.id as string, key: rows[0].storage_key as string };
  }

  it('deletes old unreferenced files and their objects; leaves recent ones; a second run changes nothing', async () => {
    const user = await createUser(pool);
    const old = await storedFile(user.id, 30);
    const recent = await storedFile(user.id, 23);
    const result = await cleanup.run();
    expect(result).toEqual({ deleted: 1, skippedInUse: 0, storageFailures: 0 });
    const left = (
      await pool.query<{ id: string }>('SELECT id FROM file_assets')
    ).rows.map((r) => r.id);
    expect(left).toEqual([recent.id]);
    expect(storage.objects.has(old.key)).toBe(false);
    expect(storage.objects.has(recent.key)).toBe(true);
    expect(await cleanup.run()).toEqual({
      deleted: 0,
      skippedInUse: 0,
      storageFailures: 0,
    });
  });

  it('never deletes a file that is an avatar, a cover or a block attachment, however old', async () => {
    const teacher = await createTeacher(pool);
    const [avatar, cover, attachment, orphan] = [
      await storedFile(teacher.id, 100, 'AVATAR'),
      await storedFile(teacher.id, 100, 'COURSE_COVER'),
      await storedFile(teacher.id, 100, 'LESSON_ATTACHMENT'),
      await storedFile(teacher.id, 100, 'AVATAR'),
    ];
    await pool.query('UPDATE users SET avatar_file_id = $1 WHERE id = $2', [
      avatar.id,
      teacher.id,
    ]);
    const courseId = await createCourse(pool, { coverFileId: cover.id });
    const { lessonId } = await createCourseTree(pool, async () => courseId);
    await createBlock(pool, lessonId, { type: 'FILE', fileId: attachment.id });

    expect(await cleanup.run()).toMatchObject({ deleted: 1 });
    const left = new Set(
      (await pool.query<{ id: string }>('SELECT id FROM file_assets')).rows.map(
        (r) => r.id,
      ),
    );
    expect(left).toEqual(new Set([avatar.id, cover.id, attachment.id]));
    expect(left.has(orphan.id)).toBe(false);
    for (const kept of [avatar, cover, attachment])
      expect(storage.objects.has(kept.key)).toBe(true);
  });

  it('handles more than one batch (250 old orphans)', async () => {
    const user = await createUser(pool);
    await pool.query(
      `INSERT INTO file_assets (uploaded_by, kind, storage_key, original_name, mime_type, size_bytes, created_at)
       SELECT $1, 'AVATAR', 'public/avatars/bulk-' || g || '.png', 'a.png', 'image/png', 10, now() - interval '3 days'
         FROM generate_series(1, 250) g`,
      [user.id],
    );
    const result = await cleanup.run();
    expect(result.deleted).toBe(250);
    expect(await rowCount()).toBe(0);
  });

  it('a storage failure is counted but the row is already gone (row first, object second)', async () => {
    const user = await createUser(pool);
    await storedFile(user.id, 48);
    storage.failDelete = true;
    expect(await cleanup.run()).toEqual({
      deleted: 1,
      skippedInUse: 0,
      storageFailures: 1,
    });
    expect(await rowCount()).toBe(0);
  });

  it('loses cleanly to a concurrent attach: the DELETE waits for the attaching transaction, then the foreign key refuses it', async () => {
    const user = await createUser(pool);
    const file = await storedFile(user.id, 48);
    const attacher = await pool.connect();
    try {
      await attacher.query('BEGIN');
      await attacher.query(
        'UPDATE users SET avatar_file_id = $1 WHERE id = $2',
        [file.id, user.id],
      ); // not committed yet

      const running = cleanup.run(); // selects the file (it is still unreferenced), then its DELETE has to wait for the lock
      const deadline = Date.now() + 5000;
      for (;;) {
        const { rows } = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'DELETE FROM "public"."file_assets"%'`,
        );
        if (rows.length > 0) break;
        if (Date.now() > deadline)
          throw new Error(
            'the cleanup DELETE never started waiting for the attaching transaction',
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await attacher.query('COMMIT');

      const result = await running;
      expect(result).toEqual({
        deleted: 0,
        skippedInUse: 1,
        storageFailures: 0,
      });
    } finally {
      attacher.release(true);
    }
    const { rows } = await pool.query(
      'SELECT avatar_file_id FROM users WHERE id = $1',
      [user.id],
    );
    expect(rows[0].avatar_file_id).toBe(file.id);
    expect(await rowCount()).toBe(1);
    expect(storage.objects.has(file.key)).toBe(true);
  }, 20_000);
});

describe('rate limit', () => {
  it('uploads are in the TIGHT class: the 21st upload within a minute is 429', async () => {
    const fresh = await createApp();
    const fixedIp = '203.0.113.77';
    try {
      const user = await createUser(pool);
      const send = () =>
        request(fresh.getHttpServer())
          .post('/api/v1/files')
          .set('Authorization', bearer(user.id))
          .set('X-Forwarded-For', fixedIp)
          .field('kind', 'AVATAR')
          .attach('file', SAMPLE.png(), 'a.png');
      for (let i = 0; i < 20; i++) await send().expect(201);
      const res = await send().expect(429);
      expect(res.body.code).toBe('TOO_MANY_REQUESTS');
    } finally {
      await closeApp(fresh);
    }
  }, 30_000);
});
