import { Injectable } from '@nestjs/common';
import type { CourseRelationship } from '../../../common/constants/permission-matrix.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infrastructure/database/index.js';
import type {
  LessonStatusName,
  OutlineDto,
  OutlineLessonDto,
  SyllabusSectionDto,
} from '../dto/content.dto.js';
import {
  isTeacherRelationship,
  visibleLessonWhere,
} from '../visible-lessons.js';

type Db = Pick<PrismaClient, '$queryRaw'>;

interface Row {
  section_id: string;
  section_title: string;
  section_position: number;
  lesson_id: string | null;
  lesson_title: string | null;
  lesson_position: number | null;
  lesson_status: LessonStatusName | null;
  block_count: number | null;
}

/**
 * The structure of a course. The OUTLINE is for the people who work in the course (teachers: every lesson with its status and block
 * count; an ACTIVE student: published lessons only, no lifecycle fields; sections with nothing a student may open are left out). The
 * SYLLABUS is the public version for visitors: titles of published lessons, never content. Both are one statement.
 */
@Injectable()
export class OutlineService {
  constructor(private readonly prisma: PrismaService) {}

  async outline(
    courseId: string,
    relationship: CourseRelationship,
  ): Promise<OutlineDto> {
    const teacher = isTeacherRelationship(relationship);
    const rows = await this.rows(this.prisma, courseId, relationship);
    const sections = new Map<string, OutlineDto['sections'][number]>();
    for (const row of rows) {
      let section = sections.get(row.section_id);
      if (!section) {
        section = {
          id: row.section_id,
          title: row.section_title,
          position: row.section_position,
          lessons: [],
        };
        sections.set(row.section_id, section);
      }
      if (row.lesson_id !== null) {
        const lesson: OutlineLessonDto = {
          id: row.lesson_id,
          title: row.lesson_title as string,
          position: row.lesson_position as number,
        };
        if (teacher) {
          lesson.status = row.lesson_status as LessonStatusName;
          lesson.blockCount = row.block_count ?? 0;
        }
        section.lessons.push(lesson);
      }
    }
    const list = [...sections.values()];
    return {
      sections: teacher ? list : list.filter((s) => s.lessons.length > 0),
    };
  }

  /** Public syllabus (Decision 73): published lesson titles only; a section without a published lesson is not listed. */
  async syllabus(
    courseId: string,
    db: Db = this.prisma,
  ): Promise<SyllabusSectionDto[]> {
    const rows = await this.rows(db, courseId, 'STUDENT_ACTIVE');
    const sections = new Map<string, SyllabusSectionDto>();
    for (const row of rows) {
      if (row.lesson_id === null) continue;
      let section = sections.get(row.section_id);
      if (!section) {
        section = { id: row.section_id, title: row.section_title, lessons: [] };
        sections.set(row.section_id, section);
      }
      section.lessons.push({
        id: row.lesson_id,
        title: row.lesson_title as string,
      });
    }
    return [...sections.values()];
  }

  private rows(
    db: Db,
    courseId: string,
    relationship: CourseRelationship,
  ): Promise<Row[]> {
    const visible = visibleLessonWhere(relationship, 'l');
    return db.$queryRaw<Row[]>`
      SELECT s.id AS section_id, s.title AS section_title, s.position AS section_position,
             l.id AS lesson_id, l.title AS lesson_title, l.position AS lesson_position, l.status AS lesson_status,
             (SELECT count(*)::int FROM content_blocks b WHERE b.lesson_id = l.id) AS block_count
        FROM sections s
        LEFT JOIN lessons l ON l.section_id = s.id AND ${visible}
       WHERE s.course_id = ${courseId}::uuid
       ORDER BY s.position, s.id, l.position, l.id`;
  }
}
