import type { LoggerService } from '@nestjs/common';
import type { LogLevel } from '../../infrastructure/config/index.js';
import { redact, redactString } from './redact.js';
import { currentRequestId } from './request-context.js';

export interface LogSink {
  write(line: string): void;
}

const stdoutSink: LogSink = {
  write: (line) => void process.stdout.write(line),
};

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Structured logger: one JSON object per line with time, level, context, requestId, message and redacted fields.
 * Implements Nest's LoggerService, so framework logs and application logs share the format. Nest convention: the last
 * string parameter is the context; for `error` the second parameter may be a stack trace.
 */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly threshold: LogLevel = 'info',
    private readonly sink: LogSink = stdoutSink,
  ) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  private write(level: LogLevel, message: unknown, params: unknown[]): void {
    if (RANK[level] < RANK[this.threshold]) return;

    let context: string | undefined;
    let stack: string | undefined;
    const fields: Record<string, unknown> = {};
    const extras = [...params];
    if (typeof extras.at(-1) === 'string') context = extras.pop() as string;
    if (
      level === 'error' &&
      typeof extras[0] === 'string' &&
      /\n\s+at /.test(extras[0])
    )
      stack = redactString(extras.shift() as string);
    for (const extra of extras) {
      if (extra instanceof Error) fields.error = redact(extra);
      else if (extra !== null && typeof extra === 'object')
        Object.assign(fields, redact(extra) as Record<string, unknown>);
      else if (extra !== undefined) fields.detail = redact(extra);
    }

    let text: string;
    if (typeof message === 'string') text = redactString(message);
    else if (message instanceof Error) {
      text = redactString(message.message);
      fields.error = redact(message);
    } else {
      text = '';
      Object.assign(fields, redact(message) as Record<string, unknown>);
    }

    const requestId = currentRequestId();
    const entry = {
      time: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      ...(requestId ? { requestId } : {}),
      message: text,
      ...(stack ? { stack } : {}),
      ...fields,
    };
    this.sink.write(`${JSON.stringify(entry)}\n`);
  }
}
