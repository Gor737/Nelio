import { CourseDetails as CourseData } from "@/lib/types/courseTypes";
import { EnrollButton } from "./EnrollButton";
import styles from "./CourseDetails.module.css";

type Props = {
  id: string;
  course: CourseData;
};

// Gradient header: category, title, summary, teacher, and the cover + enroll card.
export const CourseHero = ({ id, course }: Props) => {
  return (
    <header className={styles.hero}>
      <span className={styles.heroCircle} aria-hidden="true" />

      <div className={styles.body}>
        <div className={styles.pills}>
          <span className={styles.category}>{course.category?.name}</span>
        </div>
        <h1 className={styles.title}>{course.title}</h1>
        <p className={styles.summary}>{course.summary}</p>

        <div className={styles.owner}>
          <span className={styles.avatar}>{course.owner.fullName.charAt(0)}</span>
          <span className={styles.ownerText}>
            <span className={styles.ownerLabel}>Teacher</span>
            <span className={styles.ownerName}>{course.owner.fullName}</span>
          </span>
        </div>
      </div>

      <div className={styles.side}>
        <div className={styles.cover}>
          <span className={styles.letter}>{course.title.charAt(0)}</span>
        </div>
        <div className={styles.enrollSlot}>
          <EnrollButton id={id} />
        </div>
      </div>
    </header>
  );
};
