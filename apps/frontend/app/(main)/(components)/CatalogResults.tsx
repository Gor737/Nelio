import { CatalogPage } from "@/lib/types/courseTypes";
import { CatalogCard } from "./CatalogCard";
import { CatalogPagination } from "./CatalogPagination";
import styles from "./Catalog.module.css";

type Props = {
  data: CatalogPage | undefined;
  isLoading: boolean;
  isError: boolean;
  search: string;
  page: number;
  pageSize: number;
  onPrev: () => void;
  onNext: () => void;
};

// Loading / error / empty states, then the course grid and pagination.
export const CatalogResults = ({ data, isLoading, isError, search, page, pageSize, onPrev, onNext }: Props) => {
  if (isLoading) return <p className={styles.state}>Loading ...</p>;
  if (isError)
    return <p className={`${styles.state} ${styles.error}`}>Errors: ...</p>;
  if (!data || !data.items.length) {
    return (
      <p className={styles.state}>
        {search ? `Nothing found for "${search}".` : "No courses yet."}
      </p>
    );
  }
  const totalPages = Math.ceil(data.total / pageSize);
  return (
    <>
      <div className={styles.grid}>
        {data.items.map((course) => (
          <CatalogCard course={course} key={course.id} />
        ))}
      </div>

      {data.total > pageSize && (
        <CatalogPagination page={page} totalPages={totalPages} onPrev={onPrev} onNext={onNext} />
      )}
    </>
  );
};
