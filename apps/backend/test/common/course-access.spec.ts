// The table-driven access test (roadmap M8): relationship x course status x enrollment policy x Admin lock, against
// Decisions 119, 121 and 136. The expected outcomes are written out as a grid by hand, NOT derived from the implementation, so a
// change to `decideVisibility` has to be matched by a conscious change here.
import {
  COURSE_RELATIONSHIPS,
  type CourseRelationship,
} from '../../src/common/constants/permission-matrix.js';
import {
  type CourseStatusValue,
  type CourseVisibility,
  type EnrollmentPolicyValue,
  decideVisibility,
} from '../../src/common/access/index.js';
import { relationshipOf } from '../../src/common/access/course-access.service.js';

interface Combo {
  readonly label: string;
  readonly status: CourseStatusValue;
  readonly policy: EnrollmentPolicyValue;
  readonly locked: boolean;
}

/**
 * Columns of the grid, in order. D = DRAFT, P = PUBLISHED, A = ARCHIVED, A* = ARCHIVED and locked by an Admin (the database CHECK
 * allows a lock only on an archived course); policies: open, approval-required, invitation-only.
 */
const COMBOS: Combo[] = [
  { label: 'D/open', status: 'DRAFT', policy: 'OPEN', locked: false },
  {
    label: 'D/approval',
    status: 'DRAFT',
    policy: 'APPROVAL_REQUIRED',
    locked: false,
  },
  {
    label: 'D/invite',
    status: 'DRAFT',
    policy: 'INVITATION_ONLY',
    locked: false,
  },
  { label: 'P/open', status: 'PUBLISHED', policy: 'OPEN', locked: false },
  {
    label: 'P/approval',
    status: 'PUBLISHED',
    policy: 'APPROVAL_REQUIRED',
    locked: false,
  },
  {
    label: 'P/invite',
    status: 'PUBLISHED',
    policy: 'INVITATION_ONLY',
    locked: false,
  },
  { label: 'A/open', status: 'ARCHIVED', policy: 'OPEN', locked: false },
  {
    label: 'A/approval',
    status: 'ARCHIVED',
    policy: 'APPROVAL_REQUIRED',
    locked: false,
  },
  {
    label: 'A/invite',
    status: 'ARCHIVED',
    policy: 'INVITATION_ONLY',
    locked: false,
  },
  { label: 'A*/open', status: 'ARCHIVED', policy: 'OPEN', locked: true },
  {
    label: 'A*/approval',
    status: 'ARCHIVED',
    policy: 'APPROVAL_REQUIRED',
    locked: true,
  },
  {
    label: 'A*/invite',
    status: 'ARCHIVED',
    policy: 'INVITATION_ONLY',
    locked: true,
  },
];

// V = visible, N = 404, L = 403 COURSE_ADMIN_LOCKED.
//                                      D/o D/a D/i  P/o P/a P/i  A/o A/a A/i  A*o A*a A*i
const GRID: Record<CourseRelationship, string> = {
  OWNER: 'V   V   V    V   V   V    V   V   V    V   V   V', // management visibility in every state, locked or not
  ASSISTANT: 'V   V   V    V   V   V    V   V   V    V   V   V',
  STUDENT_ACTIVE: 'N   N   N    V   V   V    V   V   V    L   L   L', // keeps an archived course; shut out of a locked one
  STUDENT_LEFT: 'N   N   N    V   V   V    V   V   V    L   L   L', // still sees an INVITATION_ONLY page
  STUDENT_PENDING: 'N   N   N    V   V   V    N   N   N    L   L   L', // sees a published course; archived hides it; locked is 403
  INVITEE: 'N   N   N    V   V   V    N   N   N    N   N   N', // an invitation to an archived or locked course is invisible
  REMOVED: 'N   N   N    V   V   N    N   N   N    N   N   N', // like any visitor: public courses only
  REJECTED: 'N   N   N    V   V   N    N   N   N    N   N   N',
  NONE: 'N   N   N    V   V   N    N   N   N    N   N   N', // anonymous and never-enrolled
};
const OUTCOME: Record<string, CourseVisibility> = {
  V: 'VISIBLE',
  N: 'NOT_FOUND',
  L: 'LOCKED',
};

