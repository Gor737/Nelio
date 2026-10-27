import { Injectable } from '@nestjs/common';
import { COUNT_LIMITS } from '../../../common/constants/limits.js';
import {
  ApiException,
  type FieldError,
} from '../../../common/filters/index.js';
import type { Tx } from '../../../infrastructure/database/index.js';
import { type NormalizedTag, normalizeTag } from './tag-normalizer.js';

export interface CourseTag {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/**
 * The only writer of `Tag` and `CourseTag` (Catalog owns them). Courses calls `setCourseTags` inside ITS transaction, after it took the
 * Course row lock (Course-X: tags are settings, Owner-only), so nothing here takes a lock on the course.
 */
@Injectable()
export class CourseTagsService {
  /**
   * Replaces the tags of a course with exactly `rawNames`:
   *   1. every name is normalized (see `normalizeTag`); two spellings of one tag count once; a bad name or more than
   *      `COUNT_LIMITS.TAGS_PER_COURSE_MAX` distinct tags is 400 `VALIDATION_FAILED`, before anything is written;
   *   2. missing tags are created with ONE `INSERT ... ON CONFLICT (slug) DO NOTHING` whose rows are inserted in ascending slug order.
   *      Two transactions that create the same new tags at the same moment therefore never fail and never deadlock: the second waits
   *      for the first to commit, then finds the rows (the ascending order is the same lock order rule as everywhere else);
   *   3. links that are no longer wanted are deleted, new ones inserted (idempotently).
   * A tag merged by an Admin between steps 2 and 3 makes the link insert fail with a foreign-key error: 409, the caller retries (an
   * accepted race, docs/architecture.md section 15). Returns the tags of the course in the order given.
   */
  async setCourseTags(
    tx: Tx,
    courseId: string,
    rawNames: readonly unknown[],
  ): Promise<CourseTag[]> {
    const tags = this.normalizeAll(rawNames);

    let stored: { id: string; slug: string; name: string }[] = [];
    if (tags.length > 0) {
      const byAscendingSlug = [...tags].sort((a, b) =>
        a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
      );
      await tx.$executeRaw`
        INSERT INTO tags (name, slug)
        SELECT t.name, t.slug FROM unnest(${byAscendingSlug.map((t) => t.name)}::text[], ${byAscendingSlug.map((t) => t.slug)}::text[]) WITH ORDINALITY AS t(name, slug, position)
        ORDER BY t.position
        ON CONFLICT (slug) DO NOTHING`;
      stored = await tx.$queryRaw<{ id: string; slug: string; name: string }[]>`
        SELECT id, slug, name FROM tags WHERE slug = ANY(${tags.map((t) => t.slug)}::text[])`;
    }

    const idBySlug = new Map(stored.map((row) => [row.slug, row]));
    const ordered = tags
      .map((tag) => idBySlug.get(tag.slug))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    const ids = ordered.map((row) => row.id);

    await tx.$executeRaw`DELETE FROM course_tags WHERE course_id = ${courseId}::uuid AND tag_id <> ALL(${ids}::uuid[])`;
    if (ids.length > 0) {
      await tx.$executeRaw`
        INSERT INTO course_tags (course_id, tag_id)
        SELECT ${courseId}::uuid, t.id FROM unnest(${ids}::uuid[]) AS t(id)
        ON CONFLICT (course_id, tag_id) DO NOTHING`;
    }
    return ordered.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
    }));
  }

  /** Normalizes and de-duplicates (by slug, first spelling wins); throws 400 listing every bad entry. */
  private normalizeAll(rawNames: readonly unknown[]): NormalizedTag[] {
    const errors: FieldError[] = [];
    const bySlug = new Map<string, NormalizedTag>();
    if (!Array.isArray(rawNames)) {
      throw new ApiException('VALIDATION_FAILED', {
        message: 'Validation failed',
        errors: [{ field: 'tags', messages: ['tags must be an array'] }],
      });
    }
    rawNames.forEach((raw, index) => {
      const result = normalizeTag(raw);
      if (!result.ok)
        errors.push({
          field: `tags[${index}]`,
          messages: [`tag ${result.problem}`],
        });
      else if (!bySlug.has(result.tag.slug))
        bySlug.set(result.tag.slug, result.tag);
    });
    if (bySlug.size > COUNT_LIMITS.TAGS_PER_COURSE_MAX) {
      errors.push({
        field: 'tags',
        messages: [
          `a course can have at most ${COUNT_LIMITS.TAGS_PER_COURSE_MAX} tags`,
        ],
      });
    }
    if (errors.length > 0)
      throw new ApiException('VALIDATION_FAILED', {
        message: 'Validation failed',
        errors,
      });
    return [...bySlug.values()];
  }
}
