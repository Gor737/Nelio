import { Injectable } from '@nestjs/common';
import { assertCourseMutable } from '../../../common/access/index.js';
import { ApiException } from '../../../common/filters/index.js';
import {
  PrismaService,
  TransactionService,
  lockRow,
} from '../../../infrastructure/database/index.js';
import type { SectionDto } from '../dto/content.dto.js';
import { reorderFullList } from './reorder.js';

interface SectionRow {
  id: string;
  title: string;
  position: number;
}

const toDto = (row: SectionRow): SectionDto => ({
  id: row.id,
  title: row.title,
  position: row.position,
});

/**
 * Sections of a course. Changing the list of sections (append, reorder, delete) takes the Course row exclusively (Course-X, architecture
 * section 15), so a student's progress and a structure change cannot interleave; a rename touches one row and takes no lock (the accepted
 * "content edit beside an archive" race). Every mutation then checks the course is mutable: 409 `COURSE_ADMIN_LOCKED` before 409
 * `COURSE_ARCHIVED`.
 */
@Injectable()
export class SectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
  ) {}

  async create(courseId: string, title: string): Promise<SectionDto> {
    return this.transactions.run(async (tx) => {
      if (!(await lockRow(tx, 'course', courseId, 'NO_KEY_UPDATE')))
        throw new ApiException('NOT_FOUND');
      await assertCourseMutable(tx, courseId);
      const rows = await tx.$queryRaw<SectionRow[]>`
        INSERT INTO sections (course_id, title, position)
        VALUES (${courseId}::uuid, ${title},
                (SELECT COALESCE(MAX(position) + 1, 0) FROM sections WHERE course_id = ${courseId}::uuid))
        RETURNING id, title, position`;
      return toDto(rows[0]);
    });
  }

  async rename(
    courseId: string,
    sectionId: string,
    title: string,
  ): Promise<SectionDto> {
    const rows = await this.prisma.$queryRaw<SectionRow[]>`
      SELECT id, title, position FROM sections WHERE id = ${sectionId}::uuid AND course_id = ${courseId}::uuid`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    await assertCourseMutable(this.prisma, courseId);
    const updated = await this.prisma.$queryRaw<SectionRow[]>`
      UPDATE sections SET title = ${title}, updated_at = now()
       WHERE id = ${sectionId}::uuid AND course_id = ${courseId}::uuid
      RETURNING id, title, position`;
    if (updated.length === 0) throw new ApiException('NOT_FOUND');
    return toDto(updated[0]);
  }

  async reorder(courseId: string, ids: readonly string[]): Promise<void> {
    await this.transactions.run(async (tx) => {
      if (!(await lockRow(tx, 'course', courseId, 'NO_KEY_UPDATE')))
        throw new ApiException('NOT_FOUND');
      await assertCourseMutable(tx, courseId);
      await reorderFullList(tx, 'sections', courseId, ids);
    });
  }

  /** Only an empty section can be deleted; lessons are deleted (or moved) first, each under its own rules. */
  async delete(courseId: string, sectionId: string): Promise<void> {
    await this.transactions.run(async (tx) => {
      if (!(await lockRow(tx, 'course', courseId, 'NO_KEY_UPDATE')))
        throw new ApiException('NOT_FOUND');
      const found = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM sections WHERE id = ${sectionId}::uuid AND course_id = ${courseId}::uuid FOR NO KEY UPDATE`;
      if (found.length === 0) throw new ApiException('NOT_FOUND');
      await assertCourseMutable(tx, courseId);
      const lessons = await tx.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM lessons WHERE section_id = ${sectionId}::uuid LIMIT 1`;
      if (lessons.length > 0)
        throw new ApiException('RESOURCE_CONFLICT', {
          message: 'The section still has lessons; delete or move them first',
        });
      await tx.$executeRaw`DELETE FROM sections WHERE id = ${sectionId}::uuid`;
    });
  }
}
