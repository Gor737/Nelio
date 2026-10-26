import { Prisma } from '../../../generated/prisma/client.js';
import { ApiException } from '../../../common/filters/index.js';
import type { Tx } from '../../../infrastructure/database/index.js';

/** The three ordered lists of the Content module: the table, its parent column and the parent's lock is the caller's. */
const LISTS = {
  sections: { table: 'sections', parent: 'course_id' },
  lessons: { table: 'lessons', parent: 'section_id' },
  blocks: { table: 'content_blocks', parent: 'lesson_id' },
} as const;
export type OrderedList = keyof typeof LISTS;

/**
 * Full-list reorder (Decision 67). The client sends the complete ordered list of ids; the list is validated against the CURRENT list
 * and rewritten in one statement. A stale list (an item added, removed or moved to another parent since the client loaded) or a list
 * with duplicates or foreign ids is 409 `ORDER_MISMATCH`, never a partial write. The caller has locked the parent row (the lock is
 * the reason two reorders cannot interleave) and has already checked that the course is mutable.
 */
export async function reorderFullList(
  tx: Tx,
  list: OrderedList,
  parentId: string,
  ids: readonly string[],
): Promise<void> {
  const { table, parent } = LISTS[list];
  const tableSql = Prisma.raw(`"${table}"`);
  const parentSql = Prisma.raw(`"${parent}"`);
  const current = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM ${tableSql} WHERE ${parentSql} = ${parentId}::uuid ORDER BY position, id`;
  const wanted = ids.map((id) => id.toLowerCase());
  const same =
    wanted.length === current.length &&
    new Set(wanted).size === wanted.length &&
    current.every((row) => wanted.includes(row.id));
  if (!same)
    throw new ApiException('ORDER_MISMATCH', {
      message: 'The list changed since you loaded it; reload and try again',
    });
  if (wanted.length === 0) return;
  await tx.$executeRaw`
    UPDATE ${tableSql} t SET position = x.pos - 1, updated_at = now()
      FROM unnest(${wanted}::uuid[]) WITH ORDINALITY AS x(id, pos)
     WHERE t.id = x.id AND t.${parentSql} = ${parentId}::uuid`;
}
