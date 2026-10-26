// M4 tests: the shared source-of-truth files are internally consistent and agree with the documents and with each other.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  ADVISORY_LOCK_KEYS,
  AUDIT_ACTIONS,
  AUDIT_ACTION_NAMES,
  AUDIT_WRITER_MODULES,
  COUNT_LIMITS,
  COURSE_PERMISSIONS,
  COURSE_RELATIONSHIPS,
  ERROR_CODES,
  FILE_KINDS,
  FILE_LIMITS,
  LOCKABLE_TABLES,
  LOCK_ORDER,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_NAMES,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  RATE_LIMIT_CLASSES,
  ROW_LOCK_MODES,
  TEXT_LIMITS,
  TIME_LIMITS,
  courseAllows,
  platformAllows,
  statusesOf,
  type ErrorCode,
} from '../../src/common/constants/index.js';
import {
  EVENT_NAMES,
  NOTIFICATION_EVENTS,
} from '../../src/infrastructure/events/index.js';

const require = createRequire(import.meta.url);
const byName = (a: string, b: string) => a.localeCompare(b);

describe('error codes', () => {
  const codes = Object.keys(ERROR_CODES) as ErrorCode[];

  it('are unique, UPPER_SNAKE, and each has a distinct non-empty description', () => {
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    const descriptions = codes.map((c) => ERROR_CODES[c].description);
    expect(descriptions.every((d) => d.trim().length > 10)).toBe(true);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('every code has exactly one HTTP status, except COURSE_ADMIN_LOCKED which is 403 or 409 (Decision 140)', () => {
    const twoStatus = codes.filter((c) => statusesOf(c).length === 2);
    expect(twoStatus).toEqual(['COURSE_ADMIN_LOCKED']);
    expect(statusesOf('COURSE_ADMIN_LOCKED')).toEqual([403, 409]);
    for (const code of codes) {
      for (const status of statusesOf(code))
        expect([400, 401, 403, 404, 409, 413, 415, 429, 500, 503]).toContain(
          status,
        );
    }
  });

  it('carry the statuses the documents state (Decision 140 and neighbours)', () => {
    const expected: Partial<Record<ErrorCode, number>> = {
      VALIDATION_FAILED: 400,
      UNAUTHENTICATED: 401,
      ACCOUNT_SUSPENDED: 403,
      FORBIDDEN: 403,
      TEACHER_NOT_APPROVED: 403,
      INVITATION_REQUIRED: 403,
      FILE_TOO_LARGE: 413,
      FILE_TYPE_NOT_ALLOWED: 415,
      INVALID_CURRENT_PASSWORD: 403,
      COURSE_ARCHIVED: 409,
      COURSE_NOT_LOCKED: 409,
      INVITATION_PENDING: 409,
      ALREADY_TEACHER: 409,
      ORDER_MISMATCH: 409,
      CANNOT_BLOCK_ADMIN: 409,
      CANNOT_SUSPEND_SELF: 400,
    };
    for (const [code, status] of Object.entries(expected))
      expect(statusesOf(code as ErrorCode)).toEqual([status]);
  });

  it('contain the Phase 7 codes and do not contain the retired LAST_ADMIN (split by Decision 135)', () => {
    for (const code of [
      'INVALID_STATE_TRANSITION',
      'COURSE_ALREADY_LOCKED',
      'COURSE_NOT_LOCKED',
      'LAST_PLATFORM_ADMIN',
      'LAST_GROUP_ADMIN',
    ]) {
      expect(codes).toContain(code);
    }
    expect(codes).not.toContain('LAST_ADMIN');
  });

  it('mark every status that is not stated in the documents as derived', () => {
    const documented = codes.filter(
      (c) => ERROR_CODES[c].source === 'documented',
    );
    const derived = codes.filter(
      (c) => ERROR_CODES[c].source === 'approved-derived',
    );
    expect(documented.length + derived.length).toBe(codes.length);
    expect(ERROR_CODES.SERVICE_UNAVAILABLE).toMatchObject({
      status: 503,
      source: 'documented', // Decision 166
    });
    expect(documented.length).toBeGreaterThan(10);
    expect(derived.length).toBeGreaterThan(0);
  });
});

describe('notification types', () => {
  it('are exactly 12 (Decision 139) and named as in the catalog', () => {
    expect(NOTIFICATION_TYPE_NAMES).toHaveLength(12);
    expect([...NOTIFICATION_TYPE_NAMES].sort(byName)).toEqual(
      [
        'COURSE_ADMIN_LOCKED',
        'ENROLLMENT_APPROVED',
        'ENROLLMENT_REJECTED',
        'ENROLLMENT_REQUESTED',
        'INVITATION_RECEIVED',
        'LESSON_PUBLISHED',
        'OWNERSHIP_TRANSFERRED',
        'REMOVED_FROM_COURSE',
        'TEACHER_APPLICATION_APPROVED',
        'TEACHER_APPLICATION_RECEIVED',
        'TEACHER_APPLICATION_REJECTED',
        'TEACHER_ROLE_REVOKED',
      ].sort(byName),
    );
  });

  it('each has a recipient set and a trigger, and the documented recipients are right', () => {
    for (const type of NOTIFICATION_TYPE_NAMES) {
      expect(NOTIFICATION_TYPES[type].trigger.length).toBeGreaterThan(10);
    }
    expect(NOTIFICATION_TYPES.TEACHER_APPLICATION_RECEIVED.recipients).toBe(
      'ALL_ACTIVE_ADMINS',
    );
    expect(NOTIFICATION_TYPES.ENROLLMENT_REQUESTED.recipients).toBe(
      'COURSE_OWNER_AND_ASSISTANTS',
    );
    expect(NOTIFICATION_TYPES.COURSE_ADMIN_LOCKED.recipients).toBe(
      'COURSE_OWNER_AND_ASSISTANTS',
    );
    expect(NOTIFICATION_TYPES.LESSON_PUBLISHED.recipients).toBe(
      'ACTIVE_STUDENTS',
    );
  });
});

describe('audit actions', () => {
  it('are unique and each is written by a module on the audit allow-list', () => {
    expect(new Set(AUDIT_ACTION_NAMES).size).toBe(AUDIT_ACTION_NAMES.length);
    for (const action of AUDIT_ACTION_NAMES) {
      expect(action).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
      expect(AUDIT_WRITER_MODULES).toContain(AUDIT_ACTIONS[action].writer);
    }
  });

  it('include the documented names, and share with the notification names only COURSE_ADMIN_LOCKED (separate lists)', () => {
    for (const documented of [
      'TEACHER_APPROVED',
      'COURSE_ADMIN_UNLOCKED',
      'REPORT_CONTEXT_VIEWED',
    ])
      expect(AUDIT_ACTION_NAMES).toContain(documented);
    expect(NOTIFICATION_TYPE_NAMES).not.toContain('TEACHER_APPROVED');
    const shared = AUDIT_ACTION_NAMES.filter((a) =>
      (NOTIFICATION_TYPE_NAMES as string[]).includes(a),
    );
    expect(shared).toEqual(['COURSE_ADMIN_LOCKED']);
  });

  it('writer modules equal the dependency-cruiser audit allow-list, so the two cannot drift', () => {
    const config = require('../../.dependency-cruiser.cjs') as {
      forbidden: { name: string; from: { pathNot: string } }[];
    };
    const rule = config.forbidden.find(
      (r) => r.name === 'audit-only-by-audited-modules',
    );
    const allowed =
      /\^src\/modules\/\(([^)]+)\)\//
        .exec(rule?.from.pathNot ?? '')?.[1]
        .split('|') ?? [];
    expect([...allowed].sort(byName)).toEqual(
      [...AUDIT_WRITER_MODULES].sort(byName),
    );
  });
});

describe('permission matrix', () => {
  it('references only real platform roles and course relationships, with at least one grantee each', () => {
    for (const [permission, roles] of Object.entries(PLATFORM_PERMISSIONS)) {
      expect(roles.length).toBeGreaterThan(0);
      for (const role of roles as readonly string[])
        expect(PLATFORM_ROLES as readonly string[]).toContain(role);
      expect(permission).toMatch(/^[a-z-]+(\.[a-z-]+)+$/);
    }
    for (const [permission, relationships] of Object.entries(
      COURSE_PERMISSIONS,
    )) {
      expect(relationships.length).toBeGreaterThan(0);
      for (const relationship of relationships as readonly string[])
        expect(COURSE_RELATIONSHIPS as readonly string[]).toContain(
          relationship,
        );
      expect(permission).toMatch(/^[a-z-]+(\.[a-z-]+)+$/);
    }
  });

  it('encodes the roles and permissions text of the architecture', () => {
    // Admins act only through /admin/*: every admin.* permission is Admin-only, and no course permission names ADMIN.
    for (const [permission, roles] of Object.entries(PLATFORM_PERMISSIONS)) {
      if (permission.startsWith('admin.')) expect(roles).toEqual(['ADMIN']);
    }
    expect(Object.values(COURSE_PERMISSIONS).flat()).not.toContain('ADMIN');
    // Creating a course needs a Teacher; applying for Teacher is open to STUDENT (which every user holds).
    expect(PLATFORM_PERMISSIONS['course.create']).toEqual(['TEACHER']);
    expect(
      platformAllows('teacher-application.apply', ['STUDENT', 'ADMIN']),
    ).toBe(true);
    // Assistant cannot remove students, change settings, manage teachers, or archive/delete.
    for (const forbidden of [
      'students.remove',
      'students.reinstate',
      'course.update-settings',
      'team.add-assistant',
      'team.remove-assistant',
      'team.transfer-ownership',
      'course.archive',
      'course.delete',
      'course.publish',
    ] as const) {
      expect(courseAllows(forbidden, 'ASSISTANT')).toBe(false);
      expect(courseAllows(forbidden, 'OWNER')).toBe(true);
    }
    // Assistant can do content, approve/reject requests, view students and progress, invite.
    for (const allowed of [
      'content.edit',
      'enrollment.review-requests',
      'students.view',
      'students.view-progress',
      'invitations.manage',
    ] as const) {
      expect(courseAllows(allowed, 'ASSISTANT')).toBe(true);
    }
  });

  it('the Owner can do everything an Assistant can, except leaving as an Assistant', () => {
    for (const [permission, relationships] of Object.entries(
      COURSE_PERMISSIONS,
    )) {
      if (
        (relationships as readonly string[]).includes('ASSISTANT') &&
        permission !== 'team.leave-as-assistant'
      ) {
        expect(relationships).toContain('OWNER');
      }
    }
  });

  it('a removed or never-related user cannot read lesson content or take student actions (Decisions 70 and 123)', () => {
    for (const relationship of [
      'REMOVED',
      'REJECTED',
      'NONE',
      'INVITEE',
      'STUDENT_PENDING',
      'STUDENT_LEFT',
    ] as const) {
      expect(courseAllows('lesson.read-content', relationship)).toBe(false);
      expect(courseAllows('lesson.mark-complete', relationship)).toBe(false);
    }
    expect(courseAllows('enrollment.request', 'REMOVED')).toBe(false); // REMOVED returns only by reinstatement or a new invitation
    expect(courseAllows('enrollment.request', 'REJECTED')).toBe(true); // REJECTED can request again
    expect(courseAllows('enrollment.request', 'STUDENT_LEFT')).toBe(true);
  });
});

describe('limits', () => {
  it('every text range is a valid integer range', () => {
    for (const [name, range] of Object.entries(TEXT_LIMITS)) {
      expect(Number.isInteger(range.min) && Number.isInteger(range.max)).toBe(
        true,
      );
      expect(range.min).toBeGreaterThanOrEqual(0);
      expect(range.max).toBeGreaterThanOrEqual(range.min);
      expect(['documented', 'approved-default']).toContain(range.source);
      expect(name).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });

  it('match the values the documents state', () => {
    expect(TEXT_LIMITS.PASSWORD).toMatchObject({
      min: 10,
      max: 128,
      source: 'documented',
    });
    expect(COUNT_LIMITS.GROUP_MEMBERS_MAX).toBe(50);
    expect(COUNT_LIMITS.PAGE_SIZE_MAX).toBe(50);
    expect(COUNT_LIMITS.USER_SEARCH_MIN_QUERY_LENGTH).toBe(2);
    expect(COUNT_LIMITS.USER_SEARCH_MAX_RESULTS).toBe(20);
    expect(COUNT_LIMITS.TAG_AUTOCOMPLETE_MAX_RESULTS).toBe(20);
    expect(COUNT_LIMITS.NOTIFICATION_FANOUT_CHUNK).toBe(500);
    expect(COUNT_LIMITS.REPORT_CONTEXT_MESSAGES_EACH_SIDE).toBe(10);
    expect(TIME_LIMITS.ACCESS_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    expect(TIME_LIMITS.REFRESH_FAMILY_MAX_AGE_DAYS).toBe(90);
    expect(TIME_LIMITS.REFRESH_REUSE_GRACE_MS).toBe(10_000);
    expect(TIME_LIMITS.NOTIFICATION_RETENTION_DAYS).toBe(90);
    expect(TIME_LIMITS.INVITATION_TTL_DAYS).toBe(7);
    expect(TIME_LIMITS.ORPHAN_FILE_AGE_HOURS).toBe(24);
  });

  it('page defaults fit inside their maximums', () => {
    expect(COUNT_LIMITS.PAGE_SIZE_DEFAULT).toBeLessThanOrEqual(
      COUNT_LIMITS.PAGE_SIZE_MAX,
    );
    expect(COUNT_LIMITS.CURSOR_PAGE_SIZE_DEFAULT).toBeLessThanOrEqual(
      COUNT_LIMITS.CURSOR_PAGE_SIZE_MAX,
    );
  });

  it('every upload kind has a positive size cap and at least one allowed content type', () => {
    expect(Object.keys(FILE_LIMITS).sort(byName)).toEqual(
      [...FILE_KINDS].sort(byName),
    );
    for (const kind of FILE_KINDS) {
      expect(FILE_LIMITS[kind].maxBytes).toBeGreaterThan(0);
      expect(FILE_LIMITS[kind].mimeTypes.length).toBeGreaterThan(0);
    }
    expect(FILE_LIMITS.AVATAR.maxBytes).toBeLessThan(
      FILE_LIMITS.LESSON_ATTACHMENT.maxBytes,
    );
  });
});

describe('rate-limit classes', () => {
  it('are exactly Strict, Tight, Per-conversation burst and Default, with positive values', () => {
    expect(Object.keys(RATE_LIMIT_CLASSES).sort(byName)).toEqual([
      'DEFAULT',
      'PER_CONVERSATION_BURST',
      'STRICT',
      'TIGHT',
    ]);
    for (const spec of Object.values(RATE_LIMIT_CLASSES)) {
      expect(spec.limit).toBeGreaterThan(0);
      expect(spec.windowMs).toBeGreaterThan(0);
      expect(spec.keys.length).toBeGreaterThan(0);
      expect(spec.appliesTo.length).toBeGreaterThan(0);
    }
  });

  it('are ordered by how sensitive the endpoint is, and Strict keys on both IP and email', () => {
    const perMinute = (c: { limit: number; windowMs: number }) =>
      (c.limit * 60_000) / c.windowMs;
    expect(perMinute(RATE_LIMIT_CLASSES.STRICT)).toBeLessThan(
      perMinute(RATE_LIMIT_CLASSES.TIGHT),
    );
    expect(perMinute(RATE_LIMIT_CLASSES.TIGHT)).toBeLessThan(
      perMinute(RATE_LIMIT_CLASSES.DEFAULT),
    );
    expect(RATE_LIMIT_CLASSES.STRICT.keys).toEqual(['ip', 'email']);
    expect(RATE_LIMIT_CLASSES.STRICT.appliesTo).toEqual([
      'login',
      'registration',
      'forgot-password',
      'resend-verification',
    ]);
  });
});

describe('lock whitelist and lock order', () => {
  it('lock order is unique and follows Decision 160: advisory, User, Course, Conversation, child rows, Message before Report', () => {
    expect(new Set(LOCK_ORDER).size).toBe(LOCK_ORDER.length);
    const at = (stage: (typeof LOCK_ORDER)[number]) =>
      LOCK_ORDER.indexOf(stage);
    expect(at('advisory')).toBe(0);
    expect(at('user')).toBeLessThan(at('course'));
    expect(at('course')).toBeLessThan(at('conversation'));
    expect(at('conversation')).toBeLessThan(at('section'));
    expect(at('section')).toBeLessThan(at('lesson'));
    expect(at('lesson')).toBeLessThan(at('enrollment'));
    expect(at('enrollment')).toBeLessThan(at('conversation_member'));
    expect(at('message')).toBeLessThan(at('report'));
  });

  it('the lockable tables are unique, are a subset of the lock order, and are listed in lock order', () => {
    expect(new Set(LOCKABLE_TABLES).size).toBe(LOCKABLE_TABLES.length);
    const positions = LOCKABLE_TABLES.map((t) => LOCK_ORDER.indexOf(t));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(LOCKABLE_TABLES as readonly string[]).not.toContain('advisory');
  });

  it('only S (FOR SHARE) and X (FOR NO KEY UPDATE) exist, and ADMIN-SET is the advisory key', () => {
    expect(ROW_LOCK_MODES).toEqual(['SHARE', 'NO_KEY_UPDATE']);
    expect(ADVISORY_LOCK_KEYS).toEqual(['ADMIN-SET']);
  });
});

describe('event contracts', () => {
  it('names are unique and include the events the architecture names', () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
    for (const name of [
      'message.created',
      'membership.ended',
      'session.revoked',
      'socket.connected',
      'socket.disconnected',
    ]) {
      expect(EVENT_NAMES).toContain(name);
    }
  });

  it('every notification type is produced by exactly one distinct event contract', () => {
    const events = NOTIFICATION_TYPE_NAMES.map(
      (type) => NOTIFICATION_EVENTS[type],
    );
    expect(events).toHaveLength(12);
    expect(new Set(events).size).toBe(12);
    for (const event of events) expect(EVENT_NAMES).toContain(event);
  });
});

describe('docs/proposed-defaults.md', () => {
  const doc = readFileSync(
    fileURLToPath(
      new URL('../../../../docs/proposed-defaults.md', import.meta.url),
    ),
    'utf8',
  );

  it('says plainly that the values are owner-approved initial defaults and NOT requirements of the original documents', () => {
    expect(doc).toContain(
      'APPROVED by the owner on 2026-10-25 as initial implementation defaults',
    );
    expect(doc).toContain('not requirements of the original documents');
  });

  it('lists every approved-default or approved-derived constant by name, so the list cannot fall behind the code', () => {
    const names: string[] = [
      ...Object.entries(TEXT_LIMITS)
        .filter(([, range]) => range.source === 'approved-default')
        .map(([name]) => name),
      ...Object.keys(ERROR_CODES).filter(
        (c) => ERROR_CODES[c as ErrorCode].source === 'approved-derived',
      ),
      ...AUDIT_ACTION_NAMES.filter(
        (a) => AUDIT_ACTIONS[a].source === 'approved-derived',
      ),
      ...NOTIFICATION_TYPE_NAMES.filter(
        (t) => NOTIFICATION_TYPES[t].source === 'approved-derived',
      ),
      ...Object.keys(RATE_LIMIT_CLASSES),
      ...FILE_KINDS,
      'PAGE_SIZE_DEFAULT',
      'CURSOR_PAGE_SIZE_DEFAULT',
      'CURSOR_PAGE_SIZE_MAX',
      'TAGS_PER_COURSE_MAX',
      'EMAIL_VERIFICATION_TOKEN_TTL_MS',
      'PASSWORD_RESET_TOKEN_TTL_MS',
    ];
    expect(names.filter((name) => !doc.includes(name))).toEqual([]);
    expect(names.length).toBeGreaterThan(60);
  });

  it('does not mention constants that were removed because the schema has no such columns', () => {
    expect(doc).not.toContain('REPORT_REASON');
    expect(doc).not.toContain('INVITATION_MESSAGE');
    expect(Object.keys(TEXT_LIMITS)).not.toContain('REPORT_REASON');
    expect(Object.keys(TEXT_LIMITS)).not.toContain('INVITATION_MESSAGE');
  });
});
