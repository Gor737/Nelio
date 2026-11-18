import { ApiError, ErrorsType } from "../types/apiErrors";

type ApiErrorResponse = {
  status: number;
  data: ApiError;
};

// Human text for a failed request: a custom text per backend `code` if given,
// otherwise the backend `message`, otherwise the fallback.
export const getErrorMessage = (
  err: unknown,
  fallback = "Something went wrong. Please try again.",
  byCode: Record<string, string> = {},
): string => {
  if (!checkErrorType(err)) return fallback;
  return byCode[err.data.code] ?? err.data.message ?? fallback;
};

export const checkErrorType = (err: unknown): err is ApiErrorResponse => {
  return (
    typeof err === "object" &&
    err !== null &&
    "data" in err &&
    typeof err.data === "object" &&
    err.data !== null &&
    "code" in err.data &&
    typeof err.data.code === "string"
  );
};
