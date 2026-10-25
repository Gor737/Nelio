/**
 * Notification types: exactly 12 (docs/architecture.md section 17, Decisions 33, 75, 137, 139).
 * A notification is a type + optional `course_id`/`actor_id` + a JSON display snapshot, created after commit.
 * Chat messages are never notifications. Recipients and triggers below follow the catalog text; where the catalog does
 * not name a recipient it is marked `derived` and listed in the M4 report.
 */
export type NotificationRecipients =
  | 'ALL_ACTIVE_ADMINS'
  | 'APPLICANT'
  | 'REVOKED_TEACHER'
  | 'COURSE_OWNER_AND_ASSISTANTS'
  | 'ENROLLEE'
  | 'REMOVED_STUDENT'
  | 'INVITEE'
  | 'ACTIVE_STUDENTS'
  | 'NEW_OWNER';

export interface NotificationTypeSpec {
  readonly recipients: NotificationRecipients;
  readonly trigger: string;
  readonly source: 'documented' | 'derived';
}

export const NOTIFICATION_TYPES = {
  TEACHER_APPLICATION_RECEIVED: {
    recipients: 'ALL_ACTIVE_ADMINS',
    trigger: 'A user submits a Teacher application.',
    source: 'documented',
  },
  TEACHER_APPLICATION_APPROVED: {
    recipients: 'APPLICANT',
    trigger: 'An Admin approves the application.',
    source: 'documented',
  },
  TEACHER_APPLICATION_REJECTED: {
    recipients: 'APPLICANT',
    trigger: 'An Admin rejects the application.',
    source: 'documented',
  },
  TEACHER_ROLE_REVOKED: {
    recipients: 'REVOKED_TEACHER',
    trigger: 'An Admin revokes the Teacher role.',
    source: 'documented',
  },
  ENROLLMENT_REQUESTED: {
    recipients: 'COURSE_OWNER_AND_ASSISTANTS',
    trigger: 'A student requests enrollment in an APPROVAL_REQUIRED course.',
    source: 'documented',
  },
  ENROLLMENT_APPROVED: {
    recipients: 'ENROLLEE',
    trigger: 'A request is approved; also used for reinstatement.',
    source: 'documented',
  },
  ENROLLMENT_REJECTED: {
    recipients: 'ENROLLEE',
    trigger: 'A request is rejected.',
    source: 'derived',
  },
  REMOVED_FROM_COURSE: {
    recipients: 'REMOVED_STUDENT',
    trigger: 'The Owner or an Admin removes a student.',
    source: 'derived',
  },
  INVITATION_RECEIVED: {
    recipients: 'INVITEE',
    trigger: 'An invitation is created or reset.',
    source: 'derived',
  },
  LESSON_PUBLISHED: {
    recipients: 'ACTIVE_STUDENTS',
    trigger: 'A lesson is published for the first time.',
    source: 'documented',
  },
  OWNERSHIP_TRANSFERRED: {
    recipients: 'NEW_OWNER',
    trigger: 'Course ownership is transferred.',
    source: 'derived',
  },
  COURSE_ADMIN_LOCKED: {
    recipients: 'COURSE_OWNER_AND_ASSISTANTS',
    trigger:
      'An Admin locks the course; the reason is in `data` (Decision 139).',
    source: 'documented',
  },
} as const satisfies Record<string, NotificationTypeSpec>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_NAMES = Object.keys(
  NOTIFICATION_TYPES,
) as NotificationType[];
