/**
 * Real file type, from the bytes and never from the client (docs/architecture.md section 16: "real file type, not the client
 * Content-Type, executables rejected"). The client's `Content-Type` header and the file extension are ignored completely.
 *
 * It recognizes exactly the types the upload kinds allow (`FILE_LIMITS`): JPEG, PNG, WebP, PDF, ZIP and plain text. A file whose
 * signature is an executable format is reported as `executable` so that the caller can refuse it whatever its name claims.
 * Anything else is `unknown`, and is refused as well: the list is an allow-list.
 */
export type DetectedType =
  | {
      readonly kind: 'allowed';
      readonly mimeType: string;
      readonly extension: string;
    }
  | { readonly kind: 'executable'; readonly format: string }
  | { readonly kind: 'unknown' };

const startsWith = (buffer: Uint8Array, bytes: readonly number[], offset = 0) =>
  buffer.length >= offset + bytes.length &&
  bytes.every((byte, i) => buffer[offset + i] === byte);

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

/** Executable and script formats: refused even when the extension says `.png` or `.txt`. */
function executableFormat(buffer: Uint8Array): string | undefined {
  if (startsWith(buffer, ascii('MZ'))) return 'Windows executable (PE)';
  if (startsWith(buffer, [0x7f, ...ascii('ELF')])) return 'ELF executable';
  if (startsWith(buffer, ascii('#!'))) return 'script with a shebang';
  // Mach-O (thin, either byte order, 32/64 bit) and universal binaries; 0xCAFEBABE is also the Java class file magic.
  for (const magic of [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xbe, 0xba, 0xfe, 0xca],
  ]) {
    if (startsWith(buffer, magic)) return 'Mach-O or Java class file';
  }
  if (startsWith(buffer, [0x4d, 0x5a])) return 'DOS executable';
  if (startsWith(buffer, ascii('<?php'))) return 'PHP script';
  return undefined;
}

/** Text: valid UTF-8, no NUL and no control characters other than tab, line feed, form feed and carriage return. */
function isPlainText(buffer: Uint8Array): boolean {
  if (buffer.length === 0) return false;
  for (const byte of buffer) {
    if (byte === 0x00) return false;
    if (
      byte < 0x20 &&
      byte !== 0x09 &&
      byte !== 0x0a &&
      byte !== 0x0c &&
      byte !== 0x0d
    )
      return false;
    if (byte === 0x7f) return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export function detectFileType(buffer: Uint8Array): DetectedType {
  const executable = executableFormat(buffer);
  if (executable) return { kind: 'executable', format: executable };

  if (startsWith(buffer, [0xff, 0xd8, 0xff]))
    return { kind: 'allowed', mimeType: 'image/jpeg', extension: 'jpg' };
  if (startsWith(buffer, [0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'allowed', mimeType: 'image/png', extension: 'png' };
  }
  if (
    startsWith(buffer, ascii('RIFF')) &&
    startsWith(buffer, ascii('WEBP'), 8)
  ) {
    return { kind: 'allowed', mimeType: 'image/webp', extension: 'webp' };
  }
  if (startsWith(buffer, ascii('%PDF-')))
    return { kind: 'allowed', mimeType: 'application/pdf', extension: 'pdf' };
  // ZIP: a local file header, or the end-of-central-directory record of an empty archive.
  if (
    startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])
  ) {
    return { kind: 'allowed', mimeType: 'application/zip', extension: 'zip' };
  }
  if (isPlainText(buffer))
    return { kind: 'allowed', mimeType: 'text/plain', extension: 'txt' };
  return { kind: 'unknown' };
}
