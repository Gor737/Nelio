import { nelioApiSlice } from "@/lib/api/nelioApiSlice";
import {
  CatalogPage,
  CatalogQuery,
  CourseDetails,
  Ref,
  SyllabusSection,
} from "@/lib/types/courseTypes";

export const courseApi = nelioApiSlice.injectEndpoints({
  endpoints: (build) => ({
    getCourses: build.query<CatalogPage, CatalogQuery>({
      query: (arg) => ({
        url: "/courses",
        method: "GET",
        params: {
          q: arg.q,
          categoryId: arg.categoryId,
          sort: arg.sort,
          page: arg.page,
          pageSize: arg.pageSize,
        },
      }),
    }),
    getCategories: build.query<Ref[], void>({
      query: () => ({
        url: "/categories",
        method: "GET",
      }),
    }),
    getCourse: build.query<CourseDetails, { id: string }>({
      query: ({ id }) => ({
        url: `/courses/${id}`,
        method: "GET",
      }),
      providesTags: (result, error, arg) => [{type:'Courses', id: arg.id}]
    }),
    getSyllabus: build.query<SyllabusSection[], { id: string }>({
      query: ({ id }) => ({
        url: `/courses/${id}/syllabus`,
        method: "GET",
      }),
    //   providesTags: 
    }),
  }),
});

export const {
  useGetCoursesQuery,
  useGetCategoriesQuery,
  useGetCourseQuery,
  useGetSyllabusQuery,
} = courseApi;
