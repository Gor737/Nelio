"use client";

import { NotificationFilter } from "@/lib/types/notificationTypes";
import styles from "./NotificationsFilter.module.css";

type Props = {
  value: NotificationFilter;
  onChange: (value: NotificationFilter) => void;
};

const OPTIONS: { value: NotificationFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
];

export const NotificationsFilter = ({ value, onChange }: Props) => {
  return (
    <div className={styles.filter} role="group" aria-label="Filter notifications">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={styles.tab}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
};
