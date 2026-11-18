import { createAppSlice } from "@/lib/createAppSlice";
import { PayloadAction } from "@reduxjs/toolkit";

type State = {
  accessToken: null | string;
  isAuthReady: boolean
};

const initialState: State = { accessToken: null, isAuthReady: false };

export const authSlice = createAppSlice({
  name: "auth",
  initialState,
  reducers: (create) => ({
    setAccessToken: create.reducer((state, action: PayloadAction<string>) => {
      state.accessToken = action.payload;
    }),
    clearAuth: create.reducer((state) => {
      state.accessToken = null;
    }),
    changeToReady: create.reducer((state) => {
      state.isAuthReady = true;
    })
  }),
  selectors: {
    selectAccessToken: (auth) => auth.accessToken,
    selectReadyFlag: (auth) => auth.isAuthReady,
  },
});

export const { setAccessToken, clearAuth, changeToReady } = authSlice.actions;
export const { selectAccessToken, selectReadyFlag } = authSlice.selectors;
