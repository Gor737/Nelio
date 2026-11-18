"use client";

import { useGetConversationsQuery } from "@/lib/features/chat/chatApi";
import { ConversationList } from "./(components)/ConversationList";
import { useAppSelector } from "@/lib/hooks";
import { selectAccessToken } from "@/lib/features/auth/authSlice";
import Link from "next/link";
import styles from "./(components)/Chat.module.css";
import { useState } from "react";
import { ConversationView } from "./(components)/ConversationView";
import { NewChat } from "./(components)/NewChat";
import { Conversation } from "@/lib/types/chatTypes";

export default function ChatPage() {
  const accessToken = useAppSelector(selectAccessToken);
  const { data, isLoading, isError } = useGetConversationsQuery(undefined, {
    skip: !accessToken,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A new direct chat is hidden from GET /me/conversations until its first message,
  // so we keep it here until it shows up in the list.
  const [newConversation, setNewConversation] = useState<Conversation | null>(null);

  const onSelect = (id: string | null) => {setSelectedId(id)}
  const onStartChat = (c: Conversation) => {
    setNewConversation(c);
    setSelectedId(c.id);
  };

  if (!accessToken)
    return (
      <div className={styles.stateBox}>
        <p className={styles.stateText}>Sign in to see your messages.</p>
        <Link href={"/login"} className={styles.primaryLink}>
          Go to Sign in
        </Link>
      </div>
    );
  if (isLoading) return <div className={styles.stateBox}>Loading...</div>;
  if (isError)
    return <div className={styles.errorBox}>Could not load conversations.</div>;
  if (!data) return null;

  const selected =
    data.items.find((c) => c.id === selectedId) ??
    (newConversation?.id === selectedId ? newConversation : undefined);

  return (
    <main className={styles.page} data-open={selected !== undefined}>
      <aside className={styles.sidebar}>
        <h1 className={styles.title}>Messages</h1>
        <NewChat onStart={onStartChat} />
        {data.items.length === 0 ? (
          <p className={styles.emptyList}>No conversations yet. Search for someone above.</p>
        ) : (
          <ConversationList list={data.items} selectedId={selectedId} onSelect={onSelect} />
        )}
      </aside>
      <section className={styles.panel} data-open={selected !== undefined}>
        {selected ? (
          <ConversationView conversation={selected} onBack={() => onSelect(null)} />
        ) : (
          <p className={styles.panelHint}>Select a conversation to start chatting</p>
        )}
      </section>
    </main>
  );
}
