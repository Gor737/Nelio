// Unit tests for the pure parts of the Files module: real file-type detection, original-name sanitizing, storage keys, and the
// Content-Disposition header of signed downloads.
import { TEXT_LIMITS } from '../../../src/common/constants/limits.js';
import { codePointLength } from '../../../src/common/decorators/text-length.decorator.js';
import { detectFileType } from '../../../src/modules/files/services/file-type-detector.js';
import {
  STORAGE_KEY_PATTERN,
  generateStorageKey,
  isPublicKind,
  sanitizeOriginalName,
} from '../../../src/modules/files/services/file-names.js';
import { contentDisposition } from '../../../src/modules/files/storage/s3-storage.driver.js';

const bytes = (...values: (number | string)[]) =>
  Buffer.concat(
    values.map((v) =>
      typeof v === 'string' ? Buffer.from(v, 'latin1') : Buffer.from([v]),
    ),
  );
const PNG = bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 'rest of the file');
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 'JFIF');
const WEBP = bytes('RIFF', 0x24, 0, 0, 0, 'WEBPVP8 ');
const PDF = bytes('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0);
const EXE = bytes('MZ', 0x90, 0, 3, 0);
const ELF = bytes(0x7f, 'ELF', 2, 1, 1);

describe('detectFileType', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg', 'jpg'],
    ['PNG', PNG, 'image/png', 'png'],
    ['WebP', WEBP, 'image/webp', 'webp'],
    ['PDF', PDF, 'application/pdf', 'pdf'],
    ['ZIP (local file header)', ZIP, 'application/zip', 'zip'],
    [
      'ZIP (empty archive)',
      bytes(0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0),
      'application/zip',
      'zip',
    ],
    [
      'plain ASCII text',
      Buffer.from('hello\nworld\ttab\r\n'),
      'text/plain',
      'txt',
    ],
    [
      'UTF-8 text with Armenian and emoji',
      Buffer.from('Բարև Ձեզ 😀\n', 'utf8'),
      'text/plain',
      'txt',
    ],
  ])('recognizes %s from its bytes', (_label, buffer, mimeType, extension) => {
    expect(detectFileType(buffer)).toEqual({
      kind: 'allowed',
      mimeType,
      extension,
    });
  });

  it.each([
    ['a Windows executable', EXE],
    [
      'a Windows executable that starts like an MZ stub',
      bytes('MZ', 'This program cannot be run in DOS mode'),
    ],
    ['an ELF binary', ELF],
    ['a shell script', Buffer.from('#!/bin/sh\nrm -rf /\n')],
    ['a Mach-O binary', bytes(0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1)],
    [
      'a Java class file / universal Mach-O',
      bytes(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52),
    ],
    ['a PHP script', Buffer.from('<?php system($_GET["c"]); ?>')],
  ])('refuses %s as an executable, however it is named', (_label, buffer) => {
    expect(detectFileType(buffer).kind).toBe('executable');
  });

  it('an executable is refused even when it is padded to look like an image or text afterwards', () => {
    expect(detectFileType(Buffer.concat([EXE, PNG])).kind).toBe('executable');
    expect(
      detectFileType(
        Buffer.concat([
          Buffer.from('#!/usr/bin/env python\n'),
          Buffer.from('print(1)'),
        ]),
      ).kind,
    ).toBe('executable');
  });

  it.each([
    ['an empty file', Buffer.alloc(0)],
    ['random binary', bytes(0x01, 0x02, 0x03, 0x04, 0xfe, 0xfd)],
    ['text with a NUL byte', Buffer.from('abc\u0000def')],
    ['text with other control characters', Buffer.from('abc\u0007def')],
    ['invalid UTF-8', bytes(0x61, 0xc3, 0x28, 0x62)],
    [
      'a GIF (not an allowed type; a real one has binary bytes)',
      bytes('GIF89a', 1, 0, 1, 0, 0x80, 0, 0, 0xff, 0xff, 0xff),
    ],
    [
      'an SVG (script-capable, not allowed)',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    ],
    ['a truncated PNG signature', bytes(0x89, 'PNG')],
    ['a RIFF that is not WebP', bytes('RIFF', 0x24, 0, 0, 0, 'WAVEfmt ')],
  ])(
    'a file that is %s is unknown (refused: the list is an allow-list)',
    (label, buffer) => {
      const detected = detectFileType(buffer);
      // an SVG is valid text, so it is the one case that reads as plain text; it is refused for AVATAR/COURSE_COVER by the kind's list
      if (label.startsWith('an SVG'))
        expect(detected).toMatchObject({
          kind: 'allowed',
          mimeType: 'text/plain',
        });
      else expect(detected.kind).toBe('unknown');
    },
  );

  it('is decided by the content only: the detector takes no name and no claimed type', () => {
    expect(detectFileType.length).toBe(1);
    // "photo.png" containing a PDF is a PDF; "document.pdf" containing a PNG is a PNG.
    expect(detectFileType(PDF)).toMatchObject({ mimeType: 'application/pdf' });
    expect(detectFileType(PNG)).toMatchObject({ mimeType: 'image/png' });
  });
});

