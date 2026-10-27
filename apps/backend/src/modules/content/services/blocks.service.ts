import { Injectable } from '@nestjs/common';
import { assertCourseMutable } from '../../../common/access/index.js';
import type { CourseRelationship } from '../../../common/constants/permission-matrix.js';
import { ApiException } from '../../../common/filters/index.js';
import {
  PrismaService,
  TransactionService,
  type Tx,
  isUniqueViolation,
} from '../../../infrastructure/database/index.js';
import { FilesService, type SignedUrlDto } from '../../files/index.js';
import type { BlockTypeName, ContentBlockDto } from '../dto/content.dto.js';
import { visibleLessonWhere } from '../visible-lessons.js';
import { readBlocks } from './block-reader.js';
import { reorderFullList } from './reorder.js';
import { parseVideoUrl } from './video-url.js';

export interface CreateBlockInput {
  readonly type: BlockTypeName;
  readonly textBody?: string;
  readonly videoUrl?: string;
  readonly fileId?: string;
}

const invalid = (field: string, message: string): ApiException =>
  new ApiException('VALIDATION_FAILED', {
    errors: [{ field, messages: [message] }],
  });

/**
 * Content blocks of a lesson: TEXT (Markdown stored as text), VIDEO (YouTube or Vimeo, provider + id stored, the embed URL built on
 * the server) and FILE (a LESSON_ATTACHMENT the teacher uploaded, used by at most one block). Every change locks the Lesson row, so
 * parallel appends get different positions and a reorder cannot interleave with an append.
 */
