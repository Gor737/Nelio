import { nelioApiSlice } from "@/lib/api/nelioApiSlice";
import {
  NotificationsPage,
  NotificationsQueryArgs,
  UnreadCount,
} from "@/lib/types/notificationTypes";

export const notificationsApi = nelioApiSlice.injectEndpoints({
  endpoints: (build) => ({
    getNotifications: build.infiniteQuery<
      NotificationsPage,
      NotificationsQueryArgs,
      string | null
    >({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      },
      query: ({ queryArg, pageParam }) => ({
        url: "/me/notifications",
        method: "GET",
        params: { ...queryArg, cursor: pageParam ?? undefined, limit: 20 },
      }),
      providesTags: ["Notifications"],
    }),
    getUnreadCount: build.query<UnreadCount, void>({
      query: () => ({
        url: "/me/notifications/unread-count",
        method: "GET",
      }),
      providesTags: ["Notifications"],
    }),
    markAsRead: build.mutation<void, string>({
      query: (id) => ({
        url: `/me/notifications/${id}/read`,
        method: "PUT",
      }),
      invalidatesTags: ["Notifications"],
    }),
    markAllAsRead: build.mutation<void, void>({
      query: () => ({
        url: "/me/notifications/read-all",
        method: "PUT",
      }),
      invalidatesTags: ["Notifications"],
    }),
  }),
});

export const {
  useGetNotificationsInfiniteQuery,
  useGetUnreadCountQuery,
  useMarkAllAsReadMutation,
  useMarkAsReadMutation,
} = notificationsApi;
