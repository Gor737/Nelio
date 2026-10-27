import type { PrismaClient } from '../../generated/prisma/client.js';
import { ApiException } from '../filters/api-exception.js';

/**
 * The state check every teacher mutation of course content or settings makes AFTER the guards (docs/architecture.md section 12,
 * Decision 140): an Admin lock is 409 `COURSE_ADMIN_LOCKED` and takes precedence over 409 `COURSE_ARCHIVED`. The course is read
 * inside the caller's transaction, after any Course lock it took, so the state is the one the mutation will run against. A course
 * that does not exist (deleted meanwhile) is 404.
 */
export async function assertCourseMutable(
  db: Pick<PrismaClient, '$queryRaw'>,
  courseId: string,
): Promise<void> {
  const rows = await db.$queryRaw<
    { status: string; locked_by_admin_at: Date | null }[]
  >`SELECT status, locked_by_admin_at FROM courses WHERE id = ${courseId}::uuid`;
  const course = rows[0];
  if (!course) throw new ApiException('NOT_FOUND');
  if (course.locked_by_admin_at !== null)
    throw new ApiException('COURSE_ADMIN_LOCKED', { status: 409 });
  if (course.status === 'ARCHIVED') throw new ApiException('COURSE_ARCHIVED');
}
