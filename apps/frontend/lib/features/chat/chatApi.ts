import { nelioApiSlice } from "@/lib/api/nelioApiSlice";
import {
  ChatPerson,
  Conversation,
  ConversationsPage,
  Message,
  MessageHistory,
} from "@/lib/types/chatTypes";

export const chatApi = nelioApiSlice.injectEndpoints({
  endpoints: (build) => ({
    getConversations: build.query<ConversationsPage, void>({
      query: () => ({
        url: "/me/conversations",
        method: "GET",
        params: { page: 1, pageSize: 20 },
      }),
      providesTags: (res, err) => [{ type: "Conversations" }],
    }),
    getMessageHistory: build.query<MessageHistory, string>({
      query: (id) => ({
        url: `/conversations/${id}/messages`,
        method: "GET",
        params: { limit: 30 },
      }),
      providesTags: (res, err, id) => [{ type: "Messages", id }],
    }),
    sendMessage: build.mutation<
      Message,
      { conversationId: string; body: string; clientId: string }
    >({
      query: (arg) => ({
        url: `/conversations/${arg.conversationId}/messages`,
        method: "POST",
        body: { body: arg.body, clientId: arg.clientId },
      }),
      invalidatesTags: (res, err, arg) => [
        { type: "Messages", id: arg.conversationId },
        "Conversations",
      ],
    }),
    markConversationRead: build.mutation<
      { lastReadSeq: number },
      { conversationId: string; seq: number }
    >({
      query: ({ conversationId, seq }) => ({
        url: `/conversations/${conversationId}/read`,
        method: "PUT",
        body: { seq },
      }),
      invalidatesTags: (res, err) => [{ type: "Conversations" }],
    }),
    searchUsers: build.query<ChatPerson[], string>({
      query: (q) => ({
        url: "/users",
        method: "GET",
        params: {
          q,
        },
      }),
    }),
    createDirect: build.mutation<Conversation, string>({
      query: (userId) => ({
        url: "/conversations/direct",
        method: "POST",
        body: { userId },
      }),
      invalidatesTags: (res, err) => [{ type: "Conversations" }],
    }),
    getPresence: build.query<{ online: string[] }, void>({
      query: () => ({
        url: "/me/presence",
        method: "GET",
      }),
    }),
    editMessage: build.mutation<
      Message,
      { conversationId: string; messageId: string; body: string }
    >({
      query: ({ conversationId, messageId, body }) => ({
        url: `/conversations/${conversationId}/messages/${messageId}`,
        method: "PATCH",
        body: { body },
      }),
    }),
    deleteMessage: build.mutation<
      Message,
      { conversationId: string; messageId: string }
    >({
      query: ({ conversationId, messageId }) => ({
        url: `/conversations/${conversationId}/messages/${messageId}`,
        method: "DELETE",
      }),
    }),
  }),
});

export const {
  useGetConversationsQuery,
  useGetMessageHistoryQuery,
  useSendMessageMutation,
  useMarkConversationReadMutation,
  useSearchUsersQuery,
  useCreateDirectMutation,
  useGetPresenceQuery,
  useEditMessageMutation,
  useDeleteMessageMutation,
} = chatApi;