const cells = (row: string) => row.trim().split(/\s+/);

describe('course visibility (404 vs 403), table-driven', () => {
  it('the grid covers every relationship and every combination', () => {
    expect(Object.keys(GRID).sort()).toEqual([...COURSE_RELATIONSHIPS].sort());
    for (const row of Object.values(GRID))
      expect(cells(row)).toHaveLength(COMBOS.length);
  });

  const cases = COURSE_RELATIONSHIPS.flatMap((relationship) =>
    COMBOS.map(
      (combo, index) =>
        [
          relationship,
          combo.label,
          combo,
          OUTCOME[cells(GRID[relationship])[index]],
        ] as const,
    ),
  );

  it.each(cases)('%s on %s -> %s', (relationship, _label, combo, expected) => {
    const course = {
      id: 'c',
      status: combo.status,
      enrollmentPolicy: combo.policy,
      lockedByAdminAt: combo.locked ? new Date() : null,
    };
    expect(decideVisibility({ course, relationship })).toBe(expected);
  });

  it('108 cases: 9 relationships x 12 states', () => {
    expect(cases).toHaveLength(108);
  });

  it('a lock only ever turns a student into LOCKED and everybody else (but the teachers) into NOT_FOUND', () => {
    const locked = COMBOS.filter((c) => c.locked);
    const seen = new Set<string>();
    for (const relationship of COURSE_RELATIONSHIPS)
      for (const combo of locked) {
        const index = COMBOS.indexOf(combo);
        seen.add(`${relationship}:${cells(GRID[relationship])[index]}`);
      }
    expect([...seen].sort()).toEqual(
      [
        'OWNER:V',
        'ASSISTANT:V',
        'STUDENT_ACTIVE:L',
        'STUDENT_LEFT:L',
        'STUDENT_PENDING:L',
        'INVITEE:N',
        'REMOVED:N',
        'REJECTED:N',
        'NONE:N',
      ].sort(),
    );
  });
});

describe('relationshipOf (precedence)', () => {
  it('a teacher row wins over everything else', () => {
    expect(relationshipOf('OWNER', 'ACTIVE', true)).toBe('OWNER');
    expect(relationshipOf('ASSISTANT', undefined, false)).toBe('ASSISTANT');
  });

  it.each([
    ['ACTIVE', 'STUDENT_ACTIVE'],
    ['PENDING', 'STUDENT_PENDING'],
    ['LEFT', 'STUDENT_LEFT'],
    ['REMOVED', 'REMOVED'],
    ['REJECTED', 'REJECTED'],
  ] as const)(
    'enrollment %s without an invitation is %s',
    (status, expected) => {
      expect(relationshipOf(undefined, status, false)).toBe(expected);
    },
  );

  it('a valid invitation makes a REMOVED or REJECTED student (or a stranger) an INVITEE, but never overrides ACTIVE/PENDING/LEFT', () => {
    expect(relationshipOf(undefined, 'REMOVED', true)).toBe('INVITEE');
    expect(relationshipOf(undefined, 'REJECTED', true)).toBe('INVITEE');
    expect(relationshipOf(undefined, undefined, true)).toBe('INVITEE');
    expect(relationshipOf(undefined, 'ACTIVE', true)).toBe('STUDENT_ACTIVE');
    expect(relationshipOf(undefined, 'PENDING', true)).toBe('STUDENT_PENDING');
    expect(relationshipOf(undefined, 'LEFT', true)).toBe('STUDENT_LEFT');
  });

  it('no teacher row, no enrollment, no invitation is NONE', () => {
    expect(relationshipOf(undefined, undefined, false)).toBe('NONE');
  });
});
