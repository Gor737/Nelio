"use client";

import {
  useCreateDirectMutation,
  useSearchUsersQuery,
} from "@/lib/features/chat/chatApi";
import { useDebounce } from "@/lib/hooks/useDebounce";
import { ChatPerson, Conversation } from "@/lib/types/chatTypes";
import { useState } from "react";
import styles from "./NewChat.module.css";

type Props = { onStart: (conversation: Conversation) => void };

export const NewChat = ({ onStart }: Props) => {
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const debouncedQ = useDebounce(q.trim(), 300);
  const { data } = useSearchUsersQuery(debouncedQ, {
    skip: debouncedQ.length < 2,
  });
  const [createDirect, { isLoading }] = useCreateDirectMutation();

  const onPick = async (person: ChatPerson) => {
    try {
      setError("");
      const conversation = await createDirect(person.id).unwrap();
      onStart(conversation);
      setQ("");
    } catch {
      setError("Could not start the chat");
    }
  };

  return (
    <div className={styles.wrap}>
      <input
        className={styles.input}
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        type="search"
        placeholder="Search people to start a chat..."
      />
      {error && <p className={styles.error}>{error}</p>}

      {data && q.trim().length >= 2 && (
        <ul className={styles.results}>
          {data.length === 0 && <li className={styles.empty}>No people found</li>}
          {data.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={styles.person}
                disabled={isLoading}
                onClick={() => onPick(p)}
              >
                <span className={styles.avatar}>{p.fullName.charAt(0)}</span>
                <span className={styles.name}>{p.fullName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
