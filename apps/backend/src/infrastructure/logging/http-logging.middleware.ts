import type { LoggerService } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * One structured line per finished request: method, path WITHOUT the query string, status and duration.
 * Headers, cookies, query strings and bodies are never logged, so tokens and passwords cannot reach the log through here.
 */
export function httpLoggingMiddleware(logger: LoggerService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const path = req.originalUrl.split('?')[0];
      const status = res.statusCode;
      const line = {
        event: 'http_request',
        method: req.method,
        path,
        status,
        durationMs: Math.round(durationMs * 10) / 10,
      };
      if (status >= 500) logger.error?.(line, 'HTTP');
      else if (status >= 400) logger.warn?.(line, 'HTTP');
      else logger.log(line, 'HTTP');
    });
    next();
  };
}
