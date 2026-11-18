import Link from "next/link";
import styles from "./LessonPlayer.module.css";

type Props = {
  title?: string;
  text: string;
  // Optional button under the text
  link?: { href: string; label: string };
  loading?: boolean;
  error?: boolean;
};

// Centered card for the loading / guest / error states of the lesson player.
export const LessonState = ({ title, text, link, loading, error }: Props) => {
  return (
    <div
      className={`${styles.state} ${error ? styles.stateError : ""}`}
      role={error ? "alert" : undefined}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      {title && <h1 className={styles.stateTitle}>{title}</h1>}
      <p className={styles.stateText}>{text}</p>
      {link && (
        <Link className={styles.primaryButton} href={link.href}>
          {link.label}
        </Link>
      )}
    </div>
  );
};
