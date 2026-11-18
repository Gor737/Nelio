"use client";

import { useGetPresenceQuery } from "@/lib/features/chat/chatApi";
import { Conversation } from "@/lib/types/chatTypes";
import { getConversationName } from "../conversationName";
import styles from "./ConversationView.module.css";

type Props = {
  conversation: Conversation;
  isTyping: boolean;
  onBack: () => void;
};

const subtitle = (c: Conversation) =>
  c.type === "DIRECT" ? "Direct message" : `${c.memberCount} members`;

export const ConversationHeader = ({ conversation, isTyping, onBack }: Props) => {
  const name = getConversationName(conversation);
  const avatarUrl = conversation.peer?.avatarUrl;
  const { data: presence } = useGetPresenceQuery();
  const peerId = conversation.peer?.id;
  const isOnline = peerId ? presence?.online.includes(peerId) : false;

  // typing… > Online > Direct message / N members
  const status = isTyping ? "typing…" : isOnline ? "Online" : subtitle(conversation);

  return (
    <header className={styles.header}>
      {/* Phone only: back to the list */}
      <button type="button" className={styles.back} onClick={onBack} aria-label="Back to conversations">
        ←
      </button>
      <span className={styles.avatarBox}>
        <span className={styles.avatar}>
          {avatarUrl ? <img src={avatarUrl} alt={name} /> : name.charAt(0)}
        </span>
        {isOnline && <span className={styles.onlineDot} aria-label="Online" />}
      </span>
      <div className={styles.info}>
        <span className={styles.name}>{name}</span>
        <span className={styles.sub} data-live={isTyping || isOnline}>{status}</span>
      </div>
    </header>
  );
};