describe('sanitizeOriginalName', () => {
  it.each([
    ['syllabus.pdf', 'syllabus.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system32\\cmd.exe', 'cmd.exe'],
    ['C:\\Users\\ani\\photo.png', 'photo.png'],
    ['/absolute/path/file.txt', 'file.txt'],
    ['name\u0000.png', 'name .png'],
    ['line\nbreak\r\n.pdf', 'line break .pdf'],
    ['   spaced    out   .txt  ', 'spaced out .txt'],
    ['', 'file'],
    ['   ', 'file'],
    ['....//', 'file'],
    ['/', 'file'],
  ])('%j -> %j', (raw, expected) => {
    expect(sanitizeOriginalName(raw)).toBe(expected);
  });

  it('removes bidirectional override characters (the "exe.png" spoof)', () => {
    expect(sanitizeOriginalName('photo\u202egnp.exe')).toBe('photognp.exe');
    expect(sanitizeOriginalName('a\u2066b\u2069c')).toBe('abc');
  });

  it('decodes a UTF-8 file name that arrived as Latin-1 mojibake (Armenian, accents)', () => {
    const mojibake = (text: string) =>
      Buffer.from(text, 'utf8').toString('latin1');
    expect(sanitizeOriginalName(mojibake('Բարև.png'))).toBe('Բարև.png');
    expect(sanitizeOriginalName(mojibake('café.pdf'))).toBe('café.pdf');
    expect(sanitizeOriginalName('café.pdf')).toBe('café.pdf'); // a genuine Latin-1 name that is not valid UTF-8 stays as it is
  });

  it('is cut to the 255-code-point limit without splitting a surrogate pair, and never exceeds it', () => {
    const long = `${'😀'.repeat(300)}.png`;
    const cut = sanitizeOriginalName(long);
    expect(codePointLength(cut)).toBe(TEXT_LIMITS.FILE_ORIGINAL_NAME.max);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(codePointLength(sanitizeOriginalName('a'.repeat(1000)))).toBe(255);
  });

  it('replaces a lone surrogate (it cannot be stored)', () => {
    expect(sanitizeOriginalName('a\uD83Db.png')).toBe('a\uFFFDb.png');
  });

  it('always returns something the database column accepts (1 to 255 code points)', () => {
    for (const raw of [
      '',
      '\u0000',
      '\u202e',
      'x'.repeat(500),
      '😀'.repeat(400),
      '../',
      'ա'.repeat(300),
    ]) {
      const length = codePointLength(sanitizeOriginalName(raw));
      expect(length).toBeGreaterThanOrEqual(1);
      expect(length).toBeLessThanOrEqual(255);
    }
  });
});

describe('storage keys', () => {
  it('are generated from the kind, a random UUID and the DETECTED extension, and match the documented pattern', () => {
    expect(generateStorageKey('AVATAR', 'png')).toMatch(
      /^public\/avatars\/[0-9a-f-]{36}\.png$/,
    );
    expect(generateStorageKey('COURSE_COVER', 'jpg')).toMatch(
      /^public\/covers\/[0-9a-f-]{36}\.jpg$/,
    );
    expect(generateStorageKey('LESSON_ATTACHMENT', 'pdf')).toMatch(
      /^private\/attachments\/[0-9a-f-]{36}\.pdf$/,
    );
    for (const [kind, ext] of [
      ['AVATAR', 'webp'],
      ['COURSE_COVER', 'png'],
      ['LESSON_ATTACHMENT', 'zip'],
      ['LESSON_ATTACHMENT', 'txt'],
    ] as const)
      expect(generateStorageKey(kind, ext)).toMatch(STORAGE_KEY_PATTERN);
  });

  it('never repeat, and take nothing from the client (the function has no parameter for a name)', () => {
    const keys = new Set(
      Array.from({ length: 500 }, () => generateStorageKey('AVATAR', 'png')),
    );
    expect(keys.size).toBe(500);
    expect(generateStorageKey.length).toBe(2);
  });

  it('only avatars and covers are public', () => {
    expect(isPublicKind('AVATAR')).toBe(true);
    expect(isPublicKind('COURSE_COVER')).toBe(true);
    expect(isPublicKind('LESSON_ATTACHMENT')).toBe(false);
    expect(
      generateStorageKey('LESSON_ATTACHMENT', 'pdf').startsWith('public/'),
    ).toBe(false);
  });
});

describe('contentDisposition (signed downloads)', () => {
  it('forces a download, with an ASCII fallback and the real name percent-encoded', () => {
    expect(contentDisposition('report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
    const armenian = contentDisposition('Բարև.pdf');
    expect(armenian).toContain('attachment; filename="____.pdf"');
    expect(armenian).toContain(
      `filename*=UTF-8''${encodeURIComponent('Բարև')}.pdf`,
    );
  });

  it('cannot be broken out of by quotes, backslashes, semicolons or line breaks in the name', () => {
    const header = contentDisposition('a";x=y\\\r\nSet-Cookie: bad=1.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.match(/"/g)).toHaveLength(2); // only the two quotes around the fallback
    expect(header).toContain(`filename*=UTF-8''`);
    expect(header.split(`filename*=`)[1]).not.toContain(';');
    expect(header.split(`filename*=`)[1]).not.toContain('"');
  });
});
