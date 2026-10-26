import { Injectable } from '@nestjs/common';
import { TransactionService } from '../../../infrastructure/database/index.js';
import {
  type AdminCourseDetailDto,
  type AdminCoursesPageDto,
  type AdminCoursesQueryDto,
  CourseAdminService,
  CourseTeamService,
} from '../../courses/index.js';
import type { LessonTeacherDto, OutlineDto } from '../../content/index.js';
import { EnrollmentsService } from '../../enrollments/index.js';

/**
 * Admin: courses (Decisions 10, 40, 133, 134, 138, 141). Each write is one transaction that calls the owner's primitive: Courses for the
 * takedown and the ownership transfer, Enrollments for removing and reinstating a student. Admin has no rules of its own here.
 */
@Injectable()
export class AdminCoursesService {
  constructor(
    private readonly transactions: TransactionService,
    private readonly courses: CourseAdminService,
    private readonly team: CourseTeamService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  list(query: AdminCoursesQueryDto): Promise<AdminCoursesPageDto> {
    return this.courses.list(query);
  }

  get(courseId: string): Promise<AdminCourseDetailDto> {
    return this.courses.get(courseId);
  }

  outline(courseId: string): Promise<OutlineDto> {
    return this.courses.outline(courseId);
  }

  lesson(courseId: string, lessonId: string): Promise<LessonTeacherDto> {
    return this.courses.lesson(courseId, lessonId);
  }

  async lock(
    actorId: string,
    courseId: string,
    reason: string,
  ): Promise<AdminCourseDetailDto> {
    await this.transactions.run((tx) =>
      this.courses.lockInTx(tx, { courseId, actorId, reason }),
    );
    return this.courses.get(courseId);
  }

  async unlock(
    actorId: string,
    courseId: string,
  ): Promise<AdminCourseDetailDto> {
    await this.transactions.run((tx) =>
      this.courses.unlockInTx(tx, { courseId, actorId }),
    );
    return this.courses.get(courseId);
  }

  async restore(
    actorId: string,
    courseId: string,
  ): Promise<AdminCourseDetailDto> {
    await this.transactions.run((tx) =>
      this.courses.restoreInTx(tx, { courseId, actorId }),
    );
    return this.courses.get(courseId);
  }

  /** On behalf of an unreachable Owner (Decision 10): same primitive as the Owner's own transfer, without the Owner check. */
  async transferOwnership(
    actorId: string,
    courseId: string,
    newOwnerId: string,
  ): Promise<AdminCourseDetailDto> {
    await this.transactions.run((tx) =>
      this.team.transferOwnershipInTx(tx, {
        courseId,
        newOwnerId,
        actorId,
        actorIsOwner: false,
      }),
    );
    return this.courses.get(courseId);
  }

  removeStudent(
    actorId: string,
    courseId: string,
    studentId: string,
  ): Promise<void> {
    return this.enrollments.remove(actorId, courseId, studentId);
  }

  reinstateStudent(
    actorId: string,
    courseId: string,
    studentId: string,
  ): Promise<void> {
    return this.enrollments.reinstate(actorId, courseId, studentId);
  }
}
