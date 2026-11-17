import {
  BaseQueryFn,
  createApi,
  FetchArgs,
  fetchBaseQuery,
  FetchBaseQueryError,
} from "@reduxjs/toolkit/query/react";
import type { LoginResponse } from "../types/authTypes";
import type { RootState } from "../store";
import { clearAuth, setAccessToken } from "../features/auth/authSlice";

const rawBaseQuery = fetchBaseQuery({
  baseUrl: "/api/v1",
  prepareHeaders: (headers, { getState }) => {
    const token = (getState() as RootState).auth.accessToken;

    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  },
});

const baseQueryWithReauth: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError
> = async (args, api, extraOptions) => {
  let result = await rawBaseQuery(args, api, extraOptions);

  const url = typeof args === "string" ? args : args.url;
  if (
    result.error?.status === 401 &&
    url !== "/auth/refresh" &&
    url !== "/auth/login"
  ) {
    const refreshResult = await rawBaseQuery(
      { url: "/auth/refresh", method: "POST" },
      api,
      extraOptions,
    );
    if (refreshResult.data) {
      const accessToken = (refreshResult.data as LoginResponse).accessToken;
      api.dispatch(setAccessToken(accessToken));
      result = await rawBaseQuery(args, api, extraOptions);
    } else {
      api.dispatch(clearAuth());
    }
  }

  return result;
};

export const nelioApiSlice = createApi({
  baseQuery: baseQueryWithReauth,
  reducerPath: "nelioApi",
  tagTypes: ["Courses", "MyEnrollments", "Me", "TeacherApplication", "Notifications"],
  endpoints: (build) => ({}),
});
