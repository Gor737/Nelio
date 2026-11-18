import Link from "next/link";
import { CourseOutline } from "@/lib/types/lessonTypes";
import styles from "./LessonPlayer.module.css";
import { useMarkAsCompleteMutation } from "@/lib/features/lessons/lessonApi";

type Props = {
  courseId: string;
  lessonId: string;
  outline: CourseOutline | undefined;
};

// Bottom bar: Previous / Mark as complete / Next.
export const LessonNav = ({ courseId, lessonId, outline }: Props) => {

  const [markAsComplete, { isLoading, isSuccess, data }] = useMarkAsCompleteMutation();
  // All lessons of the course in one list, so Next can jump to the next section
  const allLessons = outline?.sections.flatMap((section) => section.lessons) ?? [];
  const currentLessonIdx = allLessons.findIndex((l) => l.id === lessonId);
  const prevLesson = currentLessonIdx !== -1 ? allLessons[currentLessonIdx - 1] : undefined;
  const nextLesson = currentLessonIdx !== -1 ? allLessons[currentLessonIdx + 1] : undefined;

  return (
    <>
    <div className={styles.bottomBar}>
      {prevLesson ? (
        <Link href={`/courses/${courseId}/lesson/${prevLesson.id}`} className={styles.secondaryButton}>
          ← Previous
        </Link>
      ) : (
        <button type="button" disabled className={styles.secondaryButton}>
          ← Previous
        </button>
      )}

      <button onClick={() => markAsComplete({courseId, lessonId})} disabled={isLoading} type="button" className={styles.primaryButton}>
        {isLoading ? "Saving…" : isSuccess ? "Completed ✓" : "Mark as complete"}
      </button>

      {nextLesson ? (
        <Link href={`/courses/${courseId}/lesson/${nextLesson.id}`} className={styles.secondaryButton}>
          Next lesson →
        </Link>
      ) : (
        <button type="button" disabled className={styles.secondaryButton}>
          Next lesson →
        </button>
      )}
    </div>

    {/* courseCompleted is true only in the request that finished the whole course */}
    {data?.courseCompleted && (
      <p className={styles.courseDone} role="status">🎉 You finished the course!</p>
    )}
    </>
  );
};
