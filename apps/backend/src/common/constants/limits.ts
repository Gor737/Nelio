/**
 * Limits: single source of truth (docs/architecture.md section 20, Decision 137).
 * Read by request DTOs; M5/M7 compare them with the SQL CHECK constraints in a test.
 *
 * `source: 'documented'` values come from the decision log or architecture; `source: 'approved-default'` values were not specified
 * by the documents: they are defaults proposed by the implementer and approved by the owner on 2026-10-25, listed in
 * docs/proposed-defaults.md. Changing one is a one-line edit here (and a matching migration if it has a SQL CHECK).
 */
export interface Range {
  readonly min: number;
  readonly max: number;
  readonly source: 'documented' | 'approved-default';
}

const documented = (min: number, max: number): Range => ({
  min,
  max,
  source: 'documented',
});
const approvedDefault = (min: number, max: number): Range => ({
  min,
  max,
  source: 'approved-default',
});

/** Text lengths in characters. */
export const TEXT_LIMITS = {
  /** Architecture: "Passwords: Argon2id, 10-128 chars". */
  PASSWORD: documented(10, 128),
  /** RFC 5321 practical maximum for an address. */
  EMAIL: approvedDefault(3, 254),
  USER_FULL_NAME: approvedDefault(1, 100),
  TEACHER_APPLICATION_MESSAGE: approvedDefault(10, 1000),
  COURSE_TITLE: approvedDefault(3, 120),
  COURSE_SUMMARY: approvedDefault(10, 300),
  COURSE_DESCRIPTION: approvedDefault(0, 5000),
  SECTION_TITLE: approvedDefault(1, 120),
  LESSON_TITLE: approvedDefault(1, 150),
  /** Markdown text block (Decision 66: text blocks store Markdown). */
  TEXT_BLOCK_BODY: approvedDefault(1, 20_000),
  TAG_NAME: approvedDefault(2, 30),
  CATEGORY_NAME: approvedDefault(2, 60),
  GROUP_TITLE: approvedDefault(1, 80),
  MESSAGE_BODY: approvedDefault(1, 2000),
  /** `Report.description?` (the `reason` column is an enum: SPAM/HARASSMENT/INAPPROPRIATE/OTHER). */
  REPORT_DESCRIPTION: approvedDefault(1, 1000),
  /** `Report.resolution_note?`. */
  REPORT_RESOLUTION_NOTE: approvedDefault(1, 1000),
  /** `UserRole.decision_note?` written with a Teacher application decision. */
  DECISION_NOTE: approvedDefault(1, 1000),
  /** `FileAsset.original_name`. */
  FILE_ORIGINAL_NAME: approvedDefault(1, 255),
  /** API-only (no column): reason shown to the Owner when a course is locked (COURSE_ADMIN_LOCKED notification `data`). */
  ADMIN_LOCK_REASON: approvedDefault(5, 500),
} as const satisfies Record<string, Range>;

/** Counts and sizes that are not text lengths. */
export const COUNT_LIMITS = {
  /** Decision log (group conversations): "Maximum 50 members"; architecture section 20 lists the group cap (50). */
  GROUP_MEMBERS_MAX: 50,
  /** Architecture section 13: offset pagination `pageSize`, max 50. */
  PAGE_SIZE_MAX: 50,
  PAGE_SIZE_DEFAULT: 20,
  /** Architecture section 13: `GET /users?q=` login required, at least 2 characters, at most 20 results. */
  USER_SEARCH_MIN_QUERY_LENGTH: 2,
  USER_SEARCH_MAX_RESULTS: 20,
  /** Roadmap M9b: `GET /tags` autocomplete, max 20. */
  TAG_AUTOCOMPLETE_MAX_RESULTS: 20,
  /** Chosen: tags per course. */
  TAGS_PER_COURSE_MAX: 10,
  /** Chosen: cursor pagination page for messages, notifications and the audit log. */
  CURSOR_PAGE_SIZE_MAX: 100,
  CURSOR_PAGE_SIZE_DEFAULT: 50,
  /** Architecture section 14: "Admins see ... about 10 messages either side". */
  REPORT_CONTEXT_MESSAGES_EACH_SIDE: 10,
  /** Architecture section 17: "chunked bulk insert (~500)". */
  NOTIFICATION_FANOUT_CHUNK: 500,
  /** Approved in Decision 167: upper bound on the in-memory rate-limit windows (about 10 MB at this size). */
  RATE_LIMIT_MAX_KEYS: 50_000,
} as const;

