'use client'

import Link from "next/link";
import { useEffect, useRef } from "react";
import styles from "./styles/VerifyEmail.module.css";
import { useVerifyEmailMutation } from "@/lib/features/auth/authApi";

type Props = {
  token: string;
};

export const VerifyEmailPage = ({ token }: Props) => {
  const [verify, { isError, isSuccess }] = useVerifyEmailMutation();

  const calledRef = useRef(false);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true

    if (token) verify({ token });
  }, [token, verify]);

  if(!token) return <div className={`${styles.state} ${styles.error}`}>Invalid verification link</div>
  if(isSuccess) return <div className={`${styles.state} ${styles.success}`}>Email verified <Link className={styles.link} href={'/login'}>login</Link></div>
  if(isError) return <div className={`${styles.state} ${styles.error}`}>This link is invalid or has expired <Link className={styles.link} href={'/register'}>register</Link></div>

  return <div className={`${styles.state} ${styles.loading}`}>Verifying your email…</div>;
};
