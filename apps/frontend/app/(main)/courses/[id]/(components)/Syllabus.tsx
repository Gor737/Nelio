"use client";

import { useGetSyllabusQuery } from "@/lib/features/courses/courseApi";
import styles from "./Syllabus.module.css";

type Props = {
  id: string;
};

export const Syllabus = ({ id }: Props) => {
  const { data, isError, isLoading } = useGetSyllabusQuery({ id });
  if (isLoading)
    return (
      <section className={styles.syllabus}>
        <h2 className={styles.heading}>Course content</h2>
        <p className={styles.state}>Loading ...</p>
      </section>
    );
  if (isError)
    return (
      <section className={styles.syllabus}>
        <h2 className={styles.heading}>Course content</h2>
        <p className={`${styles.state} ${styles.error}`}>Error ...</p>
      </section>
    );
  if (!data?.length)
    return (
      <section className={styles.syllabus}>
        <h2 className={styles.heading}>Course content</h2>
        <p className={styles.state}>No Syllabus yet</p>
      </section>
    );

  const lessonLength = data.reduce((acc, item) => acc + item.lessons.length, 0);
  return (
    <section className={styles.syllabus}>
      <div className={styles.head}>
        <h2 className={styles.heading}>Course content</h2>
        <span className={styles.totals}>
          {data.length} sections · {lessonLength} lessons
        </span>
      </div>

      <ol className={styles.sections}>
        {data.map((item) => {
          return (
            <li key={item.id} className={styles.section}>
              <div className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>{item.title}</h3>
                <span className={styles.sectionCount}>
                  {item.lessons.length} lessons
                </span>
              </div>
              <ol className={styles.lessons}>
                {item.lessons.map((lesson) => {
                  return (
                    <li key={lesson.id} className={styles.lesson}>
                      {lesson.title}
                    </li>
                  );
                })}
              </ol>
            </li>
          );
        })}
      </ol>
    </section>
  );
};
