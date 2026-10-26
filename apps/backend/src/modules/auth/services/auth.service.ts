import { Injectable } from '@nestjs/common';
import { ApiException } from '../../../common/filters/index.js';
import {
  PrismaService,
  TransactionService,
  isUniqueViolation,
} from '../../../infrastructure/database/index.js';
import { MailService } from '../../../infrastructure/mail/index.js';
import { UserAccountService } from '../../users/index.js';
import {
  EmailTokensService,
  type IssuedEmailToken,
} from './email-tokens.service.js';
import { checkPassword } from './password-policy.js';
import { PasswordService } from './password.service.js';
import {
  type IssuedRefreshToken,
  SessionsService,
} from './sessions.service.js';
import { type IssuedAccessToken, TokenIssuer } from './token-issuer.service.js';

export interface SessionTokens {
  readonly access: IssuedAccessToken;
  readonly refresh: IssuedRefreshToken;
}

interface UserRow {
  id: string;
  full_name: string;
  email: string;
  status: 'ACTIVE' | 'SUSPENDED';
  password_hash: string | null;
  email_verified_at: Date | null;
}

const weak = (message: string) =>
  new ApiException('VALIDATION_FAILED', {
    errors: [{ field: 'password', messages: [message] }],
  });

/**
 * Passwords, sessions and the email flows (docs/architecture.md section 11; Decisions 53, 58, 144-153).
 *
 * Nothing here reveals whether an email is registered: registration, resend and forgot-password always succeed the same way and tell the
 * truth by email; a login with an unknown email, a wrong password or a Google-only account gives the SAME 401 and does the same work.
 * Hashing and token checks happen OUTSIDE transactions; the rate limiter (global, before the handler) throttles before any hashing.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly passwords: PasswordService,
    private readonly issuer: TokenIssuer,
    private readonly sessions: SessionsService,
    private readonly emailTokens: EmailTokensService,
    private readonly accounts: UserAccountService,
    private readonly mail: MailService,
  ) {}

  // ---------------------------------------------------------------- registration and email

  /**
   * Always succeeds. The account-state table:
   *   no such email        -> create the user (STUDENT, unverified) and email a verification link;
   *   unverified account   -> REPLACE the password with the new one and email a new link (Decision 149; the cooldown applies);
   *   verified account     -> change nothing and email "you already have an account".
   * Verification never logs in.
   */
  async register(input: {
    email: string;
    fullName: string;
    password: string;
  }): Promise<void> {
    const problem = checkPassword(input.password);
    if (problem) throw weak(problem.message);
    const hash = await this.passwords.hash(input.password); // always, so the time does not reveal the state
    let user = await this.findByEmail(input.email);
    if (!user) {
      try {
        const token = await this.transactions.run(async (tx) => {
          const created = await this.accounts.createWithStudentRole(tx, {
            email: input.email,
            fullName: input.fullName,
            passwordHash: hash,
          });
          return {
            id: created.id,
            issued: await this.emailTokens.issue(
              tx,
              created.id,
              'EMAIL_VERIFICATION',
            ),
          };
        });
        this.sendVerification(input.email, input.fullName, token.issued);
        return;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        user = await this.findByEmail(input.email); // someone registered it a moment ago: handle it as an existing account
        if (!user) throw error;
      }
    }
    if (user.email_verified_at === null) {
      const issued = await this.transactions.run(async (tx) => {
        const replaced = await tx.$executeRaw`
          UPDATE users SET password_hash = ${hash}, updated_at = now()
           WHERE id = ${user.id}::uuid AND email_verified_at IS NULL`;
        if (replaced === 0) return 'verified' as const; // verified in the meantime
        return this.emailTokens.issue(tx, user.id, 'EMAIL_VERIFICATION');
      });
      if (issued === 'verified') this.sendAlreadyRegistered(user);
      else this.sendVerification(user.email, user.full_name, issued);
      return;
    }
    this.sendAlreadyRegistered(user);
  }

  /** Marks the email verified. Consumed by POST only; it does NOT log the user in. */
  async verifyEmail(token: string): Promise<void> {
    await this.transactions.run(async (tx) => {
      const userId = await this.emailTokens.consume(
        tx,
        token,
        'EMAIL_VERIFICATION',
      );
      await tx.$executeRaw`
        UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = ${userId}::uuid`;
    });
  }

  /** Always succeeds; sends a new link only to an existing unverified account, at most one a minute. */
  async resendVerification(email: string): Promise<void> {
    const user = await this.findByEmail(email);
    if (!user || user.email_verified_at !== null) return;
    const issued = await this.transactions.run((tx) =>
      this.emailTokens.issue(tx, user.id, 'EMAIL_VERIFICATION'),
    );
    this.sendVerification(user.email, user.full_name, issued);
  }

  /** Always succeeds; an existing, not suspended account (also a Google-only one: this is how it adds a password) gets a reset link. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.findByEmail(email);
    if (!user || user.status !== 'ACTIVE') return;
    const issued = await this.transactions.run((tx) =>
      this.emailTokens.issue(tx, user.id, 'PASSWORD_RESET'),
    );
    if (!issued) return;
    void this.mail.sendPasswordReset(user.email, {
      fullName: user.full_name,
      token: issued.token,
      validForHours: issued.validForHours,
    });
  }

  /**
   * Sets a new password with a reset token: verifies the email, signs every session out (refresh tokens revoked, `tokens_valid_after`
   * set) and voids the user's other reset links. A bad token is refused BEFORE the password is hashed.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const problem = checkPassword(newPassword);
    if (problem) throw weak(problem.message);
    if (!(await this.emailTokens.peek(token, 'PASSWORD_RESET')))
      throw new ApiException('TOKEN_INVALID');
    const hash = await this.passwords.hash(newPassword);
    await this.transactions.run(async (tx) => {
      const userId = await this.emailTokens.consume(
        tx,
        token,
        'PASSWORD_RESET',
      );
      await tx.$executeRaw`
        UPDATE users SET password_hash = ${hash}, email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
         WHERE id = ${userId}::uuid`;
      await this.emailTokens.invalidateOthers(tx, userId, 'PASSWORD_RESET');
      await this.sessions.revokeAllSessions(tx, userId);
    });
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Email and password. Unknown email, wrong password and a Google-only account are the same 401 with the same work done. After a correct
   * password: suspended is 403 `ACCOUNT_SUSPENDED`; an unverified email is 403 `FORBIDDEN` (Decision 58).
   */
  async login(email: string, password: string): Promise<SessionTokens> {
    const user = await this.findByEmail(email);
    const correct = await this.passwords.verify(user?.password_hash, password);
    if (!user || !correct)
      throw new ApiException('UNAUTHENTICATED', {
        message: 'Invalid email or password',
      });
    if (user.status !== 'ACTIVE') throw new ApiException('ACCOUNT_SUSPENDED');
    if (user.email_verified_at === null)
      throw new ApiException('FORBIDDEN', {
        message: 'Verify your email address before logging in',
      });
    return this.startSession(user.id);
  }

  /** Starts a new session (a family of refresh tokens) for a user who has proven who they are. */
  async startSession(userId: string): Promise<SessionTokens> {
    const refresh = await this.transactions.run((tx) =>
      this.sessions.startFamily(tx, userId),
    );
    return { access: this.issuer.issueAccessToken(userId), refresh };
  }

  /** Rotates the refresh token. 401 for an unknown, expired or revoked token (and for a replay after the grace window, which revokes the family). */
  async refresh(rawToken: string): Promise<SessionTokens> {
    const outcome = await this.sessions.rotate(rawToken);
    switch (outcome.kind) {
      case 'ok':
        return {
          access: this.issuer.issueAccessToken(outcome.userId),
          refresh: outcome.token,
        };
      case 'grace':
        throw new ApiException('RESOURCE_CONFLICT', {
          message:
            'This refresh token was used a moment ago; use the newest one',
        });
      case 'suspended':
        throw new ApiException('ACCOUNT_SUSPENDED');
      default:
        throw new ApiException('UNAUTHENTICATED');
    }
  }

  /** This device only. Unknown or missing tokens are ignored. */
  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken) await this.sessions.revokeFamilyOf(rawToken);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.transactions.run((tx) =>
      this.sessions.revokeAllSessions(tx, userId),
    );
  }

  /**
   * Changes the password after checking the current one (403 `INVALID_CURRENT_PASSWORD`, so the frontend does not take it for an expired
   * session). Signs the OTHER devices out and keeps this one: the family of the cookie survives, and a fresh access token is returned.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    refreshCookie: string | undefined,
  ): Promise<IssuedAccessToken> {
    const rows = await this.prisma.$queryRaw<
      { password_hash: string | null }[]
    >`
      SELECT password_hash FROM users WHERE id = ${userId}::uuid`;
    if (rows.length === 0) throw new ApiException('UNAUTHENTICATED');
    if (!(await this.passwords.verify(rows[0].password_hash, currentPassword)))
      throw new ApiException('INVALID_CURRENT_PASSWORD');
    const problem = checkPassword(newPassword);
    if (problem) throw weak(problem.message);
    const hash = await this.passwords.hash(newPassword);
    const keep = refreshCookie
      ? await this.sessions.familyOf(refreshCookie, userId)
      : null;
    await this.transactions.run(async (tx) => {
      await tx.$executeRaw`UPDATE users SET password_hash = ${hash}, updated_at = now() WHERE id = ${userId}::uuid`;
      await this.sessions.revokeOtherSessions(tx, userId, keep);
    });
    return this.issuer.issueAccessToken(userId);
  }

  // ---------------------------------------------------------------- helpers

  async findByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.prisma.$queryRaw<UserRow[]>`
      SELECT id, full_name, email, status, password_hash, email_verified_at FROM users WHERE email = ${email.trim().toLowerCase()}`;
    return rows[0] ?? null;
  }

  private sendVerification(
    email: string,
    fullName: string,
    issued: IssuedEmailToken | null,
  ): void {
    if (!issued) return; // inside the cooldown: the earlier email is still valid
    void this.mail.sendEmailVerification(email, {
      fullName,
      token: issued.token,
      validForHours: issued.validForHours,
    });
  }

  private sendAlreadyRegistered(user: UserRow): void {
    void this.mail.sendAlreadyRegistered(user.email, {
      fullName: user.full_name,
    });
  }
}
