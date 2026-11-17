import { ChangeEvent, FormEvent } from "react";
import styles from "./Catalog.module.css";

type Props = {
  input: string;
  total: number | undefined;
  onInput: (event: ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

// Gradient header with the title, course count and the search field.
export const CatalogHero = ({ input, total, onInput, onSubmit }: Props) => {
  return (
    <div className={styles.hero}>
      <span className={styles.heroCircleA} aria-hidden="true" />
      <span className={styles.heroCircleB} aria-hidden="true" />

      <div className={styles.head}>
        <span className={styles.eyebrow}>Catalog</span>
        <h1 className={styles.title}>Find your next course</h1>
        {total !== undefined && <span className={styles.count}>Courses: {total}</span>}
      </div>

      <div className={styles.row}>
        <form className={styles.search} onSubmit={onSubmit}>
          <svg className={styles.searchIcon} aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            className={styles.searchInput}
            value={input}
            type="search"
            placeholder="Search courses..."
            aria-label="Search courses"
            onChange={onInput}
          />
          <button className={styles.searchButton}>Search</button>
        </form>
      </div>
    </div>
  );
};
