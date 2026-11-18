import styles from "./Notifications.module.css";

// Loading placeholder shaped like NotificationItem
export const NotificationsSkeleton = () => (
  <>
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
  </>
);
