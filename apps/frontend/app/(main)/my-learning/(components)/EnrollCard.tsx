import Link from "next/link";
import { MyEnrollment } from "@/lib/types/enrollmentTypes";
import styles from "./EnrollCard.module.css";

type Props = {
  enroll: MyEnrollment;
};

export const EnrollCard = ({ enroll }: Props) => {
  return (
    <Link
      href={enroll.lastVisitedLessonId ? `/courses/${enroll.courseId}/lesson/${enroll.lastVisitedLessonId}` :`/courses/${enroll.courseId}`}
      className={styles.card}
      data-status={enroll.status}
    >
      <div className={styles.cover}>
        <span className={styles.letter}>{enroll.courseTitle.charAt(0)}</span>
      </div>

      <div className={styles.body}>
        <span className={styles.status}>{enroll.status}</span>
        <h3 className={styles.title}>{enroll.courseTitle}</h3>

        <div className={styles.progress}>
          <div
            className={styles.track}
            role="progressbar"
            aria-label="Course progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={enroll.progress.percent}
          >
            <span
              className={styles.bar}
              style={{ width: `${enroll.progress.percent}%` }}
            />
          </div>
          <span className={styles.progressText}>
            {enroll.progress.completedLessons} of {enroll.progress.totalLessons} lessons
            {" · "}
            {enroll.progress.percent}%
          </span>
        </div>
      </div>

      <span className={styles.action}>
        Open course
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </svg>
      </span>
    </Link>
  );
};
