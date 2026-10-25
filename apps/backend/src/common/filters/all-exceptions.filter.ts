import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ERROR_CODES,
  type ErrorCode,
  type HttpStatus,
} from '../constants/error-codes.js';
import {
  constraintOf,
  isCheckViolation,
  isDeadlock,
  isForeignKeyViolation,
  isLockTimeout,
  isNotNullViolation,
  isSerializationFailure,
  isStatementTimeout,
  isUniqueViolation,
} from '../../infrastructure/database/error-classifiers.js';
import { currentRequestId } from '../../infrastructure/logging/request-context.js';
import { ApiException, type FieldError } from './api-exception.js';

interface Rendered {
  readonly status: HttpStatus;
  readonly code: ErrorCode;
  readonly message: string;
  readonly errors?: readonly FieldError[];
}

const byCode = (code: ErrorCode, message?: string): Rendered => ({
  status: ERROR_CODES[code].status as HttpStatus,
  code,
  message: message ?? ERROR_CODES[code].description,
});

/** Statuses of framework-raised errors (unmatched route, malformed JSON, body too large...) mapped onto the registry. */
const FRAMEWORK_STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  429: 'TOO_MANY_REQUESTS',
};

/**
 * The single place that turns any thrown value into `{ statusCode, code, message, errors? }` (Decisions 137 and 140).
 * Database errors are classified by SQLSTATE (error-classifiers.ts):
 *   unique / foreign key / restrict -> 409 RESOURCE_CONFLICT (no service rule translated it into a specific code)
 *   deadlock / serialization failure that survived the retries -> 503 SERVICE_UNAVAILABLE (Decision 166)
 *   lock timeout / statement timeout -> 503 SERVICE_UNAVAILABLE (no Retry-After: no meaningful value can be determined)
 *   CHECK / NOT NULL violation -> 500 INTERNAL_ERROR, logged loudly (a service let invalid data reach the database)
 * Anything unrecognized is a generic 500 that never reveals the cause to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception; // WebSocket errors are rendered by the gateway filter (M8)
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const rendered = this.render(exception, request);
    if (response.headersSent) return;
    response.status(rendered.status).json({
      statusCode: rendered.status,
      code: rendered.code,
      message: rendered.message,
      ...(rendered.errors ? { errors: rendered.errors } : {}),
    });
  }

  private render(exception: unknown, request: Request): Rendered {
    if (exception instanceof ApiException) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        errors: exception.errors,
      };
    }

    const framework = this.fromFramework(exception);
    if (framework) return framework;

    if (isUniqueViolation(exception) || isForeignKeyViolation(exception)) {
      this.logger.warn({
        event: 'database_conflict',
        constraint: constraintOf(exception),
        path: request.path,
      });
      return byCode('RESOURCE_CONFLICT');
    }
    if (isDeadlock(exception) || isSerializationFailure(exception)) {
      this.logger.warn({
        event: 'transaction_retries_exhausted',
        path: request.path,
      });
      return byCode('SERVICE_UNAVAILABLE');
    }
    if (isLockTimeout(exception) || isStatementTimeout(exception)) {
      this.logger.error({
        event: 'database_timeout',
        path: request.path,
        requestId: currentRequestId(),
      });
      return byCode('SERVICE_UNAVAILABLE');
    }
    if (isCheckViolation(exception) || isNotNullViolation(exception)) {
      this.logger.error({
        event: 'database_check_violation',
        constraint: constraintOf(exception),
        path: request.path,
        requestId: currentRequestId(),
        note: 'A service sent data that the database rejects; validation upstream is missing.',
      });
      return byCode('INTERNAL_ERROR', 'Internal server error');
    }

    this.logger.error({
      event: 'unhandled_exception',
      path: request.path,
      requestId: currentRequestId(),
      error: exception,
    });
    return byCode('INTERNAL_ERROR', 'Internal server error');
  }

  private fromFramework(exception: unknown): Rendered | undefined {
    // Nest's own exceptions, and the plain `http-errors` objects that Express/body-parser throw (they carry `status`).
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : this.httpErrorStatus(exception);
    if (status === undefined) return undefined;
    // 413/415 are reserved for upload routes (FILE_TOO_LARGE / FILE_TYPE_NOT_ALLOWED, M9a). On a JSON route an oversized
    // or wrongly typed body is simply a bad request (Decision 167).
    if (status === 413 || status === 415) {
      return byCode(
        'VALIDATION_FAILED',
        status === 413 ? 'Request body too large' : 'Unsupported content type',
      );
    }
    const code = FRAMEWORK_STATUS_TO_CODE[status];
    if (!code) return undefined;
    return byCode(code, status === 400 ? 'Malformed request' : undefined);
  }

  private httpErrorStatus(exception: unknown): number | undefined {
    const e = exception as {
      status?: unknown;
      type?: unknown;
      expose?: unknown;
    } | null;
    return e &&
      typeof e.status === 'number' &&
      e.expose === true &&
      typeof e.type === 'string'
      ? e.status
      : undefined;
  }
}
