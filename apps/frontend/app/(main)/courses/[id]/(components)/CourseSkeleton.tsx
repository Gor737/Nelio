import styles from "./CourseDetails.module.css";

// Grey placeholder shaped like the course page while it loads.
export const CourseSkeleton = () => {
  return (
    <div className={styles.page}>
      <div className={styles.skeleton} aria-hidden="true">
        <div className={styles.skeletonHero}>
          <div className={styles.skeletonText}>
            <span className={styles.skeletonPill} />
            <span className={styles.skeletonTitle} />
            <span className={styles.skeletonLine} />
            <span className={styles.skeletonLineShort} />
          </div>
          <span className={styles.skeletonCover} />
        </div>
        <span className={styles.skeletonCard} />
        <span className={styles.skeletonCard} />
      </div>
      <p className={styles.srOnly}>Loading ...</p>
    </div>
  );
};
