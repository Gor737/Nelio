import { TIME_LIMITS } from './limits.js';

/** The two kinds of single-use email token (the `email_token_type` enum). */
export const EMAIL_TOKEN_TYPES = [
  'EMAIL_VERIFICATION',
  'PASSWORD_RESET',
] as const;
export type EmailTokenTypeName = (typeof EMAIL_TOKEN_TYPES)[number];

const HOUR_MS = 60 * 60 * 1000;

const LIFETIME_MS: Record<EmailTokenTypeName, number> = {
  EMAIL_VERIFICATION: TIME_LIMITS.EMAIL_VERIFICATION_TOKEN_TTL_MS,
  PASSWORD_RESET: TIME_LIMITS.PASSWORD_RESET_TOKEN_TTL_MS,
};

/**
 * The ONE place that turns a token type into its lifetime. The stored `expires_at` and the "valid for N hours" that the email states are
 * both computed from the value returned here, so they cannot disagree (owner decision 2026-10-26, roadmap M11a). The lifetime must be a
 * whole number of hours, because the email says "N hours"; this is checked when the module loads.
 */
export function emailTokenLifetime(type: EmailTokenTypeName): {
  readonly ttlMs: number;
  readonly validForHours: number;
} {
  const ttlMs = LIFETIME_MS[type];
  return { ttlMs, validForHours: ttlMs / HOUR_MS };
}

for (const type of EMAIL_TOKEN_TYPES) {
  const { validForHours } = emailTokenLifetime(type);
  if (!Number.isInteger(validForHours) || validForHours < 1)
    throw new Error(
      `email token lifetime of ${type} must be a whole number of hours`,
    );
}
