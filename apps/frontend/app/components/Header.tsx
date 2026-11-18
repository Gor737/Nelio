"use client";

import { nelioApiSlice } from "@/lib/api/nelioApiSlice";
import { clearAuth, selectAccessToken } from "@/lib/features/auth/authSlice";
import { useAppDispatch, useAppSelector } from "@/lib/hooks";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./Header.module.css";
import { BellIcon } from "./icons";
import { useLogoutMutation, useMeQuery } from "@/lib/features/auth/authApi";
import { useGetUnreadCountQuery } from "@/lib/features/notifications/notificationsApi";

export const Header = () => {
  const accessToken = useAppSelector(selectAccessToken);

  const dispatch = useAppDispatch();
  const [logout] = useLogoutMutation();
  const { data: me } = useMeQuery(undefined, { skip: !accessToken });
  const { data: unread } = useGetUnreadCountQuery(undefined, { skip: !accessToken });
  const unreadCount = unread?.count ?? 0;
  const router = useRouter();

  const handleLogout = async () => {
    try {
      await logout();
    } catch (err) {
      console.log(err);
    }
    dispatch(clearAuth());
    dispatch(nelioApiSlice.util.resetApiState());
    router.push("/login");
  };

  return (
    <div className={styles.header}>
      <Link className={styles.logo} href={"/"}>
        <span className={styles.logoMark} aria-hidden="true">
          N
        </span>
        Nelio
      </Link>
      {accessToken && <Link className={styles.navLink} href={"/my-learning"}>My Learning</Link>}
      {accessToken && <Link className={styles.navLink} href={"/chat"}>Messages</Link>}
      <div className={styles.nav}>
        {accessToken ? (
          <header className={styles.actions}>
            <Link className={styles.iconLink} href={"/notifications"} aria-label={`Notifications, ${unreadCount} unread`}>
              <BellIcon />
              {unreadCount > 0 && <span className={styles.badge} aria-hidden="true">{unreadCount > 99 ? "99+" : unreadCount}</span>}
            </Link>
            <span className={styles.user}>
              <span className={styles.avatar} aria-hidden="true">
                <Link href={'/settings'}>
                {me?.avatarUrl ? (
                  <img className={styles.avatarImg} src={me.avatarUrl} alt="" />
                ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 21a8 8 0 0 1 16 0" />
                </svg>
                )}
                </Link>
              </span>
              <Link href={'/settings'} className={styles.userName}>{me?.fullName}</Link>
            </span>
            <button
              className={`${styles.btn} ${styles.ghost}`}
              onClick={handleLogout}
            >
              Log out
            </button>
          </header>
        ) : (
          <header className={styles.actions}>
            <nav className={styles.actions}>
              <Link className={`${styles.btn} ${styles.ghost}`} href={"/login"}>
                Log in
              </Link>
              <Link
                className={`${styles.btn} ${styles.primary}`}
                href={"/register"}
              >
                Sign up
              </Link>
            </nav>
          </header>
        )}
      </div>
    </div>
  );
};
