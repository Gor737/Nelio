"use client";

import { useSendMessageMutation } from "@/lib/features/chat/chatApi";
import { FormEvent, useRef, useState } from "react";
import styles from "./MessageInput.module.css";
import { getSocket } from "@/lib/socket/socket";

type Props = {
  conversationId: string;
};

export const MessageInput = ({ conversationId }: Props) => {
  const [text, setText] = useState("");
  const [sendMessage, { isLoading }] = useSendMessageMutation();
  const [error, setError] = useState<string | null>(null);
  const lastTypingRef = useRef(0);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      setError(null);
      await sendMessage({
        conversationId,
        body: trimmed,
        clientId: crypto.randomUUID(),
      }).unwrap();

       setText("");

      getSocket()?.emit("typing:stop", { conversationId });
      lastTypingRef.current = 0;
    } catch (err) {
      setError("Could not send");
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      {error && <p className={styles.error}>{error}</p>}
      <input
        className={styles.input}
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
          if (Date.now() - lastTypingRef.current > 3000) {
            getSocket()?.emit("typing:start", { conversationId });
            lastTypingRef.current = Date.now();
          }
        }}
        type="text"
        placeholder="Write a message..."
      />
      <button
        className={styles.send}
        type="submit"
        disabled={isLoading || !text.trim()}
      >
        Send
      </button>
    </form>
  );
};
