"use client";

import { useState } from "react";
import { GoogleLogin, type CredentialResponse } from "@react-oauth/google";
import { useGoogleLoginMutation } from "@/lib/features/auth/authApi";
import { setAccessToken } from "@/lib/features/auth/authSlice";
import { useAppDispatch } from "@/lib/hooks";
import { checkErrorType } from "@/lib/api/errors";
import styles from "./styles/GoogleButton.module.css";

type Props = { mode: "login" | "register" };

export const GoogleButton = ({ mode }: Props) => {
  const [googleLogin] = useGoogleLoginMutation();
  const dispatch = useAppDispatch();
  const [error, setError] = useState<string | null>(null);

  const handleSuccess = async ({ credential }: CredentialResponse) => {
    if (!credential) return setError("Google did not return a token");
    setError(null);
    try {
      const response = await googleLogin({ idToken: credential }).unwrap();
      dispatch(setAccessToken(response.accessToken));
    } catch (err) {
      setError(
        checkErrorType(err) ? err.data.message : "Something went wrong :(",
      );
    }
  };

  return (
    <div className={styles.wrap}>
      <GoogleLogin
        onSuccess={handleSuccess}
        onError={() => setError("Google sign-in was cancelled or failed")}
        text={mode === "login" ? "signin_with" : "signup_with"}
        shape="pill"
        width={360}
      />
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
};