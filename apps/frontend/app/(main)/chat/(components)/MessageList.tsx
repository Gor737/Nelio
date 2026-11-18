'use client'

import { useMeQuery } from "@/lib/features/auth/authApi"
import { Message } from "@/lib/types/chatTypes"
import { useEffect, useRef } from "react"
import { MessageBubble } from "./MessageBubble"

type Props = {
    messages: Message[]
}

export const MessageList = ({ messages }: Props) => {
    // /me-ն արդեն cache-ում է (Header-ը կանչել է), նոր request չի լինի
    const { data: me } = useMeQuery()
    const bottomRef = useRef<HTMLDivElement>(null)

    // Նոր message գալիս (կամ chat բացելիս) իջնում ենք ներքև
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ block: "end" })
    }, [messages.length])

    return (
        <>
            {messages.map((m) => (
                <MessageBubble key={m.id} message={m} isMine={m.sender.id === me?.id} />
            ))}
            <div ref={bottomRef} />
        </>
    )
}
