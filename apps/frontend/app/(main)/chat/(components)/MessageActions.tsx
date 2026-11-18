'use client'

import { useDeleteMessageMutation } from "@/lib/features/chat/chatApi"
import { Message } from "@/lib/types/chatTypes"
import styles from "./MessageBubble.module.css"

type Props = {
    message: Message
    onEdit: () => void
}

export const MessageActions = ({ message, onEdit }: Props) => {
    const [deleteMessage, { isLoading }] = useDeleteMessageMutation()

    const handleDelete = () => {
        if (!confirm("Delete this message?")) return
        // Էկրանը թարմանում է socket-ի "message:deleted" event-ով (SocketBootstrap)
        deleteMessage({ conversationId: message.conversationId, messageId: message.id })
    }

    return (
        <div className={styles.actions}>
            <button type="button" className={styles.actionBtn} onClick={onEdit}>
                Edit
            </button>
            <button
                type="button"
                className={styles.actionBtn}
                data-danger="true"
                disabled={isLoading}
                onClick={handleDelete}
            >
                Delete
            </button>
        </div>
    )
}
