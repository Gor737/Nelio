"use client";

import { useMeQuery } from "@/lib/features/auth/authApi";
import {
  selectAccessToken,
  selectReadyFlag,
} from "@/lib/features/auth/authSlice";
import { useAppSelector } from "@/lib/hooks";
import { SettingsNav } from "./SettingsNav";
import styles from "./Settings.module.css";
import { SettingsState } from "./SettingsState";
import { ProfileCard } from "./ProfileCard";
import { SecurityCard } from "./SecurityCard";
import { TeachingCard } from "./TeachingCard";

export const Settings = () => {
  const readyFlag = useAppSelector(selectReadyFlag);
  const accessToken = useAppSelector(selectAccessToken);

  const { data, isLoading, isError } = useMeQuery(undefined, {
    skip: !readyFlag || !accessToken,
  });
  if (!readyFlag) return <SettingsState text="Loading…" />;
  if (!accessToken)
    return (
      <SettingsState
        text="Log in to manage your settings."
        link={{ href: "/login", label: "Log in" }}
      />
    );
  if (isLoading) return <SettingsState text="Loading…" />;
  if (isError)
    return (
      <SettingsState
        error
        text="Couldn't load your settings. Please try again."
      />
    );
  if (!data) return <SettingsState text="No such data yet" />;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>Settings</h1>
        <p className={styles.subtitle}>
          Manage your profile, security and teaching.
        </p>
      </header>

      <div className={styles.layout}>
        <SettingsNav />

        <div className={styles.main}>
          <ProfileCard me={data} />

          <SecurityCard />
          <TeachingCard me={data} />
        </div>
      </div>
    </div>
  );
};
