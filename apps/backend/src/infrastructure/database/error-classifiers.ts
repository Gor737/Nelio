/**
 * Database error classifiers: the one place that reads a SQLSTATE and a constraint name from an error
 * (docs/spikes/m1-spike-a-report.md rows E1-E2, m2-spike-b-report.md section 3). Prisma's own `code` is not reliable
 * (CHECK is P2039, a deadlock is P2034 through model queries but P2010 through raw queries), so everything here keys on
 * the SQLSTATE found at `meta.driverAdapterError.cause.originalCode`, with `error.code` as the fallback for plain `pg`.
 */
export const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  RESTRICT_VIOLATION: '23001',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  INVALID_TEXT_REPRESENTATION: '22P02',
  DEADLOCK_DETECTED: '40P01',
  SERIALIZATION_FAILURE: '40001',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014',
} as const;

interface PrismaAdapterCause {
  originalCode?: unknown;
  originalMessage?: unknown;
  constraint?: unknown;
  table?: unknown;
}

function causeOf(error: unknown): PrismaAdapterCause | undefined {
  const meta = (
    error as {
      meta?: { driverAdapterError?: { cause?: PrismaAdapterCause } };
    } | null
  )?.meta;
  return meta?.driverAdapterError?.cause;
}

/** The 5-character SQLSTATE of a database error, or undefined for any other error. */
export function sqlstateOf(error: unknown): string | undefined {
  const viaAdapter = causeOf(error)?.originalCode;
  if (typeof viaAdapter === 'string') return viaAdapter;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
    ? code
    : undefined;
}

/** The violated constraint's name when PostgreSQL reported one (unique, foreign key, restrict, check). */
export function constraintOf(error: unknown): string | undefined {
  const cause = causeOf(error);
  const constraint = cause?.constraint as { index?: unknown } | undefined;
  if (constraint && typeof constraint.index === 'string')
    return constraint.index;
  const direct = (error as { constraint?: unknown } | null)?.constraint;
  if (typeof direct === 'string') return direct;
  const message =
    typeof cause?.originalMessage === 'string'
      ? cause.originalMessage
      : (error as { message?: string } | null)?.message;
  return typeof message === 'string'
    ? /constraint "([^"]+)"/.exec(message)?.[1]
    : undefined;
}

const is = (state: string) => (error: unknown) => sqlstateOf(error) === state;

export const isUniqueViolation = is(SQLSTATE.UNIQUE_VIOLATION);
export const isCheckViolation = is(SQLSTATE.CHECK_VIOLATION);
export const isNotNullViolation = is(SQLSTATE.NOT_NULL_VIOLATION);
export const isDeadlock = is(SQLSTATE.DEADLOCK_DETECTED);
export const isSerializationFailure = is(SQLSTATE.SERIALIZATION_FAILURE);
export const isLockTimeout = is(SQLSTATE.LOCK_NOT_AVAILABLE);
export const isStatementTimeout = is(SQLSTATE.QUERY_CANCELED);
export const isInvalidTextRepresentation = is(
  SQLSTATE.INVALID_TEXT_REPRESENTATION,
);

/** A foreign-key violation on insert/update (23503) or a RESTRICT violation on delete (23001): "referenced or still in use". */
export const isForeignKeyViolation = (error: unknown): boolean =>
  sqlstateOf(error) === SQLSTATE.FOREIGN_KEY_VIOLATION ||
  sqlstateOf(error) === SQLSTATE.RESTRICT_VIOLATION;

/** The errors for which the whole transaction is run again: deadlock and serialization failure (Decision 159). */
export const isRetryableTransactionError = (error: unknown): boolean =>
  isDeadlock(error) || isSerializationFailure(error);
