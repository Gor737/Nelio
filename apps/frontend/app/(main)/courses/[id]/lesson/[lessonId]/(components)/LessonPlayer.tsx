"use client";

import { useEffect } from "react";
import { selectAccessToken, selectReadyFlag } from "@/lib/features/auth/authSlice";
import { useGetLessonQuery, useGetOutlineQuery } from "@/lib/features/lessons/lessonApi";
import { useUpdateLastVisitedMutation } from "@/lib/features/enrollments/enrollmentsApi";
import { useAppSelector } from "@/lib/hooks";
import { LessonState } from "./LessonState";
import { LessonError } from "./LessonError";
import { LessonSidebar } from "./LessonSidebar";
import { LessonBlock } from "./LessonBlock";
import { LessonNav } from "./LessonNav";
import styles from "./LessonPlayer.module.css";

type Params = {
  courseId: string;
  lessonId: string;
};

export const LessonPlayer = ({ courseId, lessonId }: Params) => {
  const readyFlag = useAppSelector(selectReadyFlag);
  const accessToken = useAppSelector(selectAccessToken);
  const skip = !readyFlag || !accessToken;

  const {
    data: lesson,
    isLoading: lessonLoading,
    isError: lessonIsError,
    error: lessonError,
  } = useGetLessonQuery({ courseId, lessonId }, { skip });
  const { data: outline, isLoading: outlineLoading, isError: outlineIsError } =
    useGetOutlineQuery({ id: courseId }, { skip });
  const [updateLastVisited] = useUpdateLastVisitedMutation();

  // Remember this lesson for "Continue learning" (once it has loaded)
  useEffect(() => {
    if (!lesson) return;
    updateLastVisited({ courseId, lessonId });
  }, [lesson?.id, courseId, lessonId, updateLastVisited]);

  // 1. We don't know yet if the user is logged in (AuthBootstrap still refreshing)
  if (!readyFlag) return <LessonState loading text="Loading lesson…" />;

  // 2. Guest
  if (!accessToken)
    return (
      <LessonState
        title="Log in to continue"
        text="You need an account to open lessons."
        link={{ href: "/login", label: "Sign in" }}
      />
    );

  // 3. The lesson or the outline is still loading
  if (lessonLoading || outlineLoading) return <LessonState loading text="Loading lesson…" />;

  // 4. Errors
  if (lessonIsError || outlineIsError) return <LessonError courseId={courseId} error={lessonError} />;

  return (
    <div className={styles.page}>
      <LessonSidebar courseId={courseId} lessonId={lessonId} outline={outline} />

      <article className={styles.main}>
        <header className={styles.head}>
          <span className={styles.eyebrow}>Lesson</span>
          <h1 className={styles.title}>{lesson?.title}</h1>
        </header>

        <div className={styles.blocks}>
          {lesson?.blocks.map((block) => <LessonBlock key={block.id} block={block} />)}
        </div>

        <LessonNav key={lessonId} courseId={courseId} lessonId={lessonId} outline={outline} />
      </article>
    </div>
  );
};
