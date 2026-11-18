import { nelioApiSlice } from "@/lib/api/nelioApiSlice";
import {
  CourseOutline,
  Lesson,
  LessonArgs,
  LessonCompletion,
  OutlineArgs,
} from "@/lib/types/lessonTypes";

export const lessonApi = nelioApiSlice.injectEndpoints({
  endpoints: (build) => ({
    getOutline: build.query<CourseOutline, OutlineArgs>({
      query: (arg) => ({
        url: `/courses/${arg.id}/outline`,
        method: "GET",
      }),
    }),
    getLesson: build.query<Lesson, LessonArgs>({
      query: ({ courseId, lessonId }) => ({
        url: `/courses/${courseId}/lessons/${lessonId}`,
      }),
    }),
    markAsComplete: build.mutation<LessonCompletion, LessonArgs>({
      query: ({courseId, lessonId}) => ({
        url: `/courses/${courseId}/lessons/${lessonId}/completion`,
        method: "PUT",
      }),
      invalidatesTags: (res, err) => [{ type: "MyEnrollments" }],
    }),
  }),
});

export const {
  useGetLessonQuery,
  useGetOutlineQuery,
  useMarkAsCompleteMutation,
} = lessonApi;
