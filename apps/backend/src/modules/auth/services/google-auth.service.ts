import { Inject, Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { ApiException } from '../../../common/filters/index.js';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../infrastructure/config/index.js';
import {
  PrismaService,
  TransactionService,
  type Tx,
  isUniqueViolation,
  lockRow,
} from '../../../infrastructure/database/index.js';
import { UserAccountService } from '../../users/index.js';
import { AuthService, type SessionTokens } from './auth.service.js';
import { SessionsService } from './sessions.service.js';

/** What the Google ID token proved, after signature, issuer, audience and expiry were verified. */
export interface GoogleProfile {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string | null;
}

/** The verification seam: production uses Google's library; a test substitutes a fake that returns a profile. */
export abstract class GoogleTokenVerifier {
  abstract verify(idToken: string): Promise<GoogleProfile>;
}

@Injectable()
export class GoogleLibraryVerifier extends GoogleTokenVerifier {
  private client: OAuth2Client | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  /**
   * `OAuth2Client.verifyIdToken` checks the signature against Google's published keys, the issuer (accounts.google.com), the audience
   * (our client id) and the expiry. No Google token is stored. Not configured: 503. Any verification failure: 401, with no detail.
   */
  async verify(idToken: string): Promise<GoogleProfile> {
    const clientId = this.config.googleClientId;
    if (!clientId)
      throw new ApiException('SERVICE_UNAVAILABLE', {
        message: 'Google sign-in is not configured',
      });
    this.client ??= new OAuth2Client(clientId);
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: clientId,
      });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) throw new Error('incomplete token');
      return {
        sub: payload.sub,
        email: payload.email.trim().toLowerCase(),
        emailVerified: payload.email_verified === true,
        name: payload.name ?? null,
      };
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException('UNAUTHENTICATED', {
        message: 'The Google sign-in could not be verified',
      });
    }
  }
}

interface UserRow {
  id: string;
  status: 'ACTIVE' | 'SUSPENDED';
  email_verified_at: Date | null;
}

/**
 * Google sign-in, link and unlink (Decisions 57, 59, 150). The frontend sends the Google ID token; it is verified BEFORE any transaction
 * (no network call while a transaction is open). Identities are matched on Google's `sub`, never on the email; no Google token is stored.
 *
 * The four sign-in rules, in order:
 *   1. an identity with this `sub` exists: log that user in (a suspended user is refused);
 *   2. Google says the email is NOT verified: reject (this stops account pre-hijacking);
 *   3. a user with this email exists: link the identity to them; if their email was UNVERIFIED, clear their password, mark the email
 *      verified and revoke their sessions (whoever registered it with a password does not keep access);
 *   4. otherwise create a new STUDENT, verified, with no password.
 * Two first sign-ins at the same moment make ONE user: the loser's unique violation is handled outside its failed transaction by retrying.
 */
