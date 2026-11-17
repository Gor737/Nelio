"use client";

import { useRefreshMutation } from "@/lib/features/auth/authApi";
import {
  changeToReady,
  selectReadyFlag,
  setAccessToken,
} from "@/lib/features/auth/authSlice";
import { useAppDispatch, useAppSelector } from "@/lib/hooks";
import { useEffect, useRef } from "react";

export const AuthBootstrap = () => {
  const [refresh] = useRefreshMutation();
  const dispatch = useAppDispatch();
  const called = useRef(true);

  useEffect(() => {
    if (!called.current) return;
    called.current = false;

    const refreshToken = async () => {
      try{
        const token = await refresh().unwrap();
        dispatch(setAccessToken(token.accessToken));
      }finally{
        dispatch(changeToReady());
      }
    };

    refreshToken().catch((err) => console.log(err));
  }, [refresh]);

  return null;
};