import { Injectable } from '@nestjs/common';
import { TEXT_LIMITS } from '../../../common/constants/limits.js';
import { isValidText } from '../../../common/decorators/text-length.decorator.js';
import { ApiException } from '../../../common/filters/index.js';
import {
  PrismaService,
  type Tx,
} from '../../../infrastructure/database/index.js';
import { normalizeTagPrefix } from './tag-normalizer.js';

export interface CategoryRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface AdminTagRecord extends CategoryRecord {
  readonly courseCount: number;
}

export interface TagMergeResult {
  readonly sourceId: string;
  readonly targetId: string;
  /** Courses that had only the source tag and now carry the target. */
  readonly moved: number;
  /** Courses that already carried the target: their source link is simply dropped. */
  readonly alreadyTagged: number;
}

const invalid = (field: string, message: string): ApiException =>
  new ApiException('VALIDATION_FAILED', {
    errors: [{ field, messages: [message] }],
  });

/** LIKE special characters in an Admin's search are literals. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

/**
 * Admin writes to the catalog (categories and the tag merge). The Admin module composes these inside ITS transaction and writes the
 * audit row there (the audit names `CATEGORY_*` and `TAG_MERGED` belong to Admin); Catalog stays the only writer of `Category`, `Tag` and
 * `CourseTag`. A category name keeps its capitalization; its slug is the canonical lower-case form that tags use (two names that differ only
 * in case, spacing or Unicode composition are the same category).
 */
@Injectable()
export class CatalogAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async createCategory(tx: Tx, rawName: unknown): Promise<CategoryRecord> {
    const { name, slug } = this.categoryName(rawName);
    const rows = await tx.$queryRaw<CategoryRecord[]>`
      INSERT INTO categories (name, slug) VALUES (${name}, ${slug})
      ON CONFLICT (slug) DO NOTHING
      RETURNING id, name, slug`;
    if (rows.length === 0) throw this.duplicate();
    return rows[0];
  }

  async renameCategory(
    tx: Tx,
    id: string,
    rawName: unknown,
  ): Promise<{ before: CategoryRecord; after: CategoryRecord }> {
    const { name, slug } = this.categoryName(rawName);
    const before = await tx.$queryRaw<CategoryRecord[]>`
      SELECT id, name, slug FROM categories WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
    if (before.length === 0) throw new ApiException('NOT_FOUND');
    const clash = await tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM categories WHERE slug = ${slug} AND id <> ${id}::uuid`;
    if (clash.length > 0) throw this.duplicate();
    const after = await tx.$queryRaw<CategoryRecord[]>`
      UPDATE categories SET name = ${name}, slug = ${slug}, updated_at = now() WHERE id = ${id}::uuid RETURNING id, name, slug`;
    return { before: before[0], after: after[0] };
  }

  /** A category that a course still uses cannot be deleted (RESTRICT): 409 with the count. */
  async deleteCategory(tx: Tx, id: string): Promise<CategoryRecord> {
    const rows = await tx.$queryRaw<(CategoryRecord & { used: number })[]>`
      SELECT c.id, c.name, c.slug, (SELECT count(*)::int FROM courses WHERE category_id = c.id) AS used
        FROM categories c WHERE c.id = ${id}::uuid FOR NO KEY UPDATE`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    if (rows[0].used > 0)
      throw new ApiException('RESOURCE_CONFLICT', {
        message: `${rows[0].used} course(s) still use this category; move them first`,
      });
    await tx.$executeRaw`DELETE FROM categories WHERE id = ${id}::uuid`;
    return { id: rows[0].id, name: rows[0].name, slug: rows[0].slug };
  }

  /** Tags with the number of courses that carry each, most used first; `q` is a literal prefix of the slug. */
  async listTags(
    q: string | undefined,
    page: { limit: number; offset: number },
  ): Promise<{ items: AdminTagRecord[]; total: number }> {
    const prefix = q ? `${escapeLike(normalizeTagPrefix(q))}%` : null;
    const rows = await this.prisma.$queryRaw<
      (CategoryRecord & { course_count: number; total: number })[]
    >`
      SELECT t.id, t.name, t.slug, count(ct.course_id)::int AS course_count, count(*) OVER ()::int AS total
        FROM tags t LEFT JOIN course_tags ct ON ct.tag_id = t.id
       WHERE (${prefix}::text IS NULL OR t.slug LIKE ${prefix}::text ESCAPE '\\')
       GROUP BY t.id
       ORDER BY course_count DESC, t.name ASC, t.id ASC
       LIMIT ${page.limit} OFFSET ${page.offset}`;
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        courseCount: r.course_count,
      })),
      total: rows[0]?.total ?? 0,
    };
  }

  /**
   * Merges `sourceId` into `targetId`: every course with the source tag gets the target (courses that already have it are skipped), then the
   * source tag is deleted. Both tag rows are locked in ascending id order, so two merges that name the same tags (also in opposite
   * directions) serialize instead of deadlocking, and the second finds its source gone (404). A course owner tagging the source at the same
   * instant gets the documented foreign-key conflict (409, retry; docs/architecture.md section 15).
   */
  async mergeTags(
    tx: Tx,
    sourceId: string,
    targetId: string,
  ): Promise<{
    source: CategoryRecord;
    target: CategoryRecord;
    result: TagMergeResult;
  }> {
    if (sourceId === targetId)
      throw invalid('targetTagId', 'A tag cannot be merged into itself');
    const locked = await tx.$queryRaw<CategoryRecord[]>`
      SELECT id, name, slug FROM tags WHERE id IN (${sourceId}::uuid, ${targetId}::uuid) ORDER BY id FOR NO KEY UPDATE`;
    const source = locked.find((t) => t.id === sourceId);
    const target = locked.find((t) => t.id === targetId);
    if (!source || !target) throw new ApiException('NOT_FOUND');
    const inserted = await tx.$executeRaw`
      INSERT INTO course_tags (course_id, tag_id)
      SELECT course_id, ${targetId}::uuid FROM course_tags WHERE tag_id = ${sourceId}::uuid ORDER BY course_id
      ON CONFLICT (course_id, tag_id) DO NOTHING`;
    const total = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM course_tags WHERE tag_id = ${sourceId}::uuid`;
    await tx.$executeRaw`DELETE FROM tags WHERE id = ${sourceId}::uuid`; // its links go with it (CASCADE)
    return {
      source,
      target,
      result: {
        sourceId,
        targetId,
        moved: inserted,
        alreadyTagged: total[0].n - inserted,
      },
    };
  }

  private categoryName(raw: unknown): { name: string; slug: string } {
    if (typeof raw !== 'string') throw invalid('name', 'name must be a string');
    const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (!isValidText(name, TEXT_LIMITS.CATEGORY_NAME))
      throw invalid(
        'name',
        `name must be between ${TEXT_LIMITS.CATEGORY_NAME.min} and ${TEXT_LIMITS.CATEGORY_NAME.max} characters`,
      );
    const slug = normalizeTagPrefix(name).replace(/-+$/, '');
    if (!/[\p{L}\p{N}]/u.test(slug))
      throw invalid('name', 'name must contain at least one letter or digit');
    return { name, slug };
  }

  private duplicate(): ApiException {
    return new ApiException('RESOURCE_CONFLICT', {
      message: 'A category with this name already exists',
    });
  }
}
