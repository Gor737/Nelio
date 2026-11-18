"use client";

import { useState } from "react";
import Link from "next/link";
import { selectAccessToken } from "@/lib/features/auth/authSlice";
import {
    useGetNotificationsInfiniteQuery,
  useMarkAllAsReadMutation,
} from "@/lib/features/notifications/notificationsApi";
import { useAppSelector } from "@/lib/hooks";
import { NotificationFilter } from "@/lib/types/notificationTypes";
import { NotificationItem } from "./NotificationItem";
import { NotificationsFilter } from "./NotificationsFilter";
import { NotificationsSkeleton } from "./NotificationsSkeleton";
import styles from "./Notifications.module.css";

const head = (
  <header className={styles.head}>
    <h1 className={styles.title}>Notifications</h1>
    <p className={styles.subtitle}>Updates about your courses, enrollments and account.</p>
  </header>
);

export const Notifications = () => {
  const accessToken = useAppSelector(selectAccessToken);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [markAllAsRead, { isLoading: isMarking }] = useMarkAllAsReadMutation();

  const { data, isLoading, isError, isFetching, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useGetNotificationsInfiniteQuery(filter === "unread" ? { unread: true } : {}, {
      skip: !accessToken,
    });

  if (!accessToken)
    return (
      <section className={styles.page}>
        {head}
        <div className={styles.emptyBox}>
          <Link className={styles.primaryLink} href={"/login"}>Go to Sign in</Link>
        </div>
      </section>
    );

  // All pages joined into one list
  const notifications = data?.pages.flatMap((page) => page.items) ?? [];
  const hasUnread = notifications.some((n) => n.readAt === null);
  // Filter switched, new list still loading (not "Load more")
  const isSwitching = isFetching && !isFetchingNextPage;

  let content;
  if (isLoading) content = <NotificationsSkeleton />;
  else if (isError) content = <div className={styles.errorBox} role="alert">Error...</div>;
  else if (notifications.length === 0)
    content = (
      <div className={styles.emptyBox}>
        <p className={styles.emptyText}>
          {filter === "unread" ? "No unread notifications" : "You’re all caught up"}
        </p>
      </div>
    );
  else
    content = (
      <>
        <ul className={styles.list} data-busy={isSwitching}>
          {notifications.map((n) => <NotificationItem key={n.id} notification={n} />)}
        </ul>
        {hasNextPage && (
          <button type="button" className={styles.loadMoreBtn} onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        )}
      </>
    );

  // Filter stays visible in every state, so an empty "Unread" can switch back
  return (
    <section className={styles.page}>
      <div className={styles.headRow}>
        {head}
        {hasUnread && (
          <button type="button" className={styles.markAllBtn} disabled={isMarking} onClick={() => markAllAsRead()}>
            {isMarking ? "Marking…" : "Mark all as read"}
          </button>
        )}
      </div>
      <NotificationsFilter value={filter} onChange={setFilter} />
      {content}
    </section>
  );
};
