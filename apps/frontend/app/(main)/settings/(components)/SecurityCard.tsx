import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLogoutAllMutation } from "@/lib/features/auth/authApi";
import { clearAuth } from "@/lib/features/auth/authSlice";
import { nelioApiSlice } from "@/lib/api/nelioApiSlice";
import { useAppDispatch } from "@/lib/hooks";
import { PasswordForm } from "./PasswordForm";
import styles from "./Settings.module.css";
import { GoogleLinkRow } from "./GoogleLinkRow";

// Password, Google link and "log out everywhere" with an inline two-step confirm.
export const SecurityCard = () => {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const [logoutAll, { isLoading }] = useLogoutAllMutation();
  const [showPassword, setShowPassword] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const handleLogoutAll = async () => {
    try {
      await logoutAll().unwrap();
    } catch {
      // even if it fails, clear this browser's session (same as the normal logout)
    }
    dispatch(clearAuth());
    dispatch(nelioApiSlice.util.resetApiState());
    router.push("/login");
  };

  return (
    <section id="security" className={styles.card}>
      <h2 className={styles.cardTitle}>Security</h2>

      <div className={styles.row}>
        <span className={styles.rowText}>Password</span>
        {passwordChanged && !showPassword && (
          <span className={styles.saved}>Password updated ✓</span>
        )}
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => {
            setShowPassword(!showPassword);
            setPasswordChanged(false);
          }}
        >
          {showPassword ? "Cancel" : "Change password"}
        </button>
      </div>
      {showPassword && (
        <PasswordForm
          onDone={() => {
            setShowPassword(false);
            setPasswordChanged(true);
          }}
        />
      )}

      <GoogleLinkRow />

      <div className={styles.row}>
        <span className={styles.rowText}>Log out of all devices</span>
        {confirming ? (
          <span className={styles.confirm}>
            <span className={styles.confirmText}>Are you sure?</span>
            <button
              type="button"
              className={styles.dangerButton}
              onClick={handleLogoutAll}
              disabled={isLoading}
            >
              {isLoading ? "Logging out…" : "Yes, log out"}
            </button>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={styles.dangerButton}
            onClick={() => setConfirming(true)}
          >
            Log out everywhere
          </button>
        )}
      </div>
    </section>
  );
};
