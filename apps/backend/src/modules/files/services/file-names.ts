import { randomUUID } from 'node:crypto';
import {
  TEXT_LIMITS,
  type FileKind,
} from '../../../common/constants/limits.js';
import { codePointLength } from '../../../common/decorators/text-length.decorator.js';

/**
 * The name the uploader's browser sent, made safe to STORE and to DISPLAY (it is never used to build a storage key or a path):
 *   - the Content-Disposition filename arrives decoded as Latin-1; a name that is UTF-8 mojibake is decoded again;
 *   - any directory part is dropped (`../../etc/passwd` -> `passwd`, `C:\\evil\\a.png` -> `a.png`);
 *   - control characters (NUL, line breaks, tabs...) become spaces; bidirectional override characters, which make `exe.png` display as
 *     `gnp.exe`, are removed;
 *   - whitespace is collapsed and trimmed, the result is cut to `TEXT_LIMITS.FILE_ORIGINAL_NAME.max` CODE POINTS (never in the middle
 *     of a surrogate pair), and an empty result becomes `file`.
 */
export function sanitizeOriginalName(raw: string): string {
  let name = raw;
  // Latin-1 mojibake of UTF-8 text: every char <= 0xFF and re-decoding as UTF-8 is valid and shorter.
  if (
    Array.from(name).every((c) => c.charCodeAt(0) <= 0xff) &&
    /[\u0080-\u00ff]/.test(name)
  ) {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) name = decoded;
  }
  name = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  name = name.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  name = name.replace(/\s+/g, ' ').trim();
  // A lone surrogate cannot be stored; replace it before counting.
  name = name.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
  const max = TEXT_LIMITS.FILE_ORIGINAL_NAME.max;
  if (codePointLength(name) > max)
    name = Array.from(name).slice(0, max).join('');
  return name.length > 0 ? name : 'file';
}

/** Avatars and course covers are public; attachments are private and served only through short-lived signed URLs. */
export const isPublicKind = (kind: FileKind): boolean =>
  kind === 'AVATAR' || kind === 'COURSE_COVER';

const KEY_PREFIX: Record<FileKind, string> = {
  AVATAR: 'public/avatars',
  COURSE_COVER: 'public/covers',
  LESSON_ATTACHMENT: 'private/attachments',
};

/**
 * `public/avatars/<uuid>.png`. The key is generated entirely by the server from the kind, a random UUID and the extension of the
 * DETECTED type: no part of it comes from the client, so a hostile file name cannot influence it, and a guess cannot find another
 * user's attachment. Everything under `public/` may be read without a signature; everything else needs a signed URL.
 */
export function generateStorageKey(kind: FileKind, extension: string): string {
  return `${KEY_PREFIX[kind]}/${randomUUID()}.${extension}`;
}

export const STORAGE_KEY_PATTERN =
  /^(public\/(avatars|covers)|private\/attachments)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf|zip|txt)$/;
