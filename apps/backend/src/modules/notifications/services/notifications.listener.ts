import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { NotificationType } from '../../../common/constants/notification-types.js';
import { PrismaService } from '../../../infrastructure/database/index.js';
import {
  EventBus,
  type EventContracts,
  type EventName,
  NOTIFICATION_EVENTS,
} from '../../../infrastructure/events/index.js';
import {
  NotificationWriter,
  type NewNotification,
} from './notification-writer.service.js';

/**
 * Turns the 12 domain events into notification rows (docs/architecture.md section 17; recipients per `NOTIFICATION_TYPES`).
 * Nobody imports this module: producers emit typed events after commit and this listens. Chat messages are not here (no event of
 * `message.*` is subscribed), they use read positions.
 *
 * The person who caused an event never receives a notification about their own action (an Owner who locks their own course as Admin, an
 * Admin who is also a course teacher).
 */
@Injectable()
export class NotificationsListener implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void)[] = [];

  constructor(
    private readonly bus: EventBus,
    private readonly prisma: PrismaService,
    private readonly writer: NotificationWriter,
  ) {}

  onModuleInit(): void {
    this.on('teacher-application.received', async (e) => {
      await this.send(
        await this.activeAdmins(),
        'TEACHER_APPLICATION_RECEIVED',
        e.applicantId,
      );
    });
    this.on('teacher-application.approved', async (e) =>
      this.send([e.applicantId], 'TEACHER_APPLICATION_APPROVED', e.decidedBy),
    );
    this.on('teacher-application.rejected', async (e) =>
      this.send([e.applicantId], 'TEACHER_APPLICATION_REJECTED', e.decidedBy),
    );
    this.on('teacher-role.revoked', async (e) =>
      this.send([e.userId], 'TEACHER_ROLE_REVOKED', e.revokedBy),
    );
    this.on('enrollment.requested', (e) =>
      this.forCourse(e.courseId, async (courseTitle) =>
        this.send(
          await this.courseTeachers(e.courseId),
          'ENROLLMENT_REQUESTED',
          e.studentId,
          {
            courseId: e.courseId,
            data: { courseTitle },
          },
        ),
      ),
    );
    this.on('enrollment.approved', (e) =>
      this.forCourse(e.courseId, (courseTitle) =>
        this.send([e.studentId], 'ENROLLMENT_APPROVED', e.decidedBy, {
          courseId: e.courseId,
          data: { courseTitle, reinstated: e.reinstated },
        }),
      ),
    );
    this.on('enrollment.rejected', (e) =>
      this.forCourse(e.courseId, (courseTitle) =>
        this.send([e.studentId], 'ENROLLMENT_REJECTED', e.decidedBy, {
          courseId: e.courseId,
          data: { courseTitle },
        }),
      ),
    );
    this.on('enrollment.removed', (e) =>
      this.forCourse(e.courseId, (courseTitle) =>
        this.send([e.studentId], 'REMOVED_FROM_COURSE', e.removedBy, {
          courseId: e.courseId,
          data: { courseTitle },
        }),
      ),
    );
    this.on('invitation.created', (e) =>
      this.forCourse(e.courseId, (courseTitle) =>
        this.send([e.inviteeId], 'INVITATION_RECEIVED', e.invitedBy, {
          courseId: e.courseId,
          data: { courseTitle },
        }),
      ),
    );
    this.on('lesson.first-published', (e) =>
      this.forCourse(e.courseId, async (courseTitle) => {
        const lesson = await this.prisma.$queryRaw<{ title: string }[]>`
          SELECT title FROM lessons WHERE id = ${e.lessonId}::uuid AND course_id = ${e.courseId}::uuid`;
        if (lesson.length === 0) return;
        await this.send(
          await this.activeStudents(e.courseId),
          'LESSON_PUBLISHED',
          null,
          {
            courseId: e.courseId,
            data: {
              courseTitle,
              lessonId: e.lessonId,
              lessonTitle: lesson[0].title,
            },
          },
        );
      }),
    );
    this.on('course.ownership-transferred', (e) =>
      this.forCourse(e.courseId, (courseTitle) =>
        this.send([e.newOwnerId], 'OWNERSHIP_TRANSFERRED', e.previousOwnerId, {
          courseId: e.courseId,
          data: { courseTitle },
        }),
      ),
    );
    this.on('course.admin-locked', (e) =>
      this.forCourse(e.courseId, async (courseTitle) =>
        this.send(
          await this.courseTeachers(e.courseId),
          'COURSE_ADMIN_LOCKED',
          e.lockedBy,
          {
            courseId: e.courseId,
            data: { courseTitle, reason: e.reason },
          },
        ),
      ),
    );
  }

  onModuleDestroy(): void {
    for (const stop of this.unsubscribe.splice(0)) stop();
  }

  /** The events this listener subscribed to (the test compares it with `NOTIFICATION_EVENTS`). */
  subscribedEvents(): EventName[] {
    return Object.values(NOTIFICATION_EVENTS).filter(
      (name) => this.bus.listenerCount(name) > 0,
    );
  }

  private on<N extends EventName>(
    name: N,
    handler: (payload: EventContracts[N]) => Promise<void> | void,
  ): void {
    this.unsubscribe.push(this.bus.on(name, handler));
  }

  private async send(
    recipientIds: readonly string[],
    type: NotificationType,
    actorId: string | null,
    extra: { courseId?: string; data?: NewNotification['data'] } = {},
  ): Promise<void> {
    await this.writer.write({
      type,
      recipientIds: recipientIds.filter((id) => id !== actorId),
      actorId,
      courseId: extra.courseId ?? null,
      data: extra.data ?? {},
    });
  }

  /** Runs `handler` with the course title; a course that no longer exists produces nothing. */
  private async forCourse(
    courseId: string,
    handler: (courseTitle: string) => Promise<void>,
  ): Promise<void> {
    const rows = await this.prisma.$queryRaw<{ title: string }[]>`
      SELECT title FROM courses WHERE id = ${courseId}::uuid`;
    if (rows.length === 0) return;
    await handler(rows[0].title);
  }

  private async activeAdmins(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT u.id FROM users u
        JOIN user_roles r ON r.user_id = u.id AND r.role = 'ADMIN' AND r.status = 'ACTIVE'
       WHERE u.status = 'ACTIVE'`;
    return rows.map((r) => r.id);
  }

  private async courseTeachers(courseId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM course_teachers WHERE course_id = ${courseId}::uuid`;
    return rows.map((r) => r.user_id);
  }

  private async activeStudents(courseId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM enrollments WHERE course_id = ${courseId}::uuid AND status = 'ACTIVE'`;
    return rows.map((r) => r.user_id);
  }
}
