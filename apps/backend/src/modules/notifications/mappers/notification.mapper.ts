import type { NotificationType } from '../../../common/constants/notification-types.js';
import type { NotificationDto } from '../dto/notification.dto.js';

/** A notification row joined with its actor (the actor is optional: system events have none, and a deleted user leaves NULL). */
export interface NotificationRow {
  id: string;
  type: NotificationType;
  course_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  data: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

export function toNotificationDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    type: row.type,
    courseId: row.course_id,
    actor:
      row.actor_id !== null && row.actor_name !== null
        ? { id: row.actor_id, fullName: row.actor_name }
        : null,
    data: row.data,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}
