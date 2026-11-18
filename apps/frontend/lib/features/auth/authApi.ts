import { nelioApiSlice } from "@/lib/api/nelioApiSlice";
import {
  ChangePasswordRequest,
  LoginRequest,
  LoginResponse,
  MeResponse,
  RegisterRequest,
  RegisterResponse,
  UpdateMeRequest,
  VerifyRequest,
} from "@/lib/types/authTypes";

export const authApi = nelioApiSlice.injectEndpoints({
  endpoints: (build) => ({
    register: build.mutation<RegisterResponse, RegisterRequest>({
      query: (registerBody) => ({
        url: "/auth/register",
        method: "POST",
        body: registerBody,
      }),
    }),
    login: build.mutation<LoginResponse, LoginRequest>({
      query: (loginBody) => ({
        url: "/auth/login",
        method: "POST",
        body: loginBody,
      }),
    }),
    verifyEmail: build.mutation<void, VerifyRequest>({
      query: (verifyBody) => ({
        url: "/auth/verify-email",
        method: "POST",
        body: verifyBody,
      }),
    }),
    me: build.query<MeResponse, void>({
      query: () => ({
        url: "/me",
        method: "GET",
      }),
      providesTags: (res, err) => [{type: 'Me'}]
    }),
    refresh: build.mutation<LoginResponse, void>({
      query: () => ({
        url: "/auth/refresh",
        method: "POST",
      }),
    }),
    logout: build.mutation<void, void>({
      query: () => ({
        url: "/auth/logout",
        method: "POST",
      }),
    }),
    updateMe: build.mutation<MeResponse, UpdateMeRequest>({
      query: (body) => ({
        url: '/me',
        method: 'PATCH',
        body
      }),
      invalidatesTags: (res, err) => [{type: 'Me'}]
    }),
    // Returns fresh tokens: the old access token stops working, other devices are signed out.
    changePassword: build.mutation<LoginResponse, ChangePasswordRequest>({
      query: (body) => ({ url: "/auth/change-password", method: "POST", body }),
    }),
    // Revokes every session (this one too) and clears the refresh cookie. 204.
    logoutAll: build.mutation<void, void>({
      query: () => ({ url: "/auth/logout-all", method: "POST" }),
    }),
    googleLogin: build.mutation<LoginResponse, { idToken: string }>({
      query: ({idToken}) => ({
        url: '/auth/google',
        method: 'POST',
        body: {idToken}
      })
    }),
    linkGoogle: build.mutation<void, {idToken: string}>({
      query: ({idToken}) => ({
        url: '/auth/google/link',
        method: 'POST',
        body: {idToken}
      })
    }),
    unlinkGoogle: build.mutation<void, void>({
      query: () => ({
        url: '/auth/google',
        method: 'DELETE'
      })
    })
  }),
});


export const {
  useRegisterMutation,
  useLoginMutation,
  useVerifyEmailMutation,
  useMeQuery,
  useRefreshMutation,
  useLogoutMutation,
  useUpdateMeMutation,
  useChangePasswordMutation,
  useLogoutAllMutation,
  useGoogleLoginMutation,
  useLinkGoogleMutation,
  useUnlinkGoogleMutation
} = authApi;
