/**
 * Error-code registry: every machine-readable `code` the API can return, with its HTTP status
 * (docs/architecture.md section 13, Decisions 137 and 140). Response shape: `{ statusCode, code, message, errors? }`.
 *
 * Status test (Decision 140): 400 request wrong regardless of data; 401 not authenticated; 403 caller not entitled;
 * 404 hidden, or the id is not part of the URL's course; 409 caller entitled but current data conflicts; 413/415
 * uploads; 429 throttled; 500 server bug. Check order: 429 -> 401 -> 403 ACCOUNT_SUSPENDED -> guards -> 400 -> 409.
 *
 * `source: 'documented'` = the code AND its status are stated in the documents. `source: 'approved-derived'` = the code name is
 * documented (or needed by a documented behavior) but its status was applied from the status test above; the derived
 * entries are owner-approved defaults (2026-10-25), listed in docs/proposed-defaults.md.
 * A module adds its own codes here when it implements them (the registry test keeps codes unique with one status).
 */
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500;

export interface ErrorCodeSpec {
  /** One status, or `[403, 409]` for the single documented two-status code. */
  readonly status: HttpStatus | readonly [HttpStatus, HttpStatus];
  readonly source: 'documented' | 'approved-derived';
  readonly description: string;
}

const documented = (
  status: ErrorCodeSpec['status'],
  description: string,
): ErrorCodeSpec => ({ status, source: 'documented', description });
const approvedDerived = (
  status: ErrorCodeSpec['status'],
  description: string,
): ErrorCodeSpec => ({ status, source: 'approved-derived', description });

export const ERROR_CODES = {
  // --- transport, validation, authentication ---
  VALIDATION_FAILED: documented(
    400,
    'Unknown field, wrong type or length, or a malformed UUID.',
  ),
  UNAUTHENTICATED: documented(401, 'Missing, invalid or expired access token.'),
  ACCOUNT_SUSPENDED: documented(403, 'The authenticated account is suspended.'),
  FORBIDDEN: documented(403, 'The caller is not entitled to this action.'),
  TEACHER_NOT_APPROVED: documented(
    403,
    'A Teacher action by a user without an ACTIVE Teacher role.',
  ),
  NOT_FOUND: approvedDerived(
    404,
    'The resource does not exist or the caller may not know that it exists.',
  ),
  TOO_MANY_REQUESTS: approvedDerived(
    429,
    'Rate limit exceeded; checked before authentication.',
  ),
  INTERNAL_ERROR: approvedDerived(
    500,
    'Unexpected server error, including database CHECK violations (a service bug, logged loudly).',
  ),
  RESOURCE_CONFLICT: approvedDerived(
    409,
    'A unique or foreign-key violation that no service rule translated into a specific code.',
  ),

  // --- authentication and accounts ---
  INVALID_CURRENT_PASSWORD: documented(
    403,
    'change-password with a wrong current password (403 so the frontend does not treat it as session expiry).',
  ),
  TOKEN_INVALID: approvedDerived(
    400,
    'Email-verification or password-reset token that is unknown, used or expired.',
  ),
  NO_LOGIN_METHOD_REMAINING: approvedDerived(
    409,
    'Unlinking or removing the last login method.',
  ),

  // --- courses and archive/lock rules ---
  COURSE_ARCHIVED: documented(
    409,
    'Content or settings mutation on an archived course.',
  ),
  COURSE_ADMIN_LOCKED: documented(
    [403, 409],
    '403 when a student is shut out of a locked course; 409 when a teacher mutation is refused. Takes precedence over COURSE_ARCHIVED.',
  ),
  COURSE_ALREADY_LOCKED: approvedDerived(
    409,
    'Admin lock on an already locked course.',
  ),
  COURSE_NOT_LOCKED: documented(
    409,
    'Admin unlock or restore on a course that is not locked.',
  ),
  INVALID_STATE_TRANSITION: approvedDerived(
    409,
    'A status change that the state machine does not allow.',
  ),
  ORDER_MISMATCH: documented(
    409,
    'Full-list reorder whose ids do not match the current list (stale reorder).',
  ),

  // --- enrollment and invitations ---
  INVITATION_REQUIRED: documented(
    403,
    'Enrolling in an INVITATION_ONLY course without an invitation.',
  ),
  INVITATION_PENDING: documented(
    409,
    'Creating an invitation while a valid PENDING one exists.',
  ),
  ALREADY_ENROLLED: approvedDerived(
    409,
    'Accepting an invitation or enrolling when the enrollment is already ACTIVE.',
  ),

  // --- users, roles, blocking, admin ---
  APPLICATION_PENDING: approvedDerived(
    409,
    'Teacher application while one is already PENDING.',
  ),
  ALREADY_TEACHER: documented(
    409,
    'Teacher application by a user who already has an ACTIVE Teacher role.',
  ),
  LAST_PLATFORM_ADMIN: approvedDerived(
    409,
    'Demoting or suspending the last active Admin (Decision 135).',
  ),
  CANNOT_SUSPEND_SELF: documented(
    400,
    'An Admin suspending their own account.',
  ),
  CANNOT_BLOCK_SELF: approvedDerived(400, 'Blocking yourself.'),
  CANNOT_BLOCK_ADMIN: documented(409, 'Blocking an Admin.'),

  // --- chat ---
  LAST_GROUP_ADMIN: approvedDerived(
    409,
    'Removing or demoting the last admin of a group while other members remain (Decision 135).',
  ),
  MEMBERS_UNAVAILABLE: approvedDerived(
    409,
    'Adding members to a group when some cannot be added; neutral, does not reveal blocks.',
  ),
  CANNOT_MESSAGE_USER: approvedDerived(
    403,
    'Starting a direct conversation that a block forbids; identical in either direction.',
  ),
  CLIENT_ID_REUSED: approvedDerived(
    409,
    'A client_id reused with a different body.',
  ),

  // --- moderation ---
  REPORT_ALREADY_RESOLVED: approvedDerived(
    409,
    'Resolving a report that a sibling resolution already closed.',
  ),

  // --- files ---
  FILE_TOO_LARGE: documented(
    413,
    'Upload exceeds the size limit for its kind.',
  ),
  FILE_TYPE_NOT_ALLOWED: documented(
    415,
    'Upload whose real content type is not allowed for its kind.',
  ),
  FILE_IN_USE: approvedDerived(
    409,
    'Deleting a file that is still referenced.',
  ),
} as const satisfies Record<string, ErrorCodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** The single status of a code, or the pair for the two-status exception. */
export const statusesOf = (code: ErrorCode): readonly HttpStatus[] => {
  const status: ErrorCodeSpec['status'] = ERROR_CODES[code].status;
  return typeof status === 'number' ? [status] : status;
};
