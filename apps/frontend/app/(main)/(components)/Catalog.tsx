"use client";

import {
  useGetCategoriesQuery,
  useGetCoursesQuery,
} from "@/lib/features/courses/courseApi";
import styles from "./Catalog.module.css";
import { ChangeEvent, FormEvent, useState } from "react";
import { useDebounce } from "@/lib/hooks/useDebounce";
import { SortCourse } from "@/lib/types/courseTypes";
import { CatalogHero } from "./CatalogHero";
import { CatalogFilters } from "./CatalogFilters";
import { CatalogResults } from "./CatalogResults";

const PAGE_SIZE = 12;

export const Catalog = () => {
  const [input, setInput] = useState<string>("");
  const search = useDebounce(input, 400);
  const { data: categories } = useGetCategoriesQuery();
  const [categoryId, setCategoryId] = useState<string | undefined>();
  const [sort, setSort] = useState<SortCourse>("newest");
  const [page, setPage] = useState<number>(1);

  const { data, isLoading, isError } = useGetCoursesQuery({
    q: search.trim() || undefined,
    categoryId,
    sort,
    page,
    pageSize: PAGE_SIZE,
  });

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    const val: string = event.currentTarget.value;
    setInput(val);
    if (!val.trim()) setSort("newest");
    setPage(1);
  };

  const handleCategory = (id: string | undefined) => {
    setCategoryId(id);
    setPage(1);
  };

  const handleSort = (value: SortCourse) => {
    setSort(value);
    setPage(1);
  };

  return (
    <section className={styles.page}>
      <CatalogHero input={input} total={data?.total} onInput={handleInput} onSubmit={handleSearch} />

      <CatalogFilters
        categories={categories}
        categoryId={categoryId}
        sort={sort}
        search={search}
        onCategoryChange={handleCategory}
        onSortChange={handleSort}
      />

      <CatalogResults
        data={data}
        isLoading={isLoading}
        isError={isError}
        search={search}
        page={page}
        pageSize={PAGE_SIZE}
        onPrev={() => setPage((count) => count - 1)}
        onNext={() => setPage((count) => count + 1)}
      />
    </section>
  );
};
