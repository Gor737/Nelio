import type { ErrorCode } from '../../../common/constants/error-codes.js';

export const ENROLLMENT_STATUSES = [
  'PENDING',
  'ACTIVE',
  'LEFT',
  'REJECTED',
  'REMOVED',
] as const;
export type EnrollmentStatusName = (typeof ENROLLMENT_STATUSES)[number];
export type PolicyName = 'OPEN' | 'APPROVAL_REQUIRED' | 'INVITATION_ONLY';

/** Who does what to an enrollment. `from` is `null` when the student has no enrollment row yet. */
export const ENROLLMENT_ACTIONS = [
  'ENROLL', // the student enrolls or returns (policy decides)
  'LEAVE', // the student leaves or cancels a pending request
  'APPROVE', // a teacher approves a request
  'REJECT', // a teacher rejects a request
  'REMOVE', // the Owner (or an Admin) removes an ACTIVE student
  'REINSTATE', // the Owner (or an Admin) brings a REMOVED student back
  'ACCEPT_INVITATION', // the invited student accepts
] as const;
export type EnrollmentAction = (typeof ENROLLMENT_ACTIONS)[number];

export type TransitionResult =
  | { readonly ok: true; readonly to: EnrollmentStatusName }
  | { readonly ok: false; readonly code: ErrorCode };

const to = (status: EnrollmentStatusName): TransitionResult => ({
  ok: true,
  to: status,
});
const no = (code: ErrorCode): TransitionResult => ({ ok: false, code });

/**
 * THE allowed-transition function (Decisions 8, 70, 123): the only place that says which status follows which action. Everything that
 * changes an enrollment asks it first; the rest of the code only carries the answer out. Pure, so a test can try every status x action x
 * policy.
 *
 * Enrolling (also returning): no enrollment, LEFT or REJECTED follow the course's CURRENT policy (OPEN -> ACTIVE, APPROVAL_REQUIRED ->
 * PENDING, INVITATION_ONLY needs an invitation: `INVITATION_REQUIRED`). An ACTIVE or PENDING student enrolling again is
 * `ALREADY_ENROLLED` (a double click is harmless). A REMOVED student cannot enroll: only reinstatement or a new invitation brings them back.
 * Accepting an invitation always ends ACTIVE (from no enrollment, LEFT, REJECTED, REMOVED or PENDING) and is `ALREADY_ENROLLED` when ACTIVE.
 */
export function nextEnrollmentStatus(
  from: EnrollmentStatusName | null,
  action: EnrollmentAction,
  policy: PolicyName,
): TransitionResult {
  switch (action) {
    case 'ENROLL':
      if (from === 'ACTIVE' || from === 'PENDING')
        return no('ALREADY_ENROLLED');
      if (from === 'REMOVED') return no('FORBIDDEN');
      if (policy === 'OPEN') return to('ACTIVE');
      if (policy === 'APPROVAL_REQUIRED') return to('PENDING');
      return no('INVITATION_REQUIRED');
    case 'LEAVE':
      if (from === null) return no('NOT_FOUND');
      return from === 'ACTIVE' || from === 'PENDING'
        ? to('LEFT')
        : no('INVALID_STATE_TRANSITION');
    case 'APPROVE':
      return from === 'PENDING'
        ? to('ACTIVE')
        : no(from === null ? 'NOT_FOUND' : 'INVALID_STATE_TRANSITION');
    case 'REJECT':
      return from === 'PENDING'
        ? to('REJECTED')
        : no(from === null ? 'NOT_FOUND' : 'INVALID_STATE_TRANSITION');
    case 'REMOVE':
      return from === 'ACTIVE'
        ? to('REMOVED')
        : no(from === null ? 'NOT_FOUND' : 'INVALID_STATE_TRANSITION');
    case 'REINSTATE':
      return from === 'REMOVED'
        ? to('ACTIVE')
        : no(from === null ? 'NOT_FOUND' : 'INVALID_STATE_TRANSITION');
    case 'ACCEPT_INVITATION':
      return from === 'ACTIVE' ? no('ALREADY_ENROLLED') : to('ACTIVE');
  }
}

/** Actions that ADD access (they are refused on an archived or Admin-locked course); leaving and removing never are (Decision 142). */
export const ADDS_ACCESS: ReadonlySet<EnrollmentAction> =
  new Set<EnrollmentAction>([
    'ENROLL',
    'APPROVE',
    'REINSTATE',
    'ACCEPT_INVITATION',
  ]);
