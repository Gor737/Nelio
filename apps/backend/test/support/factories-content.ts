// Factories for schema group G3 (sections, lessons, content blocks): direct INSERTs through the pool.
import type { Queryable } from './database.js';
import { unique } from './factories.js';

export async function createSection(
  q: Queryable,
  courseId: string,
  overrides: { title?: string; position?: number } = {},
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    'INSERT INTO sections (course_id, title, position) VALUES ($1, $2, $3) RETURNING id',
    [
      courseId,
      overrides.title ?? `Section ${unique()}`,
      overrides.position ?? 0,
    ],
  );
  return rows[0].id;
}

export interface LessonOverrides {
  title?: string;
  position?: number;
  status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  firstPublishedAt?: Date | null;
}

/** A lesson in `sectionId` of `courseId`. Defaults to a DRAFT; a PUBLISHED lesson gets first_published_at unless overridden. */
export async function createLesson(
  q: Queryable,
  courseId: string,
  sectionId: string,
  overrides: LessonOverrides = {},
): Promise<string> {
  const status = overrides.status ?? 'DRAFT';
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO lessons (course_id, section_id, title, position, status, first_published_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      courseId,
      sectionId,
      overrides.title ?? `Lesson ${unique()}`,
      overrides.position ?? 0,
      status,
      'firstPublishedAt' in overrides
        ? overrides.firstPublishedAt
        : status === 'DRAFT'
          ? null
          : new Date(),
    ],
  );
  return rows[0].id;
}

export interface BlockOverrides {
  position?: number;
  type?: 'TEXT' | 'VIDEO' | 'FILE';
  textBody?: string | null;
  videoProvider?: 'YOUTUBE' | 'VIMEO' | null;
  videoExternalId?: string | null;
  fileId?: string | null;
}

/** A content block with exactly the given columns (no defaults filled in beyond `position`), so any combination can be tried. */
export async function createBlock(
  q: Queryable,
  lessonId: string,
  overrides: BlockOverrides & { type: 'TEXT' | 'VIDEO' | 'FILE' },
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO content_blocks (lesson_id, position, type, text_body, video_provider, video_external_id, file_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      lessonId,
      overrides.position ?? 0,
      overrides.type,
      overrides.textBody ?? null,
      overrides.videoProvider ?? null,
      overrides.videoExternalId ?? null,
      overrides.fileId ?? null,
    ],
  );
  return rows[0].id;
}

export const createTextBlock = (
  q: Queryable,
  lessonId: string,
  textBody = 'Some **markdown** text',
) => createBlock(q, lessonId, { type: 'TEXT', textBody });

export const createVideoBlock = (q: Queryable, lessonId: string) =>
  createBlock(q, lessonId, {
    type: 'VIDEO',
    videoProvider: 'YOUTUBE',
    videoExternalId: 'dQw4w9WgXcQ',
  });

export const createFileBlock = (
  q: Queryable,
  lessonId: string,
  fileId: string,
) => createBlock(q, lessonId, { type: 'FILE', fileId });

/** A course with one section and one lesson: the smallest content tree. */
export async function createCourseTree(
  q: Queryable,
  createCourse: (q: Queryable) => Promise<string>,
  lessonOverrides: LessonOverrides = {},
): Promise<{ courseId: string; sectionId: string; lessonId: string }> {
  const courseId = await createCourse(q);
  const sectionId = await createSection(q, courseId);
  const lessonId = await createLesson(q, courseId, sectionId, lessonOverrides);
  return { courseId, sectionId, lessonId };
}
