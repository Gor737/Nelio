/**
 * Event contracts: names and payloads only, no logic (docs/architecture.md section 17).
 * Producers and listeners import only this file. Events are emitted AFTER commit, never inside a transaction and never
 * after a rollback. Payloads carry ids, not entities, so a listener cannot see more than the database would show it.
 */
import type { NotificationType } from '../../common/constants/notification-types.js';

export interface EventContracts {
  // --- chat / realtime / session (named in the architecture) ---
  'message.created': {
    conversationId: string;
    messageId: string;
    senderId: string;
    seq: number;
  };
  'message.edited': { conversationId: string; messageId: string };
  'message.deleted': { conversationId: string; messageId: string };
  'membership.ended': {
    userId: string;
    courseId: string | null;
    conversationId: string | null;
  };
  'session.revoked': { userId: string };
  'socket.connected': { userId: string; socketId: string };
  'socket.disconnected': {
    userId: string;
    socketId: string;
    wasLastSocket: boolean;
  };

  // --- one domain event per notification type (Notifications listens; no module imports Notifications) ---
  'teacher-application.received': { applicantId: string };
  'teacher-application.approved': { applicantId: string; decidedBy: string };
  'teacher-application.rejected': { applicantId: string; decidedBy: string };
  'teacher-role.revoked': { userId: string; revokedBy: string };
  'enrollment.requested': { courseId: string; studentId: string };
  'enrollment.approved': {
    courseId: string;
    studentId: string;
    decidedBy: string;
    reinstated: boolean;
  };
  'enrollment.rejected': {
    courseId: string;
    studentId: string;
    decidedBy: string;
  };
  'enrollment.removed': {
    courseId: string;
    studentId: string;
    removedBy: string;
  };
  'invitation.created': {
    courseId: string;
    inviteeId: string;
    invitedBy: string;
  };
  'lesson.first-published': { courseId: string; lessonId: string };
  'course.ownership-transferred': {
    courseId: string;
    previousOwnerId: string;
    newOwnerId: string;
  };
  'course.admin-locked': { courseId: string; lockedBy: string; reason: string };
}

export type EventName = keyof EventContracts;

/** Runtime list of event names; the Record type makes TypeScript fail if it drifts from EventContracts. */
const EVENT_NAME_MAP: Record<EventName, true> = {
  'message.created': true,
  'message.edited': true,
  'message.deleted': true,
  'membership.ended': true,
  'session.revoked': true,
  'socket.connected': true,
  'socket.disconnected': true,
  'teacher-application.received': true,
  'teacher-application.approved': true,
  'teacher-application.rejected': true,
  'teacher-role.revoked': true,
  'enrollment.requested': true,
  'enrollment.approved': true,
  'enrollment.rejected': true,
  'enrollment.removed': true,
  'invitation.created': true,
  'lesson.first-published': true,
  'course.ownership-transferred': true,
  'course.admin-locked': true,
};
export const EVENT_NAMES = Object.keys(EVENT_NAME_MAP) as EventName[];

/** The event that produces each notification type. */
export const NOTIFICATION_EVENTS: Record<NotificationType, EventName> = {
  TEACHER_APPLICATION_RECEIVED: 'teacher-application.received',
  TEACHER_APPLICATION_APPROVED: 'teacher-application.approved',
  TEACHER_APPLICATION_REJECTED: 'teacher-application.rejected',
  TEACHER_ROLE_REVOKED: 'teacher-role.revoked',
  ENROLLMENT_REQUESTED: 'enrollment.requested',
  ENROLLMENT_APPROVED: 'enrollment.approved',
  ENROLLMENT_REJECTED: 'enrollment.rejected',
  REMOVED_FROM_COURSE: 'enrollment.removed',
  INVITATION_RECEIVED: 'invitation.created',
  LESSON_PUBLISHED: 'lesson.first-published',
  OWNERSHIP_TRANSFERRED: 'course.ownership-transferred',
  COURSE_ADMIN_LOCKED: 'course.admin-locked',
};
