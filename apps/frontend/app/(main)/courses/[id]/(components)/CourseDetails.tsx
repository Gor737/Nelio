"use client";

import Link from "next/link";
import { checkErrorType } from "@/lib/api/errors";
import { useGetCourseQuery } from "@/lib/features/courses/courseApi";
import styles from "./CourseDetails.module.css";
import { Syllabus } from "./Syllabus";
import { CourseSkeleton } from "./CourseSkeleton";
import { CourseNotFound } from "./CourseNotFound";
import { CourseHero } from "./CourseHero";
import { ArrowLeftIcon } from "@/app/components/icons";
import { useAppSelector } from "@/lib/hooks";
import { selectReadyFlag } from "@/lib/features/auth/authSlice";

type Props = {
  id: string;
};

const BackToCatalog = () => (
  <Link href="/" className={styles.back}>
    <ArrowLeftIcon />
    Back to catalog
  </Link>
);

export const CourseDetails = ({ id }: Props) => {
  const readyFlag = useAppSelector(selectReadyFlag);
  const { data, isLoading, isError, error } = useGetCourseQuery({ id }, {skip: !readyFlag});

  if(!readyFlag) return <CourseSkeleton />
  if (isLoading) return <CourseSkeleton />;
  if (isError) {
    if (
      checkErrorType(error) &&
      (error.status === 400 || error.status === 404)
    ) {
      return <CourseNotFound />;
    }
    return (
      <div className={styles.page}>
        <BackToCatalog />
        <p className={`${styles.state} ${styles.error}`}>
          Something went wrong
        </p>
      </div>
    );
  }
  if (!data) return <CourseNotFound />;

  return (
    <div className={styles.page}>
      <BackToCatalog />

      <article className={styles.course}>
        <CourseHero id={id} course={data} />

        <div className={styles.layout}>
          <div className={styles.main}>
            <section className={styles.about}>
              <h2 className={styles.sectionTitle}>About this course</h2>
              <p className={styles.description}>{data.description}</p>
            </section>

            <Syllabus id={id}/>
          </div>

          <aside className={styles.aside}>
            {/* Right column: reserved for later (progress, enrollment info) */}
          </aside>
        </div>
      </article>
    </div>
  );
};
