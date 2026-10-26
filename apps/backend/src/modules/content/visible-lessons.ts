import { Prisma } from '../../generated/prisma/client.js';
import type { CourseRelationship } from '../../common/constants/permission-matrix.js';

const ALIAS = /^[a-z][a-z0-9_]{0,15}$/;

/**
 * The single definition of "which lessons this caller may see" (Decision 103, architecture section 7 rule 7), as a SQL condition for
 * the `lessons` table under `alias`:
 * - the Owner and Assistants see every status;
 * - an ACTIVE student sees PUBLISHED lessons only (also on an archived course);
 * - every other relationship sees none (a LEFT, pending, removed or unrelated user gets no content).
 * Anything that reads lessons on behalf of a user (outline, lesson, download, and later Courses and Enrollments) uses this, so the
 * rule cannot drift between endpoints. The alias is checked against a pattern: it is the only text that is not a bound parameter.
 */
export function visibleLessonWhere(
  relationship: CourseRelationship,
  alias = 'l',
): Prisma.Sql {
  if (!ALIAS.test(alias))
    throw new TypeError('visibleLessonWhere: invalid table alias');
  switch (relationship) {
    case 'OWNER':
    case 'ASSISTANT':
      return Prisma.sql`TRUE`;
    case 'STUDENT_ACTIVE':
      return Prisma.sql`${Prisma.raw(alias)}.status = 'PUBLISHED'`;
    default:
      return Prisma.sql`FALSE`;
  }
}

/** Teachers see every lesson status and the structure around it; a student's view is limited to published lessons. */
export const isTeacherRelationship = (
  relationship: CourseRelationship,
): boolean => relationship === 'OWNER' || relationship === 'ASSISTANT';
