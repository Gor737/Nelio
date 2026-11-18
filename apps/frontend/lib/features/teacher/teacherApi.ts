import { nelioApiSlice } from "@/lib/api/nelioApiSlice";
import { ApplyTeacherRequest, TeacherApplication } from "@/lib/types/teacherTypes";

export const teacherApi = nelioApiSlice.injectEndpoints({
  endpoints: (build) => ({
    getTeacherApplication: build.query<TeacherApplication, void>({
      query: () => ({ url: "/me/teacher-application", method: "GET" }),
      providesTags: [{ type: "TeacherApplication" }],
    }),
    // 409 APPLICATION_PENDING / ALREADY_TEACHER
    applyTeacher: build.mutation<TeacherApplication, ApplyTeacherRequest>({
      query: (body) => ({ url: "/me/teacher-application", method: "POST", body }),
      invalidatesTags: [{ type: "TeacherApplication" }],
    }),
  }),
});

export const { useGetTeacherApplicationQuery, useApplyTeacherMutation } = teacherApi;
