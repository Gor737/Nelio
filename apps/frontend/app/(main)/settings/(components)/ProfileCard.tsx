import { FormEvent, useState } from "react";
import { useUpdateMeMutation } from "@/lib/features/auth/authApi";
import { MeResponse } from "@/lib/types/authTypes";
import { getErrorMessage } from "@/lib/api/errors";
import { AvatarUploader } from "./AvatarUploader";
import styles from "./Settings.module.css";

type Props = {
  me: MeResponse;
};

// Profile card: avatar + name form. Rendered only once `me` has loaded,
// so defaultValue already holds the real name (no state needed).
export const ProfileCard = ({ me }: Props) => {
  const [updateMe, { isLoading, isSuccess }] = useUpdateMeMutation();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fullName = String(new FormData(event.currentTarget).get("fullName") ?? '').trim();
    if (!fullName) return;

    setError(null);
    try {
      await updateMe({ fullName }).unwrap();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  return (
    <section id="profile" className={styles.card}>
      <h2 className={styles.cardTitle}>Profile</h2>
      <AvatarUploader me={me} />

      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.label}>Full name</span>
            <input
              className={styles.input}
              type="text"
              name="fullName"
              defaultValue={me.fullName}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Email</span>
            <input
              className={styles.input}
              type="email"
              value={me.email}
              readOnly
            />
          </label>
        </div>
        {error && <p className={styles.errorText} role="alert">{error}</p>}
        <div className={styles.actions}>
          {isSuccess && !error && <span className={styles.saved}>Saved ✓</span>}
          <button type="submit" className={styles.primaryButton} disabled={isLoading}>
            {isLoading ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </form>
    </section>
  );
};
