"use client";

import Link from "next/link";
import { Notification } from "@/lib/types/notificationTypes";
import { useMarkAsReadMutation } from "@/lib/features/notifications/notificationsApi";
import { getNotificationContent } from "../notificationContent";
import styles from "./NotificationItem.module.css";

type Props = {
  notification: Notification;
};

export const NotificationItem = ({ notification }: Props) => {
  const isUnread = notification.readAt === null;
  const letter = notification.actor?.fullName?.[0] ?? "N";

  const [markAsRead, { isLoading: isMarking }] = useMarkAsReadMutation();
  const { text, href } = getNotificationContent(notification);

  const handleMarkAsRead = () => {
    if (isUnread) markAsRead(notification.id);
  };

  // JSX (not a string), so it can be reused inside Link or div
  const card = (
    <>
      <p className={styles.text}>{text}</p>
      <time className={styles.time} dateTime={notification.createdAt}>
        {new Date(notification.createdAt).toLocaleDateString()}
      </time>
    </>
  );

  return (
    <li className={styles.item} data-unread={isUnread}>
      <span className={styles.avatar} aria-hidden="true">
        {letter}
      </span>

      {href ? (
        <Link href={href} className={`${styles.body} ${styles.link}`} onClick={handleMarkAsRead}>
          {card}
        </Link>
      ) : (
        <div className={styles.body}>{card}</div>
      )}

      {isUnread && (
        <div className={styles.actions}>
          <span className={styles.dot}>
            <span className={styles.srOnly}>Unread</span>
          </span>
          <button type="button" className={styles.readBtn} onClick={handleMarkAsRead} disabled={isMarking}>
            Mark as read
          </button>
        </div>
      )}
    </li>
  );
};
