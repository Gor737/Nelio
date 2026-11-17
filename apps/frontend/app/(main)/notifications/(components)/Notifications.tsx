"use client";

import { selectAccessToken } from "@/lib/features/auth/authSlice";
import { useGetNotificationsQuery } from "@/lib/features/notifications/notificationsApi";
import { useAppSelector } from "@/lib/hooks";
import Link from "next/link";
import { NotificationItem } from "./NotificationItem";
import styles from "./Notifications.module.css";

const head = (
  <header className={styles.head}>
    <h1 className={styles.title}>Notifications</h1>
    <p className={styles.subtitle}>Updates about your courses, enrollments and account.</p>
  </header>
);

export const Notifications = () => {
  const accessToken = useAppSelector(selectAccessToken);

  const { data, isLoading, isError } = useGetNotificationsQuery(undefined, {
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

  if (isLoading)
    return (
      <section className={styles.page}>
        {head}
        <div className={styles.list} aria-hidden="true">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className={styles.skeletonRow}>
              <span className={styles.skeletonAvatar} />
              <span className={styles.skeletonLines}>
                <span className={styles.skeletonTitle} />
                <span className={styles.skeletonText} />
              </span>
            </div>
          ))}
        </div>
        <p className={styles.srOnly}>Loading...</p>
      </section>
    );

  if (isError)
    return (
      <section className={styles.page}>
        {head}
        <div className={styles.errorBox} role="alert">Error...</div>
      </section>
    );

  // TODO (Gor): `data` exists even when the list is empty, check items.length too
  if (!data)
    return (
      <section className={styles.page}>
        {head}
        <div className={styles.emptyBox}>
          <p className={styles.emptyText}>You’re all caught up</p>
        </div>
      </section>
    );

  return (
    <section className={styles.page}>
      {head}
      <ul className={styles.list}>
        {data.items.map((n) => <NotificationItem key={n.id} notification={n} />)}
      </ul>
    </section>
  );
};
