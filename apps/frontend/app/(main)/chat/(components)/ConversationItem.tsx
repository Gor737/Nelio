"use client";

import { Conversation } from "@/lib/types/chatTypes";
import { getConversationName } from "../conversationName";
import styles from "./ConversationItem.module.css";
import { useGetPresenceQuery } from "@/lib/features/chat/chatApi";

type Props = {
  item: Conversation;
  isActive: boolean;
  onSelect: (id: string | null) => void;
};

const TYPE_LABEL = {
  DIRECT: "Direct message",
  GROUP: "Group",
  COURSE_CHANNEL: "Course channel",
} as const;

const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const ConversationItem = ({ item, isActive, onSelect }: Props) => {
  const name = getConversationName(item);
  const avatarUrl = item.peer?.avatarUrl;
  const { data: presence } = useGetPresenceQuery();
  const isOnline = item.peer ? presence?.online.includes(item.peer.id) : false;

  return (
    <li>
      <button
        type="button"
        className={styles.item}
        data-unread={item.unreadCount > 0}
        data-active={isActive}
        onClick={() => onSelect(item.id)}
      >
        <span className={styles.avatarBox}>
          <span className={styles.avatar}>
            {avatarUrl ? <img src={avatarUrl} alt={name} /> : name.charAt(0)}
          </span>
          {isOnline && (
            <span className={styles.onlineDot} aria-label="Online" />
          )}
        </span>

        <div className={styles.body}>
          <span className={styles.name}>{name}</span>
          <span className={styles.meta}>{isOnline ? "Online" : TYPE_LABEL[item.type]}</span>
        </div>

        <div className={styles.side}>
          {item.lastMessageAt && (
            <span className={styles.time}>
              {formatTime(item.lastMessageAt)}
            </span>
          )}
          {item.unreadCount > 0 && (
            <span className={styles.badge}>{item.unreadCount}</span>
          )}
        </div>
      </button>
    </li>
  );
};
