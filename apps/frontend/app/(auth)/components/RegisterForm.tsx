"use client";

import { useForm } from "react-hook-form";
import styles from "./styles/RegisterForm.module.css";
import { RegisterRequest } from "@/lib/types/authTypes";
import { checkErrorType } from "@/lib/api/errors";
import Link from "next/link";
import { useAppSelector } from "@/lib/hooks";
import { selectAccessToken } from "@/lib/features/auth/authSlice";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useRegisterMutation } from "@/lib/features/auth/authApi";
import { GoogleButton } from "./GoogleButton";

export const RegisterForm = () => {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<RegisterRequest>();

  const [registerUser, { isLoading, isSuccess }] = useRegisterMutation();
  const accessToken = useAppSelector(selectAccessToken);
  const router = useRouter();

  useEffect(() => {
    if (accessToken) router.replace("/");
  }, [accessToken, router]);

  const onSubmit = async (data: RegisterRequest) => {
    try {
      const response = await registerUser(data).unwrap();
      console.log("Success: Response -> ", response);
    } catch (err) {
      if (checkErrorType(err) && err.data.code === "VALIDATION_FAILED") {
        err.data.errors?.forEach((error) =>
          setError(error.field as keyof RegisterRequest, {
            type: "server",
            message: error.messages[0],
          }),
        );
      } else {
        let message: string;
        if (checkErrorType(err)) {
          message = err.data.message;
        } else {
          message = "Something went wrong :(";
        }
        setError("root.server", { message });
      }
      console.log("error:", err);
    }
  };

  if (isSuccess)
    return (
      <div className={styles.success}>
        <span className={styles.successIcon} aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="3" />
            <path d="m4 7 8 6 8-6" />
          </svg>
        </span>
        <h1 className={styles.title}>Check your email</h1>
        <p className={styles.text}>
          We sent a verification link to your email. Open it to activate your
          account.
        </p>
        <Link className={styles.link} href={"/login"}>
          Go to login
        </Link>
      </div>
    );

  return (
    <form noValidate className={styles.form} onSubmit={handleSubmit(onSubmit)}>
      <div className={styles.heading}>
        <h1 className={styles.title}>Create your account</h1>
        <p className={styles.subtitle}>
          Join Nelio to enrol in courses and chat with your class.
        </p>
      </div>

      {errors.root?.server?.message && (
        <span className={styles.error}>{errors.root.server.message}</span>
      )}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="fullName">
          Full name
        </label>
        <input
          autoComplete="name"
          id="fullName"
          type="text"
          className={styles.input}
          {...register("fullName", {
            required: "Full Name is required",
            maxLength: { value: 100, message: "Max length is 100" },
          })}
        />
        {errors.fullName && (
          <span className={styles.error}>{errors.fullName.message}</span>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="email">
          Email
        </label>
        <input
          autoComplete="email"
          id="email"
          type="email"
          className={styles.input}
          {...register("email", {
            required: "Email is required",
            maxLength: { value: 254, message: "Max length is 254" },
            pattern: {
              value: /^[^ \s@]+@[^ \s@]+\.[^ \s@]+$/,
              message: "Invalid email",
            },
          })}
        />
        {errors.email && (
          <span className={styles.error}>{errors.email.message}</span>
        )}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="password">
          Password
        </label>
        <input
          autoComplete="new-password"
          id="password"
          type="password"
          className={styles.input}
          {...register("password", {
            required: "password is required",
            minLength: { value: 10, message: "Min length is 10" },
            maxLength: { value: 128, message: "Max length is 128" },
          })}
        />
        {errors.password && (
          <span className={styles.error}>{errors.password.message}</span>
        )}
      </div>

      <button type="submit" className={styles.button} disabled={isLoading}>
        {isLoading ? "...Creating account" : "Register"}
      </button>
      <div className={styles.divider}>
        <span>or</span>
      </div>
      <GoogleButton mode="register" />
      <p className={styles.footerText}>
        Already have an account?{" "}
        <Link className={styles.link} href={"/login"}>
          Log in
        </Link>
      </p>
    </form>
  );
};
