import type { Request, Response } from 'express';
import { ApiException } from '../../common/filters/index.js';

export const REFRESH_COOKIE = 'nelio_refresh';
/** The cookie is sent only to the auth endpoints (Decision 148). */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth` (Decision 148). `Secure` is always set: browsers treat `http://localhost` as a
 * secure context for it (Chrome and Firefox do; Safari does not, so test with a browser that does or over HTTPS).
 */
export function setRefreshCookie(
  res: Response,
  value: string,
  expiresAt: Date,
): void {
  res.cookie(REFRESH_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
  });
}

/** Reads the refresh cookie from the `Cookie` header (no cookie-parser dependency is needed for one cookie). */
export function readRefreshCookie(request: Request): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== REFRESH_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The Origin check for the endpoints that act on the cookie (refresh, logout): when the browser sends an `Origin` it must be the frontend
 * origin (403 `FORBIDDEN`). A request without `Origin` (a non-browser client) is accepted; a browser always sends it on a cross-site POST.
 */
export function assertFrontendOrigin(
  request: Request,
  frontendOrigin: string,
): void {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== frontendOrigin)
    throw new ApiException('FORBIDDEN', { message: 'Origin not allowed' });
}
