import {
  ERROR_CODES,
  statusesOf,
  type ErrorCode,
  type HttpStatus,
} from '../constants/error-codes.js';

/** One field-level problem in a `VALIDATION_FAILED` response. */
export interface FieldError {
  readonly field: string;
  readonly messages: readonly string[];
}

export interface ApiExceptionOptions {
  /** Required only for the one code with two statuses (COURSE_ADMIN_LOCKED: 403 or 409); otherwise taken from the registry. */
  readonly status?: HttpStatus;
  readonly message?: string;
  readonly errors?: readonly FieldError[];
}

/**
 * The exception services throw: a registered error code and nothing else decides the status (Decision 137: one source of
 * truth). The exception filter renders it as `{ statusCode, code, message, errors? }`.
 */
export class ApiException extends Error {
  readonly status: HttpStatus;
  readonly errors?: readonly FieldError[];

  constructor(
    readonly code: ErrorCode,
    options: ApiExceptionOptions = {},
  ) {
    super(options.message ?? ERROR_CODES[code].description);
    this.name = 'ApiException';
    const allowed = statusesOf(code);
    const status = options.status ?? allowed[0];
    if (!allowed.includes(status)) {
      throw new TypeError(
        `ApiException: ${code} cannot have status ${status} (allowed: ${allowed.join(', ')})`,
      );
    }
    if (options.status === undefined && allowed.length > 1) {
      throw new TypeError(
        `ApiException: ${code} has two statuses; pass one explicitly`,
      );
    }
    this.status = status;
    this.errors = options.errors;
  }
}
