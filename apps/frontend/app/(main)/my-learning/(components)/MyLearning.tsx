"use client";

import { selectAccessToken, selectReadyFlag } from "@/lib/features/auth/authSlice";
import { useGetMyEnrollmentsQuery } from "@/lib/features/enrollments/enrollmentsApi";
import { useAppSelector } from "@/lib/hooks";
import { EnrollCard } from "./EnrollCard";
import styles from "./MyLearning.module.css";
import Link from "next/link";

export const MyLearning = () => {
  const accessToken = useAppSelector(selectAccessToken);
  const readyFlag = useAppSelector(selectReadyFlag);

  const {
    data: myEnrolls,
    isLoading,
    isError,
  } = useGetMyEnrollmentsQuery({}, { skip: !accessToken });

  // Same title block on every state of the page
  const pageHead = (
    <header className={styles.head}>
      <h1 className={styles.title}>My learning</h1>
      <p className={styles.subtitle}>
        Your courses and your progress, all in one place.
      </p>
    </header>
  );

  if(!readyFlag) return <div>Loading...</div>

  if(!accessToken) return (
    <section className={styles.page}>
      {pageHead}
      <div className={styles.emptyBox}>
        <span className={styles.emptyIcon} aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </span>
        <Link className={styles.primaryLink} href={'/login'}>Log in to see your courses</Link>
      </div>
    </section>
  )
  if (isLoading) return (
    <section className={styles.page}>
      {pageHead}
      <div className={styles.list} aria-hidden="true">
        <div className={styles.skeletonRow}>
          <span className={styles.skeletonCover} />
          <span className={styles.skeletonLines}>
            <span className={styles.skeletonPill} />
            <span className={styles.skeletonTitle} />
            <span className={styles.skeletonBar} />
          </span>
        </div>
        <div className={styles.skeletonRow}>
          <span className={styles.skeletonCover} />
          <span className={styles.skeletonLines}>
            <span className={styles.skeletonPill} />
            <span className={styles.skeletonTitle} />
            <span className={styles.skeletonBar} />
          </span>
        </div>
        <div className={styles.skeletonRow}>
          <span className={styles.skeletonCover} />
          <span className={styles.skeletonLines}>
            <span className={styles.skeletonPill} />
            <span className={styles.skeletonTitle} />
            <span className={styles.skeletonBar} />
          </span>
        </div>
      </div>
      <p className={styles.srOnly}>Loading...</p>
    </section>
  );
  if(isError) return (
    <section className={styles.page}>
      {pageHead}
      <div className={styles.errorBox} role="alert">Error...</div>
    </section>
  )
  if (!myEnrolls?.items.length)
    return (
      <section className={styles.page}>
        {pageHead}
        <div className={styles.emptyBox}>
          <span className={styles.emptyIcon} aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 7l10-4 10 4-10 4L2 7Z" />
              <path d="M6 9v5c0 1.7 2.7 3 6 3s6-1.3 6-3V9" />
            </svg>
          </span>
          <Link className={styles.primaryLink} href={"/"}>You’re not enrolled in any course yet</Link>
        </div>
      </section>
    );

  return (
    <section className={styles.page}>
      {pageHead}

      <div className={styles.list}>
        {myEnrolls?.items.map((enroll) => (
          <EnrollCard key={enroll.courseId} enroll={enroll} />
        ))}
      </div>
    </section>
  );
};
