import { nelioApiSlice } from "@/lib/api/nelioApiSlice";
import {
  EnrollArgs,
  Enrollment,
  LastVisitedArgs,
  MyEnrollmentsPage,
  MyEnrollmentsQuery,
} from "@/lib/types/enrollmentTypes";

export const enrollmentsApi = nelioApiSlice.injectEndpoints({
  endpoints: (build) => ({
    enroll: build.mutation<Enrollment, EnrollArgs>({
      query: ({ id }) => ({
        url: `/courses/${id}/enrollments`,
        method: "POST",
      }),
      invalidatesTags: (result, error, { id }) => [{ type: "Courses", id }, {type: 'MyEnrollments'}],
    }),
    getMyEnrollments: build.query<MyEnrollmentsPage, MyEnrollmentsQuery>({
      query: (arg) => ({
        url: "/me/enrollments",
        method: "GET",
        params: {
          page: arg.page,
          pageSize: arg.pageSize,
          status: arg.status,
        },
      }),
      providesTags: (res, err) => [{ type: "MyEnrollments" }],
    }),
    updateLastVisited: build.mutation<void, LastVisitedArgs>({
        query: ({courseId, lessonId}) => ({
            url: `/courses/${courseId}/enrollments/me/last-visited`,
            method: 'PUT',
            body: {lessonId}
        }),
        invalidatesTags: (res, err) => [{type: 'MyEnrollments'}]
    }),
    getMyEnrollment: build.query<Enrollment, {id: string}>({
        query: ({id}) => ({
            url: `/courses/${id}/enrollments/me`,
            method: 'GET'
        }),
        providesTags: (res, err) => [{type: 'MyEnrollments'}]
    })
  }),
});

export const { useEnrollMutation, useGetMyEnrollmentsQuery, useUpdateLastVisitedMutation, useGetMyEnrollmentQuery} = enrollmentsApi;
