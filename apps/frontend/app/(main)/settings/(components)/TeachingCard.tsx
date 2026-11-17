import { FormEvent, useState } from "react";
import { useApplyTeacherMutation, useGetTeacherApplicationQuery } from "@/lib/features/teacher/teacherApi";
import { getErrorMessage } from "@/lib/api/errors";
import { MeResponse } from "@/lib/types/authTypes";
import styles from "./Settings.module.css";

// Teacher application: status from GET /me/teacher-application, apply with a message (10–1000 chars).
export const TeachingCard = ({ me }: { me: MeResponse }) => {
  const isTeacher = me.roles.some((r) => r.role === "TEACHER" && r.status === "ACTIVE");
  const { data, isLoading } = useGetTeacherApplicationQuery(undefined, { skip: isTeacher });
  const [apply, { isLoading: sending }] = useApplyTeacherMutation();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = String(new FormData(event.currentTarget).get("message") ?? "").trim();
    if (message.length < 10) return setError("Tell us a bit more (at least 10 characters).");
    setError(null);
    try {
      await apply({ message }).unwrap();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const status = isTeacher ? "ACTIVE" : data?.status;
  const canApply = status === "NONE" || status === "REJECTED" || status === "REVOKED";

  return (
    <section id="teaching" className={styles.card}>
      <h2 className={styles.cardTitle}>Teaching</h2>
      {isLoading && <p className={styles.muted}>Loading…</p>}
      {status === "ACTIVE" && <p className={`${styles.badge} ${styles.badgeSuccess}`}>You are a teacher ✓</p>}
      {status === "PENDING" && <p className={`${styles.badge} ${styles.badgePending}`}>Application sent, waiting for an admin</p>}
      {(status === "REJECTED" || status === "REVOKED") && (
        <p className={styles.errorText}>
          {status === "REJECTED" ? "Your application was rejected." : "Your teacher role was revoked."}
          {data?.decisionNote && ` Note: ${data.decisionNote}`} You can apply again.
        </p>
      )}
      {canApply && (
        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span className={styles.label}>Why do you want to teach on Nelio?</span>
            <textarea className={styles.textarea} name="message" rows={4} minLength={10} maxLength={1000} required />
          </label>
          {error && <p className={styles.errorText} role="alert">{error}</p>}
          <div className={styles.actions}>
            <button type="submit" className={styles.primaryButton} disabled={sending}>
              {sending ? "Sending…" : "Apply to teach"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
};
