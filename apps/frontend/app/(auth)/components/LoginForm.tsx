"use client";

import Link from "next/link";
import { useForm } from "react-hook-form";
import styles from "./styles/RegisterForm.module.css";
import { LoginRequest } from "@/lib/types/authTypes";
import { checkErrorType } from "@/lib/api/errors";
import { useAppDispatch, useAppSelector } from "@/lib/hooks";
import {
  selectAccessToken,
  setAccessToken,
} from "@/lib/features/auth/authSlice";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useLoginMutation } from "@/lib/features/auth/authApi";
import { GoogleButton } from "./GoogleButton";

export const LoginForm = () => {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<LoginRequest>();

  const [loginUser, { isLoading }] = useLoginMutation();

  const accessToken = useAppSelector(selectAccessToken);
  const dispatch = useAppDispatch();
  const router = useRouter();

  useEffect(() => {
    if (accessToken) router.replace("/");
  }, [accessToken, router]);

  const onSubmit = async (data: LoginRequest) => {
    try {
      const response = await loginUser(data).unwrap();
      dispatch(setAccessToken(response.accessToken));
    } catch (err) {
      let message: string;
      if (checkErrorType(err)) {
        message = err.data.message;
      } else {
        message = "Something went wrong :(";
      }
      setError("root.server", { message });
    }
  };

  return (
    <form noValidate className={styles.form} onSubmit={handleSubmit(onSubmit)}>
      <div className={styles.heading}>
        <h1 className={styles.title}>Welcome back</h1>
        <p className={styles.subtitle}>Log in to continue learning on Nelio.</p>
      </div>

      {errors.root?.server?.message && (
        <span className={styles.error}>{errors.root.server.message}</span>
      )}
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
          autoComplete="current-password"
          id="password"
          type="password"
          className={styles.input}
          {...register("password", {
            required: "password is required",
          })}
        />
        {errors.password && (
          <span className={styles.error}>{errors.password.message}</span>
        )}
      </div>

      <button disabled={isLoading} type="submit" className={styles.button}>
        {isLoading ? "Logging in" : "Login"}
      </button>
      <div className={styles.divider}>
        <span>or</span>
      </div>
      <GoogleButton mode="login" />
      <p className={styles.footerText}>
        Don&apos;t have an account?{" "}
        <Link className={styles.link} href={"/register"}>
          Sign up
        </Link>
      </p>
    </form>
  );
};
