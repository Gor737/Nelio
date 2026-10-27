import { Injectable } from '@nestjs/common';
import { COUNT_LIMITS } from '../../../common/constants/limits.js';
import { PrismaService } from '../../../infrastructure/database/index.js';
import { normalizeTagPrefix } from './tag-normalizer.js';

export interface CategoryView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}
export type TagView = CategoryView;

/** Escapes the three characters that are special in a LIKE pattern, so that user input is always a literal prefix. */
const escapeLike = (value: string) =>
  value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Reads of the catalog (categories and tags). Categories are managed by Admins (M12); tags are created by Owners through `setCourseTags`. */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every category, by name. The list is Admin-managed and small, so it is not paginated. */
  listCategories(): Promise<CategoryView[]> {
    return this.prisma.category.findMany({
      select: { id: true, name: true, slug: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Tag autocomplete: tags whose slug starts with the normalized `q` (all tags when `q` is empty), the most used first, then by name;
   * at most `limit` (never more than `TAG_AUTOCOMPLETE_MAX_RESULTS`). The prefix is a literal: `%` and `_` typed by the user are not wildcards.
   */
  searchTags(
    q: string | undefined,
    limit: number = COUNT_LIMITS.TAG_AUTOCOMPLETE_MAX_RESULTS,
  ): Promise<TagView[]> {
    const capped = Math.min(
      Math.max(1, Math.trunc(limit)),
      COUNT_LIMITS.TAG_AUTOCOMPLETE_MAX_RESULTS,
    );
    const prefix = escapeLike(normalizeTagPrefix(q ?? ''));
    return this.prisma.$queryRaw<TagView[]>`
      SELECT t.id, t.name, t.slug
        FROM tags t
        LEFT JOIN course_tags ct ON ct.tag_id = t.id
       WHERE t.slug LIKE ${prefix + '%'} ESCAPE '\\'
       GROUP BY t.id
       ORDER BY count(ct.course_id) DESC, t.name ASC, t.id ASC
       LIMIT ${capped}`;
  }
}
