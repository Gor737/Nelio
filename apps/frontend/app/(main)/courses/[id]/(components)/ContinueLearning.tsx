import Link from "next/link";
import { useGetOutlineQuery } from "@/lib/features/lessons/lessonApi";
import { SmallPlayIcon } from "@/app/components/icons";
import styles from "./EnrollButton.module.css";
import { useGetMyEnrollmentQuery } from "@/lib/features/enrollments/enrollmentsApi";

type Props = {
  id: string;
};

// "Continue learning" for an ACTIVE student. Rendered only in that case,
// so the outline request (students/teachers only) never runs for guests.
export const ContinueLearning = ({ id }: Props) => {
  const { data: outline } = useGetOutlineQuery({ id });
  const firstLessonId = outline?.sections[0]?.lessons[0]?.id;
  const {data} = useGetMyEnrollmentQuery({id});
  const lessonId = data?.lastVisitedLessonId ?? firstLessonId;
  
  if (lessonId)
    return (
      <Link href={`/courses/${id}/lesson/${lessonId}`} className={styles.primary}>
        <SmallPlayIcon className={styles.icon} />
        Continue learning
      </Link>
    );

  return (
    <button disabled className={styles.primary}>
      <SmallPlayIcon className={styles.icon} />
      Continue learning
    </button>
  );
};