/** Time-related limits, in milliseconds unless the name says otherwise. */
export const TIME_LIMITS = {
  /** Architecture section 11: JWT access token, 15 minutes. */
  ACCESS_TOKEN_TTL_MS: 15 * 60 * 1000,
  /** Roadmap M5: refresh token family capped at 90 days from `family_started_at`. */
  REFRESH_FAMILY_MAX_AGE_DAYS: 90,
  /** Decision 145: about 10 seconds of grace for a reused refresh token. */
  REFRESH_REUSE_GRACE_MS: 10 * 1000,
  /** Decision 75/architecture: read notifications are deleted after about 90 days. */
  NOTIFICATION_RETENTION_DAYS: 90,
  /** Invitations expire after 7 days (architecture/decision log: "a new 7-day expiry"). */
  INVITATION_TTL_DAYS: 7,
  /** Chosen: single-use email verification and password-reset tokens. */
  EMAIL_TOKEN_TTL_MS: 60 * 60 * 1000,
  /** Architecture section 14: presence offline debounce about 5 s; typing expiry about 5 s. */
  PRESENCE_OFFLINE_DEBOUNCE_MS: 5 * 1000,
  TYPING_EXPIRY_MS: 5 * 1000,
  /** Roadmap M9a: orphan file cleanup for files older than 24 hours. */
  ORPHAN_FILE_AGE_HOURS: 24,
  /** Proposed in M9a (docs/proposed-defaults.md section 13): how long a signed attachment URL works. */
  SIGNED_URL_TTL_MS: 5 * 60 * 1000,
} as const;

/** Upload kinds and size caps (Decision 64, Architecture section 16). Sizes are bytes. */
export const FILE_KINDS = [
  'AVATAR',
  'COURSE_COVER',
  'LESSON_ATTACHMENT',
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const MB = 1024 * 1024;

export const FILE_LIMITS: Record<
  FileKind,
  {
    readonly maxBytes: number;
    readonly mimeTypes: readonly string[];
    readonly source: 'approved-default';
  }
> = {
  AVATAR: {
    maxBytes: 2 * MB,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    source: 'approved-default',
  },
  COURSE_COVER: {
    maxBytes: 5 * MB,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    source: 'approved-default',
  },
  LESSON_ATTACHMENT: {
    maxBytes: 25 * MB,
    mimeTypes: [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/zip',
      'text/plain',
    ],
    source: 'approved-default',
  },
};

/**
 * Transaction runner defaults (Spike B report, section 3). Approved by the owner on 2026-10-25: listed in the
 * "Added in M6" section of docs/proposed-defaults.md (revisit POOL_MAX at M14). Prisma's own `timeout` only fails the COMMIT and never cancels a
 * statement, so the PostgreSQL timeouts are what really bound a transaction; the Prisma timeout is kept larger than both.
 */
export const TRANSACTION_LIMITS = {
  /** PostgreSQL statement_timeout for one statement inside a transaction. */
  STATEMENT_TIMEOUT_MS: 8_000,
  /** PostgreSQL lock_timeout: how long a statement waits for a lock. */
  LOCK_TIMEOUT_MS: 5_000,
  /** Prisma interactive-transaction timeout (greater than both PostgreSQL timeouts). */
  PRISMA_TIMEOUT_MS: 10_000,
  /** Prisma wait for a pooled connection. */
  PRISMA_MAX_WAIT_MS: 5_000,
  /** Attempts for deadlock (40P01) and serialization failure (40001), the first one included. */
  MAX_ATTEMPTS: 3,
  /** Base backoff between attempts, multiplied by the attempt number and jittered. */
  RETRY_BASE_DELAY_MS: 20,
  /** Connections in the Prisma/pg pool of the single backend instance. */
  POOL_MAX: 10,
} as const;
