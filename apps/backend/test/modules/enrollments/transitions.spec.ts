import { describe, expect, it } from '@jest/globals';
import {
  ADDS_ACCESS,
  ENROLLMENT_ACTIONS,
  ENROLLMENT_STATUSES,
  type EnrollmentAction,
  type EnrollmentStatusName,
  type PolicyName,
  nextEnrollmentStatus,
} from '../../../src/modules/enrollments/services/enrollment-transitions.js';

type From = EnrollmentStatusName | null;
const POLICIES: PolicyName[] = ['OPEN', 'APPROVAL_REQUIRED', 'INVITATION_ONLY'];
const FROMS: From[] = [null, ...ENROLLMENT_STATUSES];

/** The allowed-transition table of Decisions 70 and 123, written out by hand and independent of the implementation. */
const BY_POLICY = (open: string, approval: string, invitation: string) => ({
  OPEN: open,
  APPROVAL_REQUIRED: approval,
  INVITATION_ONLY: invitation,
});
const SAME = (v: string) => BY_POLICY(v, v, v);
const ENROLL_FREE = BY_POLICY('ACTIVE', 'PENDING', 'ERR:INVITATION_REQUIRED');

const EXPECTED: Record<
  EnrollmentAction,
  Record<string, Record<PolicyName, string>>
> = {
  ENROLL: {
    null: ENROLL_FREE,
    PENDING: SAME('ERR:ALREADY_ENROLLED'),
    ACTIVE: SAME('ERR:ALREADY_ENROLLED'),
    LEFT: ENROLL_FREE,
    REJECTED: ENROLL_FREE,
    REMOVED: SAME('ERR:FORBIDDEN'),
  },
  LEAVE: {
    null: SAME('ERR:NOT_FOUND'),
    PENDING: SAME('LEFT'),
    ACTIVE: SAME('LEFT'),
    LEFT: SAME('ERR:INVALID_STATE_TRANSITION'),
    REJECTED: SAME('ERR:INVALID_STATE_TRANSITION'),
    REMOVED: SAME('ERR:INVALID_STATE_TRANSITION'),
  },
  APPROVE: {
    null: SAME('ERR:NOT_FOUND'),
    PENDING: SAME('ACTIVE'),
    ACTIVE: SAME('ERR:INVALID_STATE_TRANSITION'),
    LEFT: SAME('ERR:INVALID_STATE_TRANSITION'),
    REJECTED: SAME('ERR:INVALID_STATE_TRANSITION'),
    REMOVED: SAME('ERR:INVALID_STATE_TRANSITION'),
  },
  REJECT: {
    null: SAME('ERR:NOT_FOUND'),
    PENDING: SAME('REJECTED'),
    ACTIVE: SAME('ERR:INVALID_STATE_TRANSITION'),
    LEFT: SAME('ERR:INVALID_STATE_TRANSITION'),
    REJECTED: SAME('ERR:INVALID_STATE_TRANSITION'),
    REMOVED: SAME('ERR:INVALID_STATE_TRANSITION'),
  },
  REMOVE: {
    null: SAME('ERR:NOT_FOUND'),
    PENDING: SAME('ERR:INVALID_STATE_TRANSITION'),
    ACTIVE: SAME('REMOVED'),
    LEFT: SAME('ERR:INVALID_STATE_TRANSITION'),
    REJECTED: SAME('ERR:INVALID_STATE_TRANSITION'),
    REMOVED: SAME('ERR:INVALID_STATE_TRANSITION'),
  },
  REINSTATE: {
    null: SAME('ERR:NOT_FOUND'),
    PENDING: SAME('ERR:INVALID_STATE_TRANSITION'),
    ACTIVE: SAME('ERR:INVALID_STATE_TRANSITION'),
    LEFT: SAME('ERR:INVALID_STATE_TRANSITION'),
    REJECTED: SAME('ERR:INVALID_STATE_TRANSITION'),
    REMOVED: SAME('ACTIVE'),
  },
  ACCEPT_INVITATION: {
    null: SAME('ACTIVE'),
    PENDING: SAME('ACTIVE'),
    ACTIVE: SAME('ERR:ALREADY_ENROLLED'),
    LEFT: SAME('ACTIVE'),
    REJECTED: SAME('ACTIVE'),
    REMOVED: SAME('ACTIVE'),
  },
};

const show = (r: ReturnType<typeof nextEnrollmentStatus>) =>
  r.ok ? r.to : `ERR:${r.code}`;

describe('the allowed-transition function (Decisions 70 and 123): every status x action x policy', () => {
  it('has an entry for every combination (6 statuses x 7 actions x 3 policies = 126)', () => {
    let count = 0;
    for (const action of ENROLLMENT_ACTIONS)
      for (const from of FROMS)
        for (const policy of POLICIES) {
          expect(EXPECTED[action][String(from)]?.[policy]).toBeDefined();
          count += 1;
        }
    expect(count).toBe(126);
  });

  it.each(ENROLLMENT_ACTIONS)(
    '%s gives exactly the documented result from every status under every policy',
    (action) => {
      for (const from of FROMS)
        for (const policy of POLICIES)
          expect([
            from,
            policy,
            show(nextEnrollmentStatus(from, action, policy)),
          ]).toEqual([from, policy, EXPECTED[action][String(from)][policy]]);
    },
  );

  it('the rules of the decisions in plain words', () => {
    expect(
      show(nextEnrollmentStatus('LEFT', 'ENROLL', 'APPROVAL_REQUIRED')),
    ).toBe('PENDING'); // a LEFT return follows the CURRENT policy
    expect(show(nextEnrollmentStatus('REJECTED', 'ENROLL', 'OPEN'))).toBe(
      'ACTIVE',
    ); // a rejected student may ask again
    expect(show(nextEnrollmentStatus('REMOVED', 'ENROLL', 'OPEN'))).toBe(
      'ERR:FORBIDDEN',
    ); // removal means something on open courses
    expect(
      show(nextEnrollmentStatus('REMOVED', 'REINSTATE', 'INVITATION_ONLY')),
    ).toBe('ACTIVE'); // explicit reinstatement restores ACTIVE directly
    expect(
      show(
        nextEnrollmentStatus('REMOVED', 'ACCEPT_INVITATION', 'INVITATION_ONLY'),
      ),
    ).toBe('ACTIVE'); // or a new invitation
    expect(show(nextEnrollmentStatus('PENDING', 'LEAVE', 'OPEN'))).toBe('LEFT'); // cancelling a request
  });

  it('only joining actions add access, so only they are refused on an archived or locked course', () => {
    expect([...ADDS_ACCESS].sort()).toEqual([
      'ACCEPT_INVITATION',
      'APPROVE',
      'ENROLL',
      'REINSTATE',
    ]);
    for (const leaving of ['LEAVE', 'REMOVE', 'REJECT'] as const)
      expect(ADDS_ACCESS.has(leaving)).toBe(false);
  });
});