@Injectable()
export class GoogleAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly verifier: GoogleTokenVerifier,
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly accounts: UserAccountService,
  ) {}

  async signIn(idToken: string): Promise<SessionTokens> {
    const profile = await this.verifier.verify(idToken);
    for (let attempt = 0; ; attempt++) {
      try {
        const userId = await this.transactions.run((tx) =>
          this.resolveUser(tx, profile),
        );
        return await this.auth.startSession(userId);
      } catch (error) {
        if (attempt === 0 && isUniqueViolation(error)) continue; // a parallel first sign-in won; resolve again
        throw error;
      }
    }
  }

  /** Adds a Google login to the signed-in account. The Google account must not belong to anyone else, and an account has at most one. */
  async link(userId: string, idToken: string): Promise<void> {
    const profile = await this.verifier.verify(idToken);
    if (!profile.emailVerified)
      throw new ApiException('UNAUTHENTICATED', {
        message: 'Google did not verify this email address',
      });
    try {
      await this.transactions.run(async (tx) => {
        await lockRow(tx, 'user', userId, 'NO_KEY_UPDATE');
        const owner = await tx.$queryRaw<{ user_id: string }[]>`
          SELECT user_id FROM auth_identities WHERE provider = 'GOOGLE' AND provider_account_id = ${profile.sub}`;
        if (owner.length > 0 || (await this.hasGoogle(tx, userId)))
          throw new ApiException('RESOURCE_CONFLICT', {
            message:
              'This Google account or this user already has a Google login',
          });
        await this.insertIdentity(tx, userId, profile);
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ApiException('RESOURCE_CONFLICT', {
          message:
            'This Google account or this user already has a Google login',
        });
      throw error;
    }
  }

  /** Removes the Google login, but only if the user keeps another way in (a password): else 409 `NO_LOGIN_METHOD_REMAINING`. */
  async unlink(userId: string): Promise<void> {
    await this.transactions.run(async (tx) => {
      await lockRow(tx, 'user', userId, 'NO_KEY_UPDATE');
      const user = await tx.$queryRaw<{ password_hash: string | null }[]>`
        SELECT password_hash FROM users WHERE id = ${userId}::uuid`;
      if (!user[0]?.password_hash)
        throw new ApiException('NO_LOGIN_METHOD_REMAINING');
      const removed = await tx.$executeRaw`
        DELETE FROM auth_identities WHERE user_id = ${userId}::uuid AND provider = 'GOOGLE'`;
      if (removed === 0) throw new ApiException('NOT_FOUND');
    });
  }

  private async resolveUser(tx: Tx, profile: GoogleProfile): Promise<string> {
    const identity = await tx.$queryRaw<{ user_id: string; status: string }[]>`
      SELECT i.user_id, u.status FROM auth_identities i JOIN users u ON u.id = i.user_id
       WHERE i.provider = 'GOOGLE' AND i.provider_account_id = ${profile.sub}`;
    if (identity.length > 0) {
      if (identity[0].status !== 'ACTIVE')
        throw new ApiException('ACCOUNT_SUSPENDED');
      await tx.$executeRaw`
        UPDATE auth_identities SET last_used_at = now(), provider_email = ${profile.email}
         WHERE provider = 'GOOGLE' AND provider_account_id = ${profile.sub}`;
      return identity[0].user_id;
    }
    if (!profile.emailVerified)
      throw new ApiException('UNAUTHENTICATED', {
        message: 'Google did not verify this email address',
      });
    const existing = await tx.$queryRaw<UserRow[]>`
      SELECT id, status, email_verified_at FROM users WHERE email = ${profile.email} FOR NO KEY UPDATE`;
    if (existing.length > 0) {
      const user = existing[0];
      if (user.status !== 'ACTIVE') throw new ApiException('ACCOUNT_SUSPENDED');
      if (user.email_verified_at === null) {
        await tx.$executeRaw`
          UPDATE users SET password_hash = NULL, email_verified_at = now(), updated_at = now() WHERE id = ${user.id}::uuid`;
        await this.sessions.revokeAllSessions(tx, user.id);
      }
      await this.insertIdentity(tx, user.id, profile);
      return user.id;
    }
    const created = await this.accounts.createWithStudentRole(tx, {
      email: profile.email,
      fullName: this.displayName(profile),
      passwordHash: null,
      emailVerifiedAt: new Date(),
    });
    await this.insertIdentity(tx, created.id, profile);
    return created.id;
  }

  private displayName(profile: GoogleProfile): string {
    const name = (profile.name ?? '').trim() || profile.email.split('@')[0];
    return Array.from(name).slice(0, 100).join('');
  }

  private async hasGoogle(tx: Tx, userId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM auth_identities WHERE user_id = ${userId}::uuid AND provider = 'GOOGLE'`;
    return rows.length > 0;
  }

  private async insertIdentity(
    tx: Tx,
    userId: string,
    profile: GoogleProfile,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO auth_identities (user_id, provider, provider_account_id, provider_email, last_used_at)
      VALUES (${userId}::uuid, 'GOOGLE', ${profile.sub}, ${profile.email}, now())`;
  }
}
