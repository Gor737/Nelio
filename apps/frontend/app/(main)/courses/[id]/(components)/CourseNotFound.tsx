import Link from "next/link";
import styles from "./CourseDetails.module.css";

// Centered card when the course does not exist (or the user may not see it).
export const CourseNotFound = () => {
  return (
    <div className={styles.page}>
      <div className={styles.notFound}>
        <span className={styles.notFoundIcon} aria-hidden="true">?</span>
        <h1 className={styles.notFoundTitle}>Course not found</h1>
        <p className={styles.notFoundText}>
          This course doesn&apos;t exist or is no longer available.
        </p>
        <Link href="/" className={styles.primaryLink}>
          Back to catalog
        </Link>
      </div>
    </div>
  );
};
