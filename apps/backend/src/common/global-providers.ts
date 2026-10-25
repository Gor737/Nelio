import type { Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { AllExceptionsFilter } from './filters/index.js';
import { RateLimitGuard } from './guards/index.js';
import { createValidationPipe } from './pipes/index.js';

/**
 * The application-wide guard, filter and pipe, in one list that AppModule and the HTTP tests both register, so the tests run
 * the real wiring. Global guards run in registration order: the rate limiter must stay FIRST because 429 is checked before
 * authentication (Decision 140). M8 appends the JWT guard and the suspended-account check after it.
 */
export const GLOBAL_PROVIDERS: Provider[] = [
  { provide: APP_GUARD, useClass: RateLimitGuard },
  { provide: APP_FILTER, useClass: AllExceptionsFilter },
  { provide: APP_PIPE, useFactory: createValidationPipe },
];
