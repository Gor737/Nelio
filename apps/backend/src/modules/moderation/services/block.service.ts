import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { ApiException } from '../../../common/filters/index.js';
import { PrismaService } from '../../../infrastructure/database/index.js';

/** Anything that can run a raw query: the `PrismaService` and a transaction client both fit. */
export type RawQueryable = Pick<PrismaClient, '$queryRaw'>;

/** The one wording of the neutral 409 `MEMBERS_UNAVAILABLE`: identical whatever the reason (unknown, suspended or blocking), so it reveals no block. */
export const MEMBERS_UNAVAILABLE_MESSAGE =
  'Some of these people cannot be added';

export interface BlockedUserView {
  readonly userId: string;
  readonly fullName: string;
  readonly blockedAt: Date;
}

/**
 * Blocking (Decisions 76, 84, 129): a block applies to chat only (new DMs, and adding someone to a new group); it does not touch
 * enrollment, invitations, course channels or teaching, and old history stays. A block never applies to an Admin as the blocked party
 * (an Admin cannot be blocked: 409 `CANNOT_BLOCK_ADMIN`), so Admins stay reachable for moderation.
 *
 * Nothing here ever tells a user who blocked them: the listing shows only the blocks you made, a block you made looks the same whether or not
 * the other person has blocked you, and `isBlockedEitherWay` / `assertCanAdd` are for other modules (Chat) to answer with a neutral error.
 */
@Injectable()
export class BlockService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Blocks `targetId` for `blockerId`. Idempotent: blocking someone you already blocked succeeds without change.
   * Order of the checks: yourself (400 `CANNOT_BLOCK_SELF`), then that the user exists (404), then an Admin (409 `CANNOT_BLOCK_ADMIN`).
   */
  async block(blockerId: string, targetId: string): Promise<void> {
    if (blockerId === targetId) throw new ApiException('CANNOT_BLOCK_SELF');
    const rows = await this.prisma.$queryRaw<{ is_admin: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'ADMIN' AND r.status = 'ACTIVE') AS is_admin
        FROM users u WHERE u.id = ${targetId}::uuid`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    if (rows[0].is_admin) throw new ApiException('CANNOT_BLOCK_ADMIN');
    await this.prisma.$executeRaw`
      INSERT INTO blocks (blocker_id, blocked_id) VALUES (${blockerId}::uuid, ${targetId}::uuid)
      ON CONFLICT (blocker_id, blocked_id) DO NOTHING`;
  }

  /** Removes a block. Idempotent: removing a block that does not exist succeeds. */
  async unblock(blockerId: string, targetId: string): Promise<void> {
    await this.prisma
      .$executeRaw`DELETE FROM blocks WHERE blocker_id = ${blockerId}::uuid AND blocked_id = ${targetId}::uuid`;
  }

  /** The users `blockerId` has blocked, newest first. Only the caller's own blocks, never who blocked the caller. */
  async list(
    blockerId: string,
    window: { pageSize: number; offset: number },
  ): Promise<{ items: BlockedUserView[]; total: number }> {
    const [rows, count] = await Promise.all([
      this.prisma.$queryRaw<
        { user_id: string; full_name: string; created_at: Date }[]
      >`
        SELECT b.blocked_id AS user_id, u.full_name, b.created_at
          FROM blocks b JOIN users u ON u.id = b.blocked_id
         WHERE b.blocker_id = ${blockerId}::uuid
         ORDER BY b.created_at DESC, b.blocked_id
         LIMIT ${window.pageSize} OFFSET ${window.offset}`,
      this.prisma.$queryRaw<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM blocks WHERE blocker_id = ${blockerId}::uuid`,
    ]);
    return {
      items: rows.map((r) => ({
        userId: r.user_id,
        fullName: r.full_name,
        blockedAt: r.created_at,
      })),
      total: count[0]?.n ?? 0,
    };
  }

  /**
   * Is there a block between the two users, in either direction? For Chat (a DM may not start, a message may not be sent). A block whose
   * blocked party is an ACTIVE Admin does not count (blocks do not apply to Admins).
   */
  async isBlockedEitherWay(
    userA: string,
    userB: string,
    db: RawQueryable = this.prisma,
  ): Promise<boolean> {
    if (userA === userB) return false;
    const rows = await db.$queryRaw<{ blocked: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM blocks bl
         WHERE ((bl.blocker_id = ${userA}::uuid AND bl.blocked_id = ${userB}::uuid) OR (bl.blocker_id = ${userB}::uuid AND bl.blocked_id = ${userA}::uuid))
           AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = bl.blocked_id AND r.role = 'ADMIN' AND r.status = 'ACTIVE')
      ) AS blocked`;
    return rows[0]?.blocked === true;
  }

  /**
   * Which of `candidateIds` have a block with `userId` in either direction (the same rule as `isBlockedEitherWay`, for many people in one
   * statement). Used by presence to hide blocked pairs from each other.
   */
  async blockedAmong(
    userId: string,
    candidateIds: readonly string[],
    db: RawQueryable = this.prisma,
  ): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();
    const rows = await db.$queryRaw<{ other: string }[]>`
      SELECT DISTINCT CASE WHEN bl.blocker_id = ${userId}::uuid THEN bl.blocked_id ELSE bl.blocker_id END AS other
        FROM blocks bl
       WHERE ((bl.blocker_id = ${userId}::uuid AND bl.blocked_id = ANY(${[...candidateIds]}::uuid[]))
           OR (bl.blocked_id = ${userId}::uuid AND bl.blocker_id = ANY(${[...candidateIds]}::uuid[])))
         AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = bl.blocked_id AND r.role = 'ADMIN' AND r.status = 'ACTIVE')`;
    return new Set(rows.map((r) => r.other));
  }

  /**
   * Decision 84: `adderId` cannot add someone who has blocked them to a NEW group. Throws the neutral 409 `MEMBERS_UNAVAILABLE` (it does
   * not say who blocked whom, or that a block exists) when any of `candidateIds` has blocked the adder. Existing shared groups are not
   * affected (this is only called when adding). An Admin adder is exempt (a block never applies to an Admin).
   */
  async assertCanAdd(
    adderId: string,
    candidateIds: readonly string[],
    db: RawQueryable = this.prisma,
  ): Promise<void> {
    const others = [...new Set(candidateIds)].filter((id) => id !== adderId);
    if (others.length === 0) return;
    const rows = await db.$queryRaw<{ blocker_id: string }[]>`
      SELECT bl.blocker_id FROM blocks bl
       WHERE bl.blocked_id = ${adderId}::uuid AND bl.blocker_id = ANY(${others}::uuid[])
         AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = bl.blocked_id AND r.role = 'ADMIN' AND r.status = 'ACTIVE')
       LIMIT 1`;
    if (rows.length > 0)
      throw new ApiException('MEMBERS_UNAVAILABLE', {
        message: MEMBERS_UNAVAILABLE_MESSAGE,
      });
  }
}
