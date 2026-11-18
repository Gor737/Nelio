"use client";

import { Conversation } from "@/lib/types/chatTypes";
import styles from "./ConversationView.module.css";
import {
  useGetMessageHistoryQuery,
  useMarkConversationReadMutation,
} from "@/lib/features/chat/chatApi";
import { MessageList } from "./MessageList";
import { MessageInput } from "./MessageInput";
import { useEffect, useState } from "react";
import { getSocket } from "@/lib/socket/socket";
import { ConversationHeader } from "./ConversationHeader";

type Props = {
  conversation: Conversation;
  onBack: () => void;
};

export const ConversationView = ({ conversation, onBack }: Props) => {
  const {
    data: messageHistory,
    isLoading,
    isError,
  } = useGetMessageHistoryQuery(conversation.id);
  const [isTyping, setIsTyping] = useState(false);
  const [markAsRead] = useMarkConversationReadMutation();

  // Backend-ը տալիս է հինը առաջինը (oldest first), այնպես, ինչպես պետք է ցույց տալ
  const messages = messageHistory?.items ?? [];
  const latestSeq = messages[messages.length - 1]?.seq;

  useEffect(() => {
    if (latestSeq !== undefined && latestSeq > conversation.lastReadSeq) {
      markAsRead({ conversationId: conversation.id, seq: latestSeq });
    }
  }, [latestSeq, conversation.lastReadSeq, conversation.id, markAsRead]);

  useEffect(() => {
    setIsTyping(false);
    const s = getSocket();
    if (!s) return;

    const onTyping = (e: { conversationId: string; isTyping: boolean }) => {
      if (e.conversationId === conversation.id) setIsTyping(e.isTyping);
    };

    s.on("typing", onTyping);
    return () => {
      s.off("typing", onTyping);
    };
  }, [conversation.id]);

  return (
    <div className={styles.view}>
      <ConversationHeader conversation={conversation} isTyping={isTyping} onBack={onBack} />

      <div className={styles.messages}>
        {isLoading && <p className={styles.hint}>Loading messages...</p>}
        {isError && <p className={styles.hint}>Could not load messages.</p>}
        {messageHistory && messages.length === 0 && (
          <p className={styles.hint}>No messages yet. Say hi 👋</p>
        )}
        {messages.length > 0 && <MessageList messages={messages} />}
      </div>

      {!conversation.readOnly && (
        <MessageInput conversationId={conversation.id} />
      )}
    </div>
  );
};
