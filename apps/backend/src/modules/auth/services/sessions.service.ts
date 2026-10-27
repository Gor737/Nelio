import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { TIME_LIMITS } from '../../../common/constants/limits.js';
import {
  PrismaService,
  TransactionService,
  type Tx,
} from '../../../infrastructure/database/index.js';
import { emitAfterCommit } from '../../../infrastructure/events/index.js';
import { UserAccountService } from '../../users/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const hashToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex');

export interface IssuedRefreshToken {
  /** The opaque value for the cookie; only its SHA-256 is stored. */
  readonly raw: string;
  readonly expiresAt: Date;
  readonly familyId: string;
}

export type RotationOutcome =
  | { kind: 'ok'; userId: string; token: IssuedRefreshToken }
  | { kind: 'invalid' }
  | { kind: 'grace' }
  | { kind: 'reuse' }
  | { kind: 'suspended' };

interface TokenRow {
  id: string;
  user_id: string;
  family_id: string;
  family_started_at: Date;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  within_grace: boolean;
  expired: boolean;
  user_status: string;
}

/**
 * Refresh tokens and sessions (Decisions 144, 145). A refresh token is a random 256-bit value; only its SHA-256 is stored. A login starts a
 * FAMILY (one device session); every refresh marks the used token and issues the next one in the same family. A token lives 30 days from its
 * issue (sliding) but never past 90 days from the start of its family (the database CHECK enforces the cap too).
 *
 * Reuse detection: a token that was already used is either two tabs refreshing at once (inside the ~10 s grace window: 409, nothing is
 * revoked) or a stolen token being replayed (after the window: the WHOLE family is revoked, in a transaction that COMMITS before the 401 is
 * returned, so the revocation persists).
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly accounts: UserAccountService,
  ) {}

  /** Starts a new family (a login). Runs in the caller's transaction. */
  async startFamily(tx: Tx, userId: string): Promise<IssuedRefreshToken> {
    return this.insert(tx, userId, randomUUID(), new Date());
  }

  /**
   * Rotates a presented refresh token. One transaction, the token row locked, so two parallel refreshes are serialized: the first wins and
   * gets the new token, the second finds it used inside the grace window and gets `grace` (409).
   */
  async rotate(rawToken: string): Promise<RotationOutcome> {
    const graceSeconds = TIME_LIMITS.REFRESH_REUSE_GRACE_MS / 1000;
    return this.transactions.run(async (tx): Promise<RotationOutcome> => {
      const rows = await tx.$queryRaw<TokenRow[]>`
        SELECT t.id, t.user_id, t.family_id, t.family_started_at, t.expires_at, t.used_at, t.revoked_at,
               (t.used_at IS NOT NULL AND t.used_at > now() - make_interval(secs => ${graceSeconds}::int)) AS within_grace,
               (t.expires_at <= now()) AS expired,
               u.status AS user_status
          FROM refresh_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ${hashToken(rawToken)} FOR UPDATE OF t`;
      const row = rows[0];
      if (!row || row.revoked_at !== null || row.expired)
        return { kind: 'invalid' };
      if (row.used_at !== null) {
        if (row.within_grace) return { kind: 'grace' };
        await tx.$executeRaw`
          UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = ${row.family_id}::uuid AND revoked_at IS NULL`;
        this.logger.warn({
          event: 'refresh_token_reuse',
          familyId: row.family_id,
        });
        return { kind: 'reuse' };
      }
      if (row.user_status !== 'ACTIVE') return { kind: 'suspended' };
      await tx.$executeRaw`UPDATE refresh_tokens SET used_at = now() WHERE id = ${row.id}::uuid`;
      const token = await this.insert(
        tx,
        row.user_id,
        row.family_id,
        row.family_started_at,
      );
      return { kind: 'ok', userId: row.user_id, token };
    });
  }

  /** The family of a refresh token that is still valid and belongs to `userId`, or null. Read-only. */
  async familyOf(rawToken: string, userId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ family_id: string }[]>`
      SELECT family_id FROM refresh_tokens
       WHERE token_hash = ${hashToken(rawToken)} AND user_id = ${userId}::uuid AND revoked_at IS NULL AND expires_at > now()`;
    return rows[0]?.family_id ?? null;
  }

  /** Logs this device out: revokes the family of the presented token. Unknown tokens are ignored. */
  async revokeFamilyOf(rawToken: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE refresh_tokens SET revoked_at = now()
       WHERE revoked_at IS NULL AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = ${hashToken(rawToken)})`;
  }

  /**
   * Revokes EVERY refresh token of the user and makes every access token issued so far invalid (`tokens_valid_after`), in the caller's
   * transaction (docs/architecture.md section 11: used by suspension, password reset and logout-all). The socket server is told after the
   * commit (`session.revoked`), which sends `session:revoked` and closes the user's sockets.
   */
  async revokeAllSessions(tx: Tx, userId: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`;
    await this.accounts.setTokensValidAfter(tx, userId);
    emitAfterCommit(tx, 'session.revoked', { userId });
  }

  /**
   * Change-password: revokes every family except the one of this device (`keepFamilyId`, or none when the request had no valid cookie) and
   * invalidates all access tokens issued so far; the caller returns a fresh access token to this device. The sockets are NOT closed
   * (that would close this device's too); the other devices' sockets fail their next per-event check because their tokens are invalid.
   */
  async revokeOtherSessions(
    tx: Tx,
    userId: string,
    keepFamilyId: string | null,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE refresh_tokens SET revoked_at = now()
       WHERE user_id = ${userId}::uuid AND revoked_at IS NULL
         AND (${keepFamilyId}::uuid IS NULL OR family_id <> ${keepFamilyId}::uuid)`;
    await this.accounts.setTokensValidAfter(tx, userId);
  }

  /** Deletes refresh tokens that expired more than a day ago, in batches (nightly, `AuthCleanupJob`). */
  async cleanupExpired(batch = 1000): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM refresh_tokens WHERE id IN (
          SELECT id FROM refresh_tokens WHERE expires_at < now() - interval '1 day' LIMIT ${batch})`;
      total += deleted;
      if (deleted < batch) return total;
    }
  }

  private async insert(
    tx: Tx,
    userId: string,
    familyId: string,
    familyStartedAt: Date,
  ): Promise<IssuedRefreshToken> {
    const raw = randomBytes(32).toString('base64url');
    const now = Date.now();
    const cap =
      familyStartedAt.getTime() +
      TIME_LIMITS.REFRESH_FAMILY_MAX_AGE_DAYS * DAY_MS;
    const expiresAt = new Date(
      Math.min(now + TIME_LIMITS.REFRESH_TOKEN_IDLE_DAYS * DAY_MS, cap),
    );
    await tx.$executeRaw`
      INSERT INTO refresh_tokens (user_id, token_hash, family_id, family_started_at, expires_at)
      VALUES (${userId}::uuid, ${hashToken(raw)}, ${familyId}::uuid, ${familyStartedAt}, ${expiresAt})`;
    return { raw, expiresAt, familyId };
  }
}
