import { randomBytes } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import argon2 from 'argon2';

/**
 * Argon2id with the OWASP Password Storage Cheat Sheet minimum configuration (memory 19 MiB, 2 iterations, 1 lane; verified for M11a, one of
 * the two equivalent profiles OWASP lists). The parameters are embedded in each hash, so they can be raised later without a migration;
 * v1 never rehashes (Decision 146).
 *
 * `verify` is constant-work: with no stored hash (unknown email, or an account that only has Google) it verifies against a dummy hash made at
 * start-up, so the time and the answer do not tell the two cases apart. Hashing costs real CPU, so callers rely on the rate limiter,
 * which runs BEFORE the handler, to throttle first.
 */
@Injectable()
export class PasswordService implements OnModuleInit {
  static readonly OPTIONS = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const;

  private dummyHash = '';

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(randomBytes(24).toString('hex'));
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, PasswordService.OPTIONS);
  }

  /** True only when `storedHash` exists and matches. Always does the work of one verification. */
  async verify(
    storedHash: string | null | undefined,
    password: string,
  ): Promise<boolean> {
    const target = storedHash || this.dummyHash;
    let matches = false;
    try {
      matches = await argon2.verify(target, password);
    } catch {
      matches = false; // a malformed stored hash is a failed login, never a 500
    }
    return Boolean(storedHash) && matches;
  }
}
