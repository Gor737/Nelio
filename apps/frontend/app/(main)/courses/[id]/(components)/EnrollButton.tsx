import { checkErrorType } from "@/lib/api/errors";
import {
  selectAccessToken,
  selectReadyFlag,
} from "@/lib/features/auth/authSlice";
import { useGetCourseQuery } from "@/lib/features/courses/courseApi";
import { useEnrollMutation } from "@/lib/features/enrollments/enrollmentsApi";
import { useAppSelector } from "@/lib/hooks";
import { useRouter } from "next/navigation";
import styles from "./EnrollButton.module.css";
import { ContinueLearning } from "./ContinueLearning";
import { ClockIcon } from "@/app/components/icons";

type Props = {
  id: string;
};

export const EnrollButton = ({ id }: Props) => {
  const readyFlag = useAppSelector(selectReadyFlag);
  const { data } = useGetCourseQuery({ id }, { skip: !readyFlag });
  const relationship = data?.viewer.relationship;
  const enrollmentPolicy = data?.enrollmentPolicy;
  const [enroll, { isLoading: enrollLoading, isError: enrollError, error }] =
    useEnrollMutation();
  const router = useRouter();
  const accessToken = useAppSelector(selectAccessToken);

  const onEnroll = () => {
    if (!accessToken) router.push("/login");
    else enroll({ id });
  };

  const getEnrollErrorMessage = (): string => {
    if (!checkErrorType(error)) return "Something went wrong. Try again.";
    if (error.data.code === "ALREADY_ENROLLED")
      return "You're already enrolled";
    return error.data.message || "Something went wrong. Try again.";
  };


  switch (relationship) {
    case "NONE":
    case "STUDENT_LEFT":
    case "REJECTED":
      if (enrollmentPolicy === "INVITATION_ONLY")
        return (
          <div className={`${styles.note} ${styles.noteInfo}`}>
            Invitation only
          </div>
        );
      return (
        <>
          <button
            className={styles.primary}
            onClick={onEnroll}
            disabled={enrollLoading}
          >
            {enrollmentPolicy === "OPEN" ? "Enroll now" : "Request to join"}
          </button>
          {enrollError && (
            <p className={styles.error} role="alert">
              {getEnrollErrorMessage()}
            </p>
          )}
        </>
      );
    case "STUDENT_PENDING":
      return (
        <button className={styles.pending} disabled>
          <ClockIcon className={styles.icon} />
          Request pending
        </button>
      );
    case "STUDENT_ACTIVE":
      return <ContinueLearning id={id} />;
    case "OWNER":
    case "ASSISTANT":
      return null;
    case "REMOVED":
      return (
        <p className={`${styles.note} ${styles.noteDanger}`}>
          You can&apos;t enroll in this course
        </p>
      );
    case "INVITEE":
      return (
        <button className={styles.primary}>
          {/* TODO: invitations endpoint, later */}
          Accept invitation
        </button>
      );
    default:
      return null;
  }
};
