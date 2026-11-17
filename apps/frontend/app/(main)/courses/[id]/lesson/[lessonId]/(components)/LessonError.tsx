import { checkErrorType } from "@/lib/api/errors";
import { LessonState } from "./LessonState";

type Props = {
  courseId: string;
  // The error of the lesson request (decides 403 / 404)
  error: unknown;
};

// 403: not an ACTIVE student of this course. 404: lesson not published or wrong id.
export const LessonError = ({ courseId, error }: Props) => {
  const status = checkErrorType(error) ? error.status : undefined;
  const coursePage = `/courses/${courseId}`;

  if (status === 403)
    return (
      <LessonState
        title="Enroll in this course first"
        text="Lessons are available to students of this course."
        link={{ href: coursePage, label: "Go to course page" }}
      />
    );

  if (status === 404)
    return (
      <LessonState
        title="Lesson not found"
        text="This lesson doesn't exist or is not published."
        link={{ href: coursePage, label: "Back to course" }}
      />
    );

  return (
    <LessonState
      error
      title="Something went wrong"
      text="We couldn't load this lesson. Please try again."
    />
  );
};
