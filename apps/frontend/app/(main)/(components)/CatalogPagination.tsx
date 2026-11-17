import styles from "./Catalog.module.css";

type Props = {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
};

// "← Previous  Page X of Y  Next →" under the grid.
export const CatalogPagination = ({ page, totalPages, onPrev, onNext }: Props) => {
  return (
    <nav className={styles.pagination} aria-label="Pagination">
      <button disabled={page === 1} type="button" className={styles.pageButton} onClick={onPrev}>
        ← Previous
      </button>
      <p className={styles.pageInfo}>
        Page {page} of {totalPages}
      </p>
      <button disabled={page === totalPages} type="button" className={styles.pageButton} onClick={onNext}>
        Next →
      </button>
    </nav>
  );
};
