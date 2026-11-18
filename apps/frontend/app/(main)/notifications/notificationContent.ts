import { Notification } from "@/lib/types/notificationTypes";

type NotificationContent = {
  text: string;
  href: string | null;
};

export const getNotificationContent = (
  notification: Notification,
): NotificationContent => {
  const { type, courseId, data } = notification;
  const actor = notification.actor?.fullName ?? "Someone";
  const course = data.courseTitle ?? "a course";
  const courseHref = courseId ? `/courses/${courseId}` : null;

  switch (type) {
    case "TEACHER_APPLICATION_RECEIVED":
      return { text: `${actor} applied to become a teacher`, href: null };
    case "TEACHER_APPLICATION_APPROVED":
      return { text: "Your teacher application was approved", href: "/settings" };
    case "TEACHER_APPLICATION_REJECTED":
      return { text: "Your teacher application was rejected", href: "/settings" };
    case "TEACHER_ROLE_REVOKED":
      return { text: "Your teacher role was revoked", href: "/settings" };
    case "ENROLLMENT_REQUESTED":
      return { text: `${actor} requested to join ${course}`, href: courseHref };
    case "ENROLLMENT_APPROVED":
      return {
        text: data.reinstated
          ? `You were reinstated in ${course}`
          : `Your request to join ${course} was approved`,
        href: courseHref,
      };
    case "ENROLLMENT_REJECTED":
      return { text: `Your request to join ${course} was rejected`, href: courseHref };
    case "REMOVED_FROM_COURSE":
      return { text: `You were removed from ${course}`, href: null };
    case "INVITATION_RECEIVED":
      return { text: `${actor} invited you to ${course}`, href: "/my-learning" };
    case "LESSON_PUBLISHED":
      return {
        text: `New lesson "${data.lessonTitle ?? "Untitled"}" in ${course}`,
        href: courseHref && data.lessonId ? `${courseHref}/lesson/${data.lessonId}` : courseHref,
      };
    case "OWNERSHIP_TRANSFERRED":
      return { text: `You are now the owner of ${course}`, href: courseHref };
    case "COURSE_ADMIN_LOCKED":
      return {
        text: data.reason
          ? `${course} was locked by an admin: ${data.reason}`
          : `${course} was locked by an admin`,
        href: courseHref,
      };
    default: {
      const _exhaustive: never = type;
      return { text: "New notification", href: null };
    }
  }
};