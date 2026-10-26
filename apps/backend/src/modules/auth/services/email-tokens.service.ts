import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type EmailTokenTypeName,
  emailTokenLifetime,
} from '../../../common/constants/email-tokens.js';
import { TIME_LIMITS } from '../../../common/constants/limits.js';
import { ApiException } from '../../../common/filters/index.js';
import {
  PrismaService,
  type Tx,
} from '../../../infrastructure/database/index.js';
import { hashToken } from './sessions.service.js';

export interface IssuedEmailToken {
  /** The value for the link; only its SHA-256 is stored. */
  readonly token: string;
  readonly expiresAt: Date;
  /** What the email states: derived from the same lifetime as `expiresAt` (`emailTokenLifetime`). */
  readonly validForHours: number;
}

/**
 * Email-verification and password-reset tokens (architecture section 11): 256-bit random, stored hashed, SINGLE USE through one conditional
 * update, consumed by POST only (mail scanners open links), with a 60-second cooldown per user and type (a request inside it issues nothing).
 * The stored `expires_at` and the `validForHours` given to the email are produced together from `emailTokenLifetime`, never separately.
 */
@Injectable()
export class EmailTokensService {
  constructor(private readonly prisma: PrismaService) {}

  /** Issues a token in the caller's transaction, or returns null while the newest token of this user and type is younger than the cooldown. */
  async issue(
    tx: Tx,
    userId: string,
    type: EmailTokenTypeName,
  ): Promise<IssuedEmailToken | null> {
    const cooldownSeconds = TIME_LIMITS.EMAIL_TOKEN_COOLDOWN_MS / 1000;
    const recent = await tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM email_tokens
       WHERE user_id = ${userId}::uuid AND type = ${type}::email_token_type
         AND created_at > now() - make_interval(secs => ${cooldownSeconds}::int)
       LIMIT 1`;
    if (recent.length > 0) return null;
    const { ttlMs, validForHours } = emailTokenLifetime(type);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMs);
    await tx.$executeRaw`
      INSERT INTO email_tokens (user_id, type, token_hash, expires_at)
      VALUES (${userId}::uuid, ${type}::email_token_type, ${hashToken(token)}, ${expiresAt})`;
    return { token, expiresAt, validForHours };
  }

  /** Read-only: the owner of a token that is still usable, or null. Lets a caller refuse a bad token before doing expensive work. */
  async peek(token: string, type: EmailTokenTypeName): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM email_tokens
       WHERE token_hash = ${hashToken(token)} AND type = ${type}::email_token_type AND used_at IS NULL AND expires_at > now()`;
    return rows[0]?.user_id ?? null;
  }

  /** Consumes the token with ONE conditional update: unknown, used, wrong type or expired is 400 `TOKEN_INVALID`, and only one caller can win. */
  async consume(
    tx: Tx,
    token: string,
    type: EmailTokenTypeName,
  ): Promise<string> {
    const rows = await tx.$queryRaw<{ user_id: string }[]>`
      UPDATE email_tokens SET used_at = now()
       WHERE token_hash = ${hashToken(token)} AND type = ${type}::email_token_type AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`;
    if (rows.length === 0) throw new ApiException('TOKEN_INVALID');
    return rows[0].user_id;
  }

  /** Marks the user's other unused tokens of this type as used (after a successful reset, an older link must not work). */
  async invalidateOthers(
    tx: Tx,
    userId: string,
    type: EmailTokenTypeName,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE email_tokens SET used_at = now()
       WHERE user_id = ${userId}::uuid AND type = ${type}::email_token_type AND used_at IS NULL`;
  }

  /** Deletes tokens that expired or were used more than a day ago, in batches. A callable method; the schedule is M13. */
  async cleanupExpired(batch = 1000): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM email_tokens WHERE id IN (
          SELECT id FROM email_tokens
           WHERE expires_at < now() - interval '1 day' OR used_at < now() - interval '1 day' LIMIT ${batch})`;
      total += deleted;
      if (deleted < batch) return total;
    }
  }
}
