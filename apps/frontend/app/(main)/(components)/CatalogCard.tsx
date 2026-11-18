"use client";

import { CourseCard } from "@/lib/types/courseTypes";
import styles from "./CatalogCard.module.css";
import Link from "next/link";

type Props = {
  course: CourseCard;
};

export const CatalogCard = ({ course }: Props) => {
  return (
    <Link href={`/courses/${course.id}`} className={styles.card}>
      <div className={styles.cover}>
        <span className={styles.letter}>{course.title.charAt(0)}</span>
      </div>

      <div className={styles.body}>
        <div className={styles.meta}>
          {/* category can be null */}
          <span className={styles.category}>{course.category?.name}</span>
          {course.enrollmentPolicy === "APPROVAL_REQUIRED" && (
            <span className={styles.badge}>Approval required</span>
          )}
        </div>

        <h3 className={styles.title}>{course.title}</h3>
        {/* summary can be null */}
        <p className={styles.summary}>{course.summary}</p>

        <div className={styles.owner}>
          <span className={styles.avatar}>
            {course.owner.fullName.charAt(0)}
          </span>
          <span className={styles.ownerName}>{course.owner.fullName}</span>
        </div>
      </div>
    </Link>
  );
};
