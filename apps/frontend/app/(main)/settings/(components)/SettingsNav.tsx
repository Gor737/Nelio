import styles from "./Settings.module.css";

// Static in-page navigation to the sections below (plain anchors, no logic).
export const SettingsNav = () => {
  return (
    <nav className={styles.nav} aria-label="Settings sections">
      <a className={styles.navLink} href="#profile">Profile</a>
      <a className={styles.navLink} href="#security">Security</a>
      <a className={styles.navLink} href="#teaching">Teaching</a>
    </nav>
  );
};
