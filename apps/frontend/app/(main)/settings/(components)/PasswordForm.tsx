import { FormEvent, useState } from "react";
import { useChangePasswordMutation } from "@/lib/features/auth/authApi";
import { setAccessToken } from "@/lib/features/auth/authSlice";
import { getErrorMessage } from "@/lib/api/errors";
import { useAppDispatch } from "@/lib/hooks";
import styles from "./Settings.module.css";

const MIN_PASSWORD = 10; // backend rule (10–128)

// Change password. The response contains a NEW access token: the old one stops
// working, so it must be stored like after login, otherwise the next request is 401.
export const PasswordForm = ({ onDone }: { onDone: () => void }) => {
  const dispatch = useAppDispatch();
  const [changePassword, { isLoading }] = useChangePasswordMutation();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    if (newPassword.length < MIN_PASSWORD) return setError(`The new password must have at least ${MIN_PASSWORD} characters.`);
    setError(null);
    try {
      const tokens = await changePassword({ currentPassword, newPassword }).unwrap();
      dispatch(setAccessToken(tokens.accessToken));
      onDone();
    } catch (err) {
      setError(getErrorMessage(err, undefined, { INVALID_CURRENT_PASSWORD: "Current password is incorrect." }));
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <div className={styles.fields}>
        <label className={styles.field}>
          <span className={styles.label}>Current password</span>
          <input className={styles.input} type="password" name="currentPassword" autoComplete="current-password" required />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>New password</span>
          <input className={styles.input} type="password" name="newPassword" autoComplete="new-password" minLength={MIN_PASSWORD} required />
        </label>
      </div>
      {error && <p className={styles.errorText} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="submit" className={styles.primaryButton} disabled={isLoading}>
          {isLoading ? "Saving…" : "Update password"}
        </button>
      </div>
    </form>
  );
};
