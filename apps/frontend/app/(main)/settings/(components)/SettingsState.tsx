import Link from "next/link";
import styles from "./Settings.module.css";

type Props = {
  text: string;
  // Optional button under the text (e.g. Log in)
  link?: { href: string; label: string };
  error?: boolean;
};

// Centered card for the loading / guest / error states of the settings page.
export const SettingsState = ({ text, link, error }: Props) => {
  return (
    <div className={`${styles.state} ${error ? styles.stateError : ""}`} role={error ? "alert" : undefined}>
      <p className={styles.stateText}>{text}</p>
      {link && (
        <Link className={styles.primaryButton} href={link.href}>
          {link.label}
        </Link>
      )}
    </div>
  );
};
