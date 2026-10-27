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
    const type = host.getType();
    if (type === 'ws') return this.catchWs(exception, host);
    if (type !== 'http') throw exception;
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const rendered = this.render(exception, request.path);
    if (response.headersSent) return;
    response.status(rendered.status).json({
      statusCode: rendered.status,
      code: rendered.code,
      message: rendered.message,
      ...(rendered.errors ? { errors: rendered.errors } : {}),
    });
  }

  /**
   * Socket.IO events (architecture section 14): the failure is delivered as `{ ok: false, statusCode, code, message, errors? }`,
   * the same codes as REST. To the event's acknowledgement callback when the client asked for one, otherwise as an `exception`
   * event to that client. Nothing is ever thrown back into Socket.IO, so a bad event cannot take the connection down.
   */
  private catchWs(exception: unknown, host: ArgumentsHost): void {
    const rendered = this.render(exception, 'ws-event');
    const body = {
      ok: false as const,
      statusCode: rendered.status,
      code: rendered.code,
      message: rendered.message,
      ...(rendered.errors ? { errors: rendered.errors } : {}),
    };
    const args = host.getArgs<unknown[]>();
    // Nest passes [client, data, ack?, pattern]: the acknowledgement callback is the only function among them.
    const ack = args.find(
      (arg): arg is (payload: typeof body) => void => typeof arg === 'function',
    );
    if (ack) {
      ack(body);
      return;
    }
    const client = host
      .switchToWs()
      .getClient<{ emit?: (event: string, payload: unknown) => void }>();
    client.emit?.('exception', body);
  }

  private render(exception: unknown, path: string): Rendered {
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
        path,
      });
      return byCode('RESOURCE_CONFLICT');
    }
    if (isDeadlock(exception) || isSerializationFailure(exception)) {
      this.logger.warn({
        event: 'transaction_retries_exhausted',
        path,
      });
      return byCode('SERVICE_UNAVAILABLE');
    }
    if (isLockTimeout(exception) || isStatementTimeout(exception)) {
      this.logger.error({
        event: 'database_timeout',
        path,
        requestId: currentRequestId(),
      });
      return byCode('SERVICE_UNAVAILABLE');
    }
    if (isCheckViolation(exception) || isNotNullViolation(exception)) {
      this.logger.error({
        event: 'database_check_violation',
        constraint: constraintOf(exception),
        path,
        requestId: currentRequestId(),
        note: 'A service sent data that the database rejects; validation upstream is missing.',
      });
      return byCode('INTERNAL_ERROR', 'Internal server error');
    }

    this.logger.error({
      event: 'unhandled_exception',
      path,
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
