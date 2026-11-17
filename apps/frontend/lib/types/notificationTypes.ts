export type NotificationType =
  | "TEACHER_APPLICATION_RECEIVED"
  | "TEACHER_APPLICATION_APPROVED"
  | "TEACHER_APPLICATION_REJECTED"
  | "TEACHER_ROLE_REVOKED"
  | "ENROLLMENT_REQUESTED"
  | "ENROLLMENT_APPROVED"
  | "ENROLLMENT_REJECTED"
  | "REMOVED_FROM_COURSE"
  | "INVITATION_RECEIVED"
  | "LESSON_PUBLISHED"
  | "OWNERSHIP_TRANSFERRED"
  | "COURSE_ADMIN_LOCKED";

export type NotificationActor = {
  id: string;
  fullName: string;
};

// Keys depend on `type` (snapshot taken when the event happened)
export type NotificationData = {
  courseTitle?: string;
  lessonId?: string; // LESSON_PUBLISHED
  lessonTitle?: string; // LESSON_PUBLISHED
  reason?: string; // COURSE_ADMIN_LOCKED
  reinstated?: boolean; // ENROLLMENT_APPROVED
};

export type Notification = {
  id: string;
  type: NotificationType;
  courseId: string | null;
  actor: NotificationActor | null;
  data: NotificationData;
  readAt: string | null;
  createdAt: string;
};

export type NotificationsPage = {
  items: Notification[];
  nextCursor: string | null;
};

export type UnreadCount = {
  count: number;
};

export type NotificationsQueryArgs = {
  unread?: boolean;
  cursor?: string;
};
