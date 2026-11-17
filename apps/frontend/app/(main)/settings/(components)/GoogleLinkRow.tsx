"use client";

import { useState } from "react";
import { GoogleLogin, type CredentialResponse } from "@react-oauth/google";
import {
  useLinkGoogleMutation,
  useUnlinkGoogleMutation,
} from "@/lib/features/auth/authApi";
import { checkErrorType } from "@/lib/api/errors";
import styles from "./Settings.module.css";
import { error } from "console";
import Error from "next/error";

type Message = { type: "ok" | "error"; text: string } | null;

// /me does not say whether Google is linked, so both actions are always shown
// and the result message tells the user the state.
export const GoogleLinkRow = () => {
  const [linkGoogle] = useLinkGoogleMutation();
  const [unlinkGoogle, { isLoading: isUnlinking }] = useUnlinkGoogleMutation();
  const [message, setMessage] = useState<Message>(null);

  const handleLink = async ({ credential }: CredentialResponse) => {
    setMessage(null);
    if (!credential)
      return setMessage({ type: "error", text: "Google did not return a token" });
    try {
      await linkGoogle({ idToken: credential }).unwrap();
      setMessage({ type: "ok", text: "Google account linked" });
    } catch (err) {
      if (!checkErrorType(err))
        setMessage({ type: "error", text: "Something went wrong :(" });
      else if (err.status === 409)
        setMessage({
          type: "error",
          text: "Google is already linked to this or another account",
        });
      else setMessage({ type: "error", text: err.data.message });
    }
  };

  const handleUnlink = async () => {
    setMessage(null);
    try {
      await unlinkGoogle().unwrap();
      setMessage({ type: "ok", text: "Google account unlinked" });
    } catch (err) {
      if (!checkErrorType(err))
        setMessage({ type: "error", text: "Something went wrong :(" });
      else if (err.status === 404)
        setMessage({ type: "error", text: "No Google account is linked" });
      else if (err.data.code === "NO_LOGIN_METHOD_REMAINING")
        setMessage({
          type: "error",
          text: "Set a password first, otherwise you could not log in",
        });
      else setMessage({ type: "error", text: err.data.message });
    }
  };

  return (
    <div className={styles.row}>
      <span className={styles.rowText}>Google account</span>
      {message && (
        <span
          className={message.type === "ok" ? styles.saved : styles.errorText}
        >
          {message.text}
        </span>
      )}
      <GoogleLogin
        onSuccess={handleLink}
        onError={() =>
          setMessage({ type: "error", text: "Google sign-in was cancelled" })
        }
        text="continue_with"
        shape="pill"
        size="medium"
      />
      <button
        type="button"
        className={styles.textButton}
        onClick={handleUnlink}
        disabled={isUnlinking}
      >
        {isUnlinking ? "Unlinking…" : "Unlink"}
      </button>
    </div>
  );
};
