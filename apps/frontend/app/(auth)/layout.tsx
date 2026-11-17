import type { ReactNode } from "react";

import styles from "./styles/layout.module.css";

interface Props {
  readonly children: ReactNode;
}

export default function AuthLayout({ children }: Props) {
  return (
    <div className={styles.page}>
      <aside className={styles.panel}>
        <span className={styles.circleA} aria-hidden="true" />
        <span className={styles.circleB} aria-hidden="true" />
        <span className={styles.circleC} aria-hidden="true" />

        <span className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">N</span>
          Nelio
        </span>

        <div className={styles.pitch}>
          <p className={styles.headline}>
            Learn at your own pace. Talk with your class.
          </p>
          <p className={styles.subline}>
            Courses, lessons and class chat in one calm place, for students
            and teachers alike.
          </p>
        </div>
      </aside>

      <main className={styles.content}>
        <div className={styles.card}>{children}</div>
      </main>
    </div>
  );
}
