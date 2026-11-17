import { nelioApiSlice } from "@/lib/api/nelioApiSlice";
import { NotificationsPage, NotificationsQueryArgs, UnreadCount } from "@/lib/types/notificationTypes";

export const notificationsApi = nelioApiSlice.injectEndpoints({
  endpoints: (build) => ({
    getNotifications: build.query<NotificationsPage, NotificationsQueryArgs | void>({
      query: (args) => ({
        url: "/me/notifications",
        method: "GET",
        params: args ?? {}
      }),
      providesTags: (res, err) => [{ type: "Notifications" }],
    }),
    getUnreadCount: build.query<UnreadCount, void>({
      query: () => ({
        url: "/me/notifications/unread-count",
        method: "GET",
      }),
      providesTags: (res, err) => [{ type: "Notifications" }],
    }),
  }),
});

export const {useGetNotificationsQuery, useGetUnreadCountQuery} = notificationsApi;