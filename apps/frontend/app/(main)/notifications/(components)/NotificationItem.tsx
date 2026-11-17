'use client'

import { Notification } from "@/lib/types/notificationTypes"
import styles from "./NotificationItem.module.css"

type Props = {
    notification: Notification
}

export const NotificationItem = ({notification}: Props) => {
    const isUnread = notification.readAt === null
    const letter = notification.actor?.fullName?.[0] ?? 'N'

    return (
        <li className={styles.item} data-unread={isUnread}>
            <span className={styles.avatar} aria-hidden="true">{letter}</span>
            <div className={styles.body}>
                <div className={styles.text}>
                    <strong className={styles.actor}>{notification.actor?.fullName ?? ''}</strong>{' '}
                    <span>{notification.type}</span>
                </div>
                <div className={styles.course}>{notification.data.courseTitle}</div>
                <time className={styles.time} dateTime={notification.createdAt}>
                    {new Date(notification.createdAt).toLocaleDateString()}
                </time>
            </div>
            {isUnread && <span className={styles.dot}><span className={styles.srOnly}>Unread</span></span>}
        </li>
    )
}
