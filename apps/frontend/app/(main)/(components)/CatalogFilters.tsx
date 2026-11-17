import { Ref, SortCourse } from "@/lib/types/courseTypes";
import styles from "./Catalog.module.css";

type Props = {
  categories: Ref[] | undefined;
  categoryId: string | undefined;
  sort: SortCourse;
  search: string;
  onCategoryChange: (id: string | undefined) => void;
  onSortChange: (sort: SortCourse) => void;
};

// Category chips + sort select.
export const CatalogFilters = ({ categories, categoryId, sort, search, onCategoryChange, onSortChange }: Props) => {
  return (
    <div className={styles.toolbar}>
      {categories && (
        <div className={styles.chips} role="group" aria-label="Filter by category">
          <button
            type="button"
            className={`${styles.chip} ${!categoryId ? styles.chipActive : ""}`}
            onClick={() => onCategoryChange(undefined)}
          >
            All
          </button>
          {categories.map((category) => (
            <button
              type="button"
              key={category.id}
              className={`${styles.chip} ${categoryId === category.id ? styles.chipActive : ""}`}
              onClick={() => onCategoryChange(category.id)}
            >
              {category.name}
            </button>
          ))}
        </div>
      )}

      <label className={styles.sort}>
        <span className={styles.sortLabel}>Sort by</span>
        <select
          className={styles.sortSelect}
          value={sort}
          onChange={(event) => onSortChange(event.target.value as SortCourse)}
        >
          <option value="newest">Newest</option>
          <option value="title">Title A–Z</option>
          {search && <option value="relevance">Relevance</option>}
        </select>
      </label>
    </div>
  );
};
