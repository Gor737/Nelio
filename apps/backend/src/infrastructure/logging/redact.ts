/**
 * Redaction for logs (roadmap M6: "redacting tokens/passwords/message bodies", architecture section 18).
 * Two layers: (1) object keys that name sensitive data, matched by WORD so that `passwordHash` and `access_token` match
 * but `context` does not match `text`; (2) patterns inside strings (bearer tokens, JWTs, credentials in URLs).
 * Request and response bodies are never logged at all; this is the safety net for anything that slips into a log field.
 */
export const REDACTED = '[REDACTED]';

const SENSITIVE_WORDS = new Set([
  'password',
  'passwd',
  'pass',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'credential',
  'credentials',
  'signature',
  'hash',
  'jwt',
  // private content and personal data
  'body',
  'text',
  'snapshot',
  'content',
  'email',
]);

function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
  const words = wordsOf(key);
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true;
  // "api-key" / "api_key" split into two words
  return words.some((w, i) => w === 'api' && words[i + 1] === 'key');
}

const STRING_PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi, `$1:${REDACTED}@`],
];

export function redactString(value: string): string {
  return STRING_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

const MAX_DEPTH = 6;

/** Returns a JSON-safe deep copy with sensitive keys and string patterns redacted. Never throws. */
export function redact(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function' || typeof value === 'symbol')
    return undefined;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[Truncated]';

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack ? { stack: redactString(value.stack) } : {}),
    };
  }

  const object = value as object;
  if (seen.has(object)) return '[Circular]';
  seen.add(object);

  if (Array.isArray(object))
    return object.map((item) => redact(item, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}
