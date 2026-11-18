"use client";

import { selectAccessToken } from "@/lib/features/auth/authSlice";
import { chatApi } from "@/lib/features/chat/chatApi";
import { useAppDispatch, useAppSelector } from "@/lib/hooks";
import { connectSocket, disconnectSocket } from "@/lib/socket/socket";
import { Message } from "@/lib/types/chatTypes";
import { useEffect } from "react";

export const SocketBootstrap = () => {
  const accessToken = useAppSelector(selectAccessToken);
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!accessToken) return;
    const s = connectSocket(accessToken);

    s.on("message:new", (msg: Message) => {
      dispatch(
        chatApi.util.updateQueryData(
          "getMessageHistory",
          msg.conversationId,
          (draft) => {
            if (!draft.items.some((m) => m.id === msg.id))
              draft.items.push(msg); // նորը ներքևում
          },
        ),
      );
      dispatch(chatApi.util.invalidateTags(["Conversations"]));
    });

    s.on("notification:new", () => {
      dispatch(chatApi.util.invalidateTags(["Notifications"]));
    });

    s.on("presence:update", (e: { userId: string; online: boolean }) => {
      dispatch(
        chatApi.util.updateQueryData("getPresence", undefined, (draft) => {
          draft.online = draft.online.filter((id) => id !== e.userId);
          if (e.online) draft.online.push(e.userId);
        }),
      );
    });

    const replaceMessage = (msg: Message) => {
      dispatch(
        chatApi.util.updateQueryData(
          "getMessageHistory",
          msg.conversationId,
          (draft) => {
            const i = draft.items.findIndex((m) => m.id === msg.id);
            if (i !== -1) draft.items[i] = msg;
          },
        ),
      );
    };
    s.on("message:edited", replaceMessage);
    s.on("message:deleted", replaceMessage);

    return () => {
      disconnectSocket();
    };
  }, [accessToken, dispatch]);

  return null;
};