@Injectable()
export class BlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly files: FilesService,
  ) {}

  async create(
    courseId: string,
    lessonId: string,
    actorId: string,
    input: CreateBlockInput,
  ): Promise<ContentBlockDto> {
    const payload = this.checkShape(input);
    try {
      return await this.transactions.run(async (tx) => {
        await this.lockLesson(tx, courseId, lessonId);
        await assertCourseMutable(tx, courseId);
        if (payload.type === 'FILE')
          await this.assertUsableFile(tx, payload.fileId, actorId);
        const rows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO content_blocks (lesson_id, position, type, text_body, video_provider, video_external_id, file_id)
          VALUES (${lessonId}::uuid,
                  (SELECT COALESCE(MAX(position) + 1, 0) FROM content_blocks WHERE lesson_id = ${lessonId}::uuid),
                  ${payload.type}::content_block_type,
                  ${payload.type === 'TEXT' ? payload.textBody : null},
                  ${payload.type === 'VIDEO' ? payload.provider : null}::video_provider,
                  ${payload.type === 'VIDEO' ? payload.externalId : null},
                  ${payload.type === 'FILE' ? payload.fileId : null}::uuid)
          RETURNING id`;
        return this.readOne(tx, lessonId, rows[0].id);
      });
    } catch (error) {
      // a file used by another block: the unique index on `file_id` (the check above is for the friendly path, this is the race)
      if (isUniqueViolation(error))
        throw new ApiException('RESOURCE_CONFLICT', {
          message: 'This file is already used by another block',
        });
      throw error;
    }
  }

  /** Changes a TEXT block's text or a VIDEO block's link. A FILE block cannot change its file: delete it and add a new one. */
  async update(
    courseId: string,
    lessonId: string,
    blockId: string,
    input: { textBody?: string; videoUrl?: string },
  ): Promise<ContentBlockDto> {
    return this.transactions.run(async (tx) => {
      await this.lockLesson(tx, courseId, lessonId);
      const rows = await tx.$queryRaw<{ type: BlockTypeName }[]>`
        SELECT type FROM content_blocks WHERE id = ${blockId}::uuid AND lesson_id = ${lessonId}::uuid FOR NO KEY UPDATE`;
      if (rows.length === 0) throw new ApiException('NOT_FOUND');
      await assertCourseMutable(tx, courseId);
      const { type } = rows[0];
      if (type === 'TEXT') {
        if (input.videoUrl !== undefined)
          throw invalid('videoUrl', 'A text block has no video');
        if (input.textBody === undefined)
          throw invalid('textBody', 'textBody is required');
        await tx.$executeRaw`
          UPDATE content_blocks SET text_body = ${input.textBody}, updated_at = now() WHERE id = ${blockId}::uuid`;
      } else if (type === 'VIDEO') {
        if (input.textBody !== undefined)
          throw invalid('textBody', 'A video block has no text');
        if (input.videoUrl === undefined)
          throw invalid('videoUrl', 'videoUrl is required');
        const video = this.parseVideo(input.videoUrl);
        await tx.$executeRaw`
          UPDATE content_blocks SET video_provider = ${video.provider}::video_provider, video_external_id = ${video.externalId},
                 updated_at = now() WHERE id = ${blockId}::uuid`;
      } else {
        throw invalid(
          'type',
          'A file block cannot be changed; delete it and add a new one',
        );
      }
      return this.readOne(tx, lessonId, blockId);
    });
  }

  async delete(
    courseId: string,
    lessonId: string,
    blockId: string,
  ): Promise<void> {
    await this.transactions.run(async (tx) => {
      await this.lockLesson(tx, courseId, lessonId);
      await assertCourseMutable(tx, courseId);
      const deleted = await tx.$executeRaw`
        DELETE FROM content_blocks WHERE id = ${blockId}::uuid AND lesson_id = ${lessonId}::uuid`;
      if (deleted === 0) throw new ApiException('NOT_FOUND');
    });
  }

  async reorder(
    courseId: string,
    lessonId: string,
    ids: readonly string[],
  ): Promise<void> {
    await this.transactions.run(async (tx) => {
      await this.lockLesson(tx, courseId, lessonId);
      await assertCourseMutable(tx, courseId);
      await reorderFullList(tx, 'blocks', lessonId, ids);
    });
  }

  /**
   * A short-lived signed link for a FILE block. It re-checks on EVERY request that the caller may see this lesson (the lesson is in
   * this course and visible to the caller's relationship: a student gets 404 for a lesson that is not published, also here), then signs.
   */
  async download(
    courseId: string,
    lessonId: string,
    blockId: string,
    relationship: CourseRelationship,
  ): Promise<SignedUrlDto> {
    const visible = visibleLessonWhere(relationship, 'l');
    const rows = await this.prisma.$queryRaw<{ file_id: string | null }[]>`
      SELECT b.file_id FROM content_blocks b JOIN lessons l ON l.id = b.lesson_id
       WHERE b.id = ${blockId}::uuid AND l.id = ${lessonId}::uuid AND l.course_id = ${courseId}::uuid
         AND b.type = 'FILE' AND ${visible}`;
    if (rows.length === 0 || rows[0].file_id === null)
      throw new ApiException('NOT_FOUND');
    return this.files.signedDownload(rows[0].file_id);
  }

  private checkShape(
    input: CreateBlockInput,
  ):
    | { type: 'TEXT'; textBody: string }
    | { type: 'VIDEO'; provider: 'YOUTUBE' | 'VIMEO'; externalId: string }
    | { type: 'FILE'; fileId: string } {
    const extra = (names: (keyof CreateBlockInput)[]) => {
      for (const name of names)
        if (input[name] !== undefined)
          throw invalid(
            name,
            `${name} does not belong to a ${input.type} block`,
          );
    };
    if (input.type === 'TEXT') {
      extra(['videoUrl', 'fileId']);
      return { type: 'TEXT', textBody: input.textBody as string };
    }
    if (input.type === 'VIDEO') {
      extra(['textBody', 'fileId']);
      return { type: 'VIDEO', ...this.parseVideo(input.videoUrl as string) };
    }
    extra(['textBody', 'videoUrl']);
    return { type: 'FILE', fileId: input.fileId as string };
  }

  private parseVideo(url: string) {
    const video = parseVideoUrl(url);
    if (!video)
      throw invalid(
        'videoUrl',
        'Only YouTube and Vimeo video links are supported',
      );
    return video;
  }

  /** A FILE block needs a LESSON_ATTACHMENT that this teacher uploaded and that no other block uses. */
  private async assertUsableFile(
    tx: Tx,
    fileId: string,
    actorId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ kind: string; uploaded_by: string }[]>`
      SELECT kind, uploaded_by FROM file_assets WHERE id = ${fileId}::uuid`;
    if (rows.length === 0 || rows[0].uploaded_by !== actorId)
      throw new ApiException('NOT_FOUND');
    if (rows[0].kind !== 'LESSON_ATTACHMENT')
      throw invalid('fileId', 'The file must be a lesson attachment');
    const used = await tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM content_blocks WHERE file_id = ${fileId}::uuid`;
    if (used.length > 0)
      throw new ApiException('RESOURCE_CONFLICT', {
        message: 'This file is already used by another block',
      });
  }

  private async lockLesson(
    tx: Tx,
    courseId: string,
    lessonId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM lessons WHERE id = ${lessonId}::uuid AND course_id = ${courseId}::uuid FOR NO KEY UPDATE`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
  }

  private async readOne(
    tx: Tx,
    lessonId: string,
    blockId: string,
  ): Promise<ContentBlockDto> {
    const block = (await readBlocks(tx, lessonId)).find(
      (b) => b.id === blockId,
    );
    if (!block) throw new ApiException('NOT_FOUND');
    return block;
  }
}
