import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Per-request context carried through async calls, so any log line can include the request id. */
const storage = new AsyncLocalStorage<{ requestId: string }>();

export const currentRequestId = (): string | undefined =>
  storage.getStore()?.requestId;

export const runWithRequestId = <T>(requestId: string, fn: () => T): T =>
  storage.run({ requestId }, fn);

export const REQUEST_ID_HEADER = 'x-request-id';

/** An incoming id is accepted only if it is short and made of safe characters (no log injection). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Express middleware: assigns (or accepts) a request id, echoes it in `X-Request-Id`, and runs the rest of the request in its context. */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const requestId =
    incoming !== undefined && SAFE_REQUEST_ID.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  runWithRequestId(requestId, next);
}
