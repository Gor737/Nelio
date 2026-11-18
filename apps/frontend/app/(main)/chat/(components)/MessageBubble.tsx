'use client'

import { Message } from "@/lib/types/chatTypes"
import { useState } from "react"
import { MessageActions } from "./MessageActions"
import { MessageEditForm } from "./MessageEditForm"
import styles from "./MessageBubble.module.css"

type Props = {
    message: Message
    isMine: boolean
}

const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

export const MessageBubble = ({ message, isMine }: Props) => {
    const [isEditing, setIsEditing] = useState(false)
    const canManage = isMine && !message.deleted

    return (
        <div className={styles.row} data-mine={isMine}>
            {/* Իմ message-ի ձախում, hover-ի ժամանակ */}
            {canManage && !isEditing && (
                <MessageActions message={message} onEdit={() => setIsEditing(true)} />
            )}

            <div className={styles.bubble} data-deleted={message.deleted}>
                {!isMine && <span className={styles.sender}>{message.sender.fullName}</span>}

                {isEditing ? (
                    <MessageEditForm message={message} onDone={() => setIsEditing(false)} />
                ) : (
                    <p className={styles.body}>
                        {message.deleted ? "Message deleted" : message.body}
                    </p>
                )}

                <span className={styles.time}>
                    {formatTime(message.createdAt)}
                    {message.editedAt && !message.deleted && " · edited"}
                </span>
            </div>
        </div>
    )
}
