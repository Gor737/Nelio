// Captures what the application writes to stdout (the JSON logger's sink) so a test can assert that nothing sensitive is
// logged. Every HTTP test of a new module should use it for at least one request that carries a password, a token, a cookie
// and a message body (docs/roadmap.md, Definition of Done for M8 onwards; test/README.md).
import { jest } from '@jest/globals';

export interface LogCapture {
  /** Everything written to stdout since the capture started. */
  output(): string;
  restore(): void;
}

export function captureLogs(): LogCapture {
  const chunks: string[] = [];
  const spy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
      return true;
    });
  return { output: () => chunks.join(''), restore: () => spy.mockRestore() };
}

/** Fails (with the offending needle's index, never its value) when any secret appears in the captured logs. */
export function expectNoneLogged(
  logs: LogCapture,
  secrets: readonly string[],
): void {
  const output = logs.output();
  secrets.forEach((secret, index) => {
    if (output.includes(secret))
      throw new Error(`secret #${index} appears in the logs`);
  });
  // The log must not be empty either, otherwise the check proves nothing.
  if (output.length === 0)
    throw new Error(
      'no log output was captured; the assertion would be vacuous',
    );
}
