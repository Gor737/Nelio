// An in-memory StorageDriver for tests that exercise the Files module's behavior (limits, types, ordering, cleanup) without a store.
// The REAL S3 driver is tested against a real S3-compatible server in files-s3.integration-spec.ts.
import { ApiException } from '../../src/common/filters/index.js';
import {
  type SignedUrlOptions,
  StorageDriver,
} from '../../src/modules/files/storage/storage-driver.js';

export class InMemoryStorage extends StorageDriver {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly signed: { key: string; options: SignedUrlOptions }[] = [];
  readonly calls: string[] = [];
  failPut = false;
  failDelete = false;

  put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.calls.push(`put ${key}`);
    if (this.failPut)
      return Promise.reject(new ApiException('SERVICE_UNAVAILABLE'));
    this.objects.set(key, { body, contentType });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.calls.push(`delete ${key}`);
    if (this.failDelete)
      return Promise.reject(new ApiException('SERVICE_UNAVAILABLE'));
    this.objects.delete(key);
    return Promise.resolve();
  }

  signedGetUrl(key: string, options: SignedUrlOptions): Promise<string> {
    this.signed.push({ key, options });
    return Promise.resolve(
      `https://signed.test/${key}?ttl=${options.expiresInSeconds}`,
    );
  }

  publicUrl(key: string): string {
    return `https://public.test/${key}`;
  }

  reset(): void {
    this.objects.clear();
    this.signed.length = 0;
    this.calls.length = 0;
    this.failPut = false;
    this.failDelete = false;
  }
}

/** Valid file contents for the tests, padded to an exact size where a limit is being probed. */
export const SAMPLE = {
  png: (size = 64) =>
    padded(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), size),
  jpeg: (size = 64) =>
    padded(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
      size,
    ),
  webp: (size = 64) =>
    padded(
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0x24, 0, 0, 0]),
        Buffer.from('WEBPVP8 '),
      ]),
      size,
    ),
  pdf: (size = 64) => padded(Buffer.from('%PDF-1.7\n'), size),
  zip: (size = 64) =>
    padded(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]), size),
  text: (size = 64) => padded(Buffer.from('plain text\n'), size, 0x61),
  exe: (size = 64) => padded(Buffer.from('MZ\x90\x00\x03\x00', 'latin1'), size),
  elf: (size = 64) =>
    padded(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), size),
  script: () => Buffer.from('#!/bin/sh\necho owned\n'),
  gif: () =>
    Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0xff, 0xff,
      0xff,
    ]),
  svg: () =>
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ),
};

function padded(header: Buffer, size: number, fill = 0x00): Buffer {
  if (size <= header.length) return header;
  return Buffer.concat([header, Buffer.alloc(size - header.length, fill)]);
}

/**
 * A raw multipart/form-data body, so that a test can send a file name exactly as it wants (supertest/form-data would normalize
 * it): `parts` are fields or files with a literal `filename` that is written into the header as given (UTF-8).
 */
export function multipart(
  parts: {
    name: string;
    value?: string;
    filename?: string;
    contentType?: string;
    data?: Buffer;
  }[],
): {
  body: Buffer;
  contentType: string;
} {
  const boundary = '----nelio-test-boundary';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      `Content-Disposition: form-data; name="${part.name}"` +
      (part.filename !== undefined ? `; filename="${part.filename}"` : '');
    const header =
      `--${boundary}\r\n${disposition}\r\n` +
      (part.contentType ? `Content-Type: ${part.contentType}\r\n` : '') +
      '\r\n';
    chunks.push(
      Buffer.from(header, 'utf8'),
      part.data ?? Buffer.from(part.value ?? '', 'utf8'),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
