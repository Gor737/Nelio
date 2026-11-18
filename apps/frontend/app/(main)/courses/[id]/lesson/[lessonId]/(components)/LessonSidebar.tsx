import Link from "next/link";
import { CourseOutline } from "@/lib/types/lessonTypes";
import { ArrowLeftIcon } from "@/app/components/icons";
import styles from "./LessonPlayer.module.css";
import { useGetMyEnrollmentQuery } from "@/lib/features/enrollments/enrollmentsApi";

type Props = {
  courseId: string;
  lessonId: string;
  outline: CourseOutline | undefined;
};

// Left column: back link, progress and the course outline.
export const LessonSidebar = ({ courseId, lessonId, outline }: Props) => {
  const { data } = useGetMyEnrollmentQuery({ id: courseId });
  const completedLessons = data?.progress.completedLessons ?? 0;
  const totalLessons = data?.progress.totalLessons ?? 0;
  const percent = data?.progress.percent ?? 0;

  return (
    <aside className={styles.sidebar}>
      <Link href={`/courses/${courseId}`} className={styles.back}>
        <ArrowLeftIcon />
        Back to course
      </Link>

      {/* Course progress (GET /courses/:id/enrollments/me), refreshes after "Mark as complete" */}
      <div className={styles.progress}>
        <span className={styles.progressLabel}>Your progress</span>
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Course progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span className={styles.bar} style={{ width: `${percent}%` }} />
        </div>
        <span className={styles.progressText}>
          {completedLessons} of {totalLessons} lessons · {percent}%
        </span>
      </div>

      <nav aria-label="Course content">
        {outline?.sections.map((section) => (
          <div key={section.id} className={styles.section}>
            <h2 className={styles.sectionTitle}>{section.title}</h2>
            <ol className={styles.lessons}>
              {section.lessons.map((item, index) => (
                <li key={item.id}>
                  <Link
                    href={`/courses/${courseId}/lesson/${item.id}`}
                    className={`${styles.lessonLink} ${item.id === lessonId ? styles.lessonLinkActive : ""}`}
                    aria-current={item.id === lessonId ? "page" : undefined}
                  >
                    <span className={styles.lessonNumber}>{index + 1}</span>
                    <span className={styles.lessonTitle}>{item.title}</span>
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </nav>
    </aside>
  );
};
