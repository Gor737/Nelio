'use client'

import { Conversation } from "@/lib/types/chatTypes"
import { ConversationItem } from "./ConversationItem"
import styles from "./ConversationList.module.css"

type Props = {
    list: Conversation[],
    selectedId: string | null,
    onSelect: (id: string | null) => void
}

export const ConversationList = ({list, selectedId, onSelect}: Props) => {
    return (
        <ul className={styles.list}>
            {list.map(el => <ConversationItem key={el.id} item={el} isActive={el.id === selectedId} onSelect={onSelect}/>)}
        </ul>
    )
}
