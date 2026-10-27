import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { ApiException, type FieldError } from '../filters/api-exception.js';

/** Flattens class-validator's nested errors into `{ field: 'a.b[0]', messages }` entries. */
export function flattenValidationErrors(
  errors: readonly ValidationError[],
  parent = '',
): FieldError[] {
  const out: FieldError[] = [];
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints)
      out.push({ field, messages: Object.values(error.constraints) });
    if (error.children?.length)
      out.push(...flattenValidationErrors(error.children, field));
  }
  return out;
}

/**
 * The global validation pipe (Decision 137, check order step 400): unknown properties are rejected, not stripped
 * (`forbidNonWhitelisted`), types are transformed from the DTO classes, and every failure becomes
 * 400 `VALIDATION_FAILED` with a field list.
 */
export const createValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: false,
    validationError: { target: false, value: false }, // never echo the submitted value (it may be a password)
    exceptionFactory: (errors) =>
      new ApiException('VALIDATION_FAILED', {
        message: 'Validation failed',
        errors: flattenValidationErrors(errors),
      }),
  });
