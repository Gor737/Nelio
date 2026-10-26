import { applyDecorators } from '@nestjs/common';
import { IsString, ValidateBy, type ValidationOptions } from 'class-validator';
import type { Range } from '../constants/limits.js';

/**
 * Text length in Unicode code points: the unit PostgreSQL's `char_length` counts, and the unit of the limits in `TEXT_LIMITS`.
 * JavaScript's `.length` counts UTF-16 code units, so a single emoji is `.length` 2 but one character in the database; a DTO that
 * used `.length` could accept a 1-character value for a "minimum 2" column and then fail the SQL CHECK with a 500.
 *
 * It counts the characters AS RECEIVED: `'é'` (e + combining accent) is 2, the precomposed `'é'` is 1. The database
 * stores exactly what is validated (nothing normalizes a value between the DTO and the INSERT), so the two counts agree.
 */
export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

/** A UTF-16 surrogate that is not part of a pair. It is not valid text; encoding it for PostgreSQL would silently turn it into U+FFFD. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Can this value be stored in a PostgreSQL text column whose CHECK is `char_length(col) BETWEEN range.min AND range.max`?
 *   - it is a string;
 *   - it has no NUL character: PostgreSQL rejects U+0000 in text (22021) whatever the length;
 *   - it has no lone surrogate (not valid text);
 *   - its length in code points is within the range.
 * Everything this accepts, the database accepts (`test/integration/text-limits-consistency.integration-spec.ts` proves it for
 * every limited column); it can be stricter, never looser.
 */
export function isValidText(
  value: unknown,
  range: Pick<Range, 'min' | 'max'>,
): value is string {
  if (typeof value !== 'string') return false;
  if (value.includes('\u0000') || LONE_SURROGATE.test(value)) return false;
  const length = codePointLength(value);
  return length >= range.min && length <= range.max;
}

/** The OpenAPI schema fragment of a range (JSON Schema counts string length in characters, like the helper): `@ApiProperty({ ...textLengthApi(range) })`. */
export function textLengthApi(range: Pick<Range, 'min' | 'max'>): {
  minLength?: number;
  maxLength: number;
} {
  return {
    ...(range.min > 0 ? { minLength: range.min } : {}),
    maxLength: range.max,
  };
}

/**
 * `@TextLength(TEXT_LIMITS.COURSE_TITLE)`: the string is valid text with a length in code points within the limit. The bounds are
 * the shared constant itself, so a DTO cannot drift from the SQL CHECK that a test compares with the same constant. Use it for
 * EVERY request-DTO string that has a limit, never `@Length` or `@MaxLength` (they count UTF-16 units). It also implies `@IsString()`;
 * add `@IsOptional()` for an optional field.
 */
export function TextLength(
  range: Pick<Range, 'min' | 'max'>,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return applyDecorators(
    IsString(validationOptions),
    ValidateBy(
      {
        name: 'textLength',
        constraints: [range.min, range.max],
        validator: {
          validate: (value: unknown) => isValidText(value, range),
          defaultMessage: (args) =>
            range.min > 0
              ? `${args?.property} must be between ${range.min} and ${range.max} characters and must not contain NUL or broken surrogate characters`
              : `${args?.property} must be at most ${range.max} characters and must not contain NUL or broken surrogate characters`,
        },
      },
      validationOptions,
    ),
  );
}
