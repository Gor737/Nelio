// Direct-SQL helper for constraint tests: run a statement that must fail and read the PostgreSQL error precisely.
export interface SqlErrorInfo {
  /** PostgreSQL SQLSTATE, for example 23505 unique_violation, 23514 check_violation, 23001 restrict_violation. */
  sqlstate?: string;
  constraint?: string;
  table?: string;
  message: string;
}

export function errorInfo(error: unknown): SqlErrorInfo {
  const e = error as {
    code?: string;
    constraint?: string;
    table?: string;
    message?: string;
  };
  return {
    sqlstate: e.code,
    constraint: e.constraint,
    table: e.table,
    message: e.message ?? String(error),
  };
}

/** Awaits a statement that MUST fail; returns the error details, and fails the test if the statement succeeded. */
export async function sqlError(
  statement: Promise<unknown>,
): Promise<SqlErrorInfo> {
  try {
    await statement;
  } catch (error) {
    return errorInfo(error);
  }
  throw new Error('expected the statement to fail, but it succeeded');
}

/** SQLSTATEs used by the constraint tests. */
export const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  RESTRICT_VIOLATION: '23001',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  RAISE_EXCEPTION: 'P0001',
  INVALID_TEXT_REPRESENTATION: '22P02',
} as const;
