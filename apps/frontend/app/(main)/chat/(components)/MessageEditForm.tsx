'use client'

import { useEditMessageMutation } from "@/lib/features/chat/chatApi"
import { Message } from "@/lib/types/chatTypes"
import { FormEvent, useState } from "react"
import styles from "./MessageBubble.module.css"

type Props = {
    message: Message
    onDone: () => void
}

export const MessageEditForm = ({ message, onDone }: Props) => {
    const [text, setText] = useState(message.body ?? "")
    const [error, setError] = useState<string | null>(null)
    const [editMessage, { isLoading }] = useEditMessageMutation()

    const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        const trimmed = text.trim()
        // Դատարկ կամ նույնը՝ պարզապես փակում ենք
        if (!trimmed || trimmed === message.body) return onDone()
        try {
            setError(null)
            await editMessage({
                conversationId: message.conversationId,
                messageId: message.id,
                body: trimmed,
            }).unwrap()
            onDone()
        } catch {
            setError("Could not save")
        }
    }

    return (
        <form className={styles.editForm} onSubmit={handleSubmit}>
            <input
                className={styles.editInput}
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Escape" && onDone()}
                autoFocus
            />
            {error && <span className={styles.editError}>{error}</span>}
            <div className={styles.editBtns}>
                <button type="button" className={styles.actionBtn} onClick={onDone}>
                    Cancel
                </button>
                <button type="submit" className={styles.actionBtn} disabled={isLoading}>
                    {isLoading ? "Saving…" : "Save"}
                </button>
            </div>
        </form>
    )
}
