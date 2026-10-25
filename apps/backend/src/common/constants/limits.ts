/**
 * Limits: single source of truth (docs/architecture.md section 20, Decision 137).
 * Read by request DTOs; M5/M7 compare them with the SQL CHECK constraints in a test.
 *
 * `source: 'documented'` values come from the decision log or architecture; `source: 'chosen'` values were not specified
 * by the documents and are the smallest reasonable choice. Chosen values are listed in the M4 milestone report for the
 * owner to confirm; changing one is a one-line edit here (and a matching migration if it has a SQL CHECK).
 */
export interface Range {
  readonly min: number;
  readonly max: number;
  readonly source: 'documented' | 'chosen';
}

const documented = (min: number, max: number): Range => ({
  min,
  max,
  source: 'documented',
});
const chosen = (min: number, max: number): Range => ({
  min,
  max,
  source: 'chosen',
});

/** Text lengths in characters. */
export const TEXT_LIMITS = {
  /** Architecture: "Passwords: Argon2id, 10-128 chars". */
  PASSWORD: documented(10, 128),
  /** RFC 5321 practical maximum for an address. */
  EMAIL: chosen(3, 254),
  USER_FULL_NAME: chosen(1, 100),
  TEACHER_APPLICATION_MESSAGE: chosen(10, 1000),
  COURSE_TITLE: chosen(3, 120),
  COURSE_SUMMARY: chosen(10, 300),
  COURSE_DESCRIPTION: chosen(0, 5000),
  SECTION_TITLE: chosen(1, 120),
  LESSON_TITLE: chosen(1, 150),
  /** Markdown text block (Decision 66: text blocks store Markdown). */
  TEXT_BLOCK_BODY: chosen(1, 20_000),
  TAG_NAME: chosen(2, 30),
  CATEGORY_NAME: chosen(2, 60),
  GROUP_TITLE: chosen(1, 80),
  MESSAGE_BODY: chosen(1, 2000),
  REPORT_REASON: chosen(1, 1000),
  INVITATION_MESSAGE: chosen(0, 500),
  /** Admin reason shown to the Owner when a course is locked (COURSE_ADMIN_LOCKED notification `data`). */
  ADMIN_LOCK_REASON: chosen(5, 500),
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
    readonly source: 'chosen';
  }
> = {
  AVATAR: {
    maxBytes: 2 * MB,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    source: 'chosen',
  },
  COURSE_COVER: {
    maxBytes: 5 * MB,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    source: 'chosen',
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
    source: 'chosen',
  },
};
