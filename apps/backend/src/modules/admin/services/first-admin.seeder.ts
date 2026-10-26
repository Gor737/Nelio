import { Injectable } from '@nestjs/common';
import {
  TransactionService,
  lockAdvisory,
} from '../../../infrastructure/database/index.js';
import { PasswordService, checkPassword } from '../../auth/index.js';
import { UserAccountService } from '../../users/index.js';

export interface FirstAdminInput {
  readonly email: string;
  readonly password: string;
  readonly fullName: string;
}

export type SeedOutcome =
  | { readonly created: true; readonly userId: string }
  | { readonly created: false; readonly reason: 'ADMIN_EXISTS' };

/** A configuration problem of the seed (bad email, weak password, email already registered): the message names the problem, never a value. */
export class SeedError extends Error {}

/**
 * The first Admin (docs/architecture.md section 11; Decision 153): created from the environment, with the email marked verified, and ONLY
 * when no active Admin exists. It is idempotent: a second run finds the Admin and does nothing. The `ADMIN-SET` lock makes two parallel
 * runs create one Admin. The password is hashed before the transaction (no hashing inside a transaction) and must pass the same policy as
 * a registration. An email that is already registered is refused rather than promoted: whoever registered it holds its password, and
 * verifying it from here would hand them the platform.
 */
@Injectable()
export class FirstAdminSeeder {
  constructor(
    private readonly transactions: TransactionService,
    private readonly accounts: UserAccountService,
    private readonly passwords: PasswordService,
  ) {}

  async run(input: FirstAdminInput): Promise<SeedOutcome> {
    const email = input.email.trim().toLowerCase();
    const fullName = input.fullName.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw new SeedError('SEED_ADMIN_EMAIL is not a valid email address');
    if (fullName.length < 1 || fullName.length > 100)
      throw new SeedError('SEED_ADMIN_NAME must be 1-100 characters');
    const problem = checkPassword(input.password);
    if (problem) throw new SeedError(`SEED_ADMIN_PASSWORD: ${problem.message}`);
    const passwordHash = await this.passwords.hash(input.password);

    return this.transactions.run(async (tx): Promise<SeedOutcome> => {
      await lockAdvisory(tx, 'ADMIN-SET');
      if ((await this.accounts.countActiveAdmins(tx)) > 0)
        return { created: false, reason: 'ADMIN_EXISTS' };
      const taken = await tx.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM users WHERE email = ${email}`;
      if (taken.length > 0)
        throw new SeedError(
          'SEED_ADMIN_EMAIL is already registered; use another address or remove that account',
        );
      const { id } = await this.accounts.createWithStudentRole(tx, {
        email,
        fullName,
        passwordHash,
        emailVerifiedAt: new Date(),
      });
      await this.accounts.grantAdminRole(tx, { userId: id, actorId: id });
      return { created: true, userId: id };
    });
  }
}
