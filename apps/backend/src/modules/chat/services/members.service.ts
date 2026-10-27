import { Injectable } from '@nestjs/common';
import { COUNT_LIMITS } from '../../../common/constants/limits.js';
import { ApiException } from '../../../common/filters/index.js';
import {
  PrismaService,
  TransactionService,
  type Tx,
} from '../../../infrastructure/database/index.js';
import { emitAfterCommit } from '../../../infrastructure/events/index.js';
import { FilesService } from '../../files/index.js';
import {
  BlockService,
  MEMBERS_UNAVAILABLE_MESSAGE,
} from '../../moderation/index.js';
import type { MemberDto, MemberRoleName } from '../dto/chat.dto.js';
import {
  activeUserIds,
  lockConversation,
  requireMember,
} from './conversations.service.js';

/**
 * Members of a group (Decisions 83, 84, 131). Every change locks the Conversation row first, then reads the members: the lock is what
 * serializes the 50-member cap, two admins adding at once, and the last-admin rules. A group admin is a conversation role, unrelated to
 * the platform Admin role.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly blocks: BlockService,
    private readonly files: FilesService,
  ) {}

  /** Active members of a conversation I am an active member of. */
  async list(userId: string, conversationId: string): Promise<MemberDto[]> {
    await requireMember(this.prisma, conversationId, userId);
    const rows = await this.prisma.$queryRaw<
      {
        user_id: string;
        full_name: string;
        role: MemberRoleName;
        joined_at: Date;
        storage_key: string | null;
      }[]
    >`
      SELECT m.user_id, u.full_name, m.role, m.joined_at, f.storage_key
        FROM conversation_members m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN file_assets f ON f.id = u.avatar_file_id
       WHERE m.conversation_id = ${conversationId}::uuid AND m.left_at IS NULL
       ORDER BY m.joined_at, m.user_id`;
    return rows.map((r) => ({
      id: r.user_id,
      fullName: r.full_name,
      avatarUrl: r.storage_key ? this.files.publicUrl(r.storage_key) : null,
      role: r.role,
      joinedAt: r.joined_at,
    }));
  }

  /**
   * Adds people to a group (group admins only). Anyone already a member is skipped; someone who left earlier comes back on their old row
   * (role MEMBER, new `joined_at`, read position kept). A candidate that does not exist, is suspended or has blocked the adder makes
   * the whole request the neutral 409 `MEMBERS_UNAVAILABLE`. More than 50 active members is 409 `RESOURCE_CONFLICT`.
   */
  async add(
    userId: string,
    conversationId: string,
    userIds: readonly string[],
  ): Promise<MemberDto[]> {
    await this.transactions.run(async (tx) => {
      const conversation = await lockConversation(tx, conversationId);
      const me = await requireMember(tx, conversationId, userId);
      this.assertGroup(conversation.type);
      if (me.role !== 'ADMIN') throw new ApiException('FORBIDDEN');
      const wanted = [...new Set(userIds.map((id) => id.toLowerCase()))].filter(
        (id) => id !== userId,
      );
      const active = await activeUserIds(tx, wanted);
      if (active.size !== wanted.length)
        throw new ApiException('MEMBERS_UNAVAILABLE', {
          message: MEMBERS_UNAVAILABLE_MESSAGE,
        });
      const current = await tx.$queryRaw<{ user_id: string }[]>`
        SELECT user_id FROM conversation_members
         WHERE conversation_id = ${conversationId}::uuid AND left_at IS NULL`;
      const present = new Set(current.map((r) => r.user_id));
      const newcomers = wanted.filter((id) => !present.has(id));
      if (newcomers.length === 0) return;
      await this.blocks.assertCanAdd(userId, newcomers, tx);
      if (present.size + newcomers.length > COUNT_LIMITS.GROUP_MEMBERS_MAX)
        throw new ApiException('RESOURCE_CONFLICT', {
          message: `A group has at most ${COUNT_LIMITS.GROUP_MEMBERS_MAX} members`,
        });
      await tx.$executeRaw`
        INSERT INTO conversation_members (conversation_id, user_id)
        SELECT ${conversationId}::uuid, u FROM unnest(${newcomers}::uuid[]) AS u
        ON CONFLICT (conversation_id, user_id)
        DO UPDATE SET left_at = NULL, role = 'MEMBER', joined_at = now(), is_muted = false`;
      for (const id of newcomers)
        emitAfterCommit(tx, 'conversation.added', {
          conversationId,
          userId: id,
        });
      emitAfterCommit(tx, 'conversation.updated', { conversationId });
    });
    return this.list(userId, conversationId);
  }

  /** A group admin removes a member. Removing yourself is leaving. */
  async remove(
    userId: string,
    conversationId: string,
    targetId: string,
  ): Promise<void> {
    if (userId === targetId) return this.leave(userId, conversationId);
    await this.transactions.run(async (tx) => {
      const conversation = await lockConversation(tx, conversationId);
      const me = await requireMember(tx, conversationId, userId);
      this.assertGroup(conversation.type);
      if (me.role !== 'ADMIN') throw new ApiException('FORBIDDEN');
      await requireMember(tx, conversationId, targetId);
      await this.endMembership(tx, conversationId, targetId);
      emitAfterCommit(tx, 'conversation.updated', { conversationId });
    });
  }

  /** Promote to admin or demote to member (group admins only). Demoting the last admin while other members remain is 409 `LAST_GROUP_ADMIN`. */
  async setRole(
    userId: string,
    conversationId: string,
    targetId: string,
    role: MemberRoleName,
  ): Promise<MemberDto[]> {
    await this.transactions.run(async (tx) => {
      const conversation = await lockConversation(tx, conversationId);
      const me = await requireMember(tx, conversationId, userId);
      this.assertGroup(conversation.type);
      if (me.role !== 'ADMIN') throw new ApiException('FORBIDDEN');
      const target = await requireMember(tx, conversationId, targetId);
      if (target.role === role) return;
      if (role === 'MEMBER') {
        const counts = await tx.$queryRaw<
          { admins: number; members: number }[]
        >`
          SELECT count(*) FILTER (WHERE role = 'ADMIN')::int AS admins, count(*)::int AS members
            FROM conversation_members WHERE conversation_id = ${conversationId}::uuid AND left_at IS NULL`;
        if (counts[0].admins <= 1 && counts[0].members > 1)
          throw new ApiException('LAST_GROUP_ADMIN');
      }
      await tx.$executeRaw`
        UPDATE conversation_members SET role = ${role}::conversation_member_role
         WHERE conversation_id = ${conversationId}::uuid AND user_id = ${targetId}::uuid`;
      emitAfterCommit(tx, 'conversation.updated', { conversationId });
    });
    return this.list(userId, conversationId);
  }

  /**
   * Leave a group (any member). If the last admin leaves while others remain, the member who joined first (ties: smaller user id) becomes
   * the admin in the same transaction. A direct conversation and a course channel cannot be left: the channel follows the enrollment.
   */
  async leave(userId: string, conversationId: string): Promise<void> {
    await this.transactions.run(async (tx) => {
      const conversation = await lockConversation(tx, conversationId);
      const me = await requireMember(tx, conversationId, userId);
      this.assertGroup(conversation.type);
      if (me.role === 'ADMIN') {
        const others = await tx.$queryRaw<{ user_id: string; role: string }[]>`
          SELECT user_id, role FROM conversation_members
           WHERE conversation_id = ${conversationId}::uuid AND left_at IS NULL AND user_id <> ${userId}::uuid
           ORDER BY joined_at, user_id`;
        if (others.length > 0 && !others.some((o) => o.role === 'ADMIN')) {
          await tx.$executeRaw`
            UPDATE conversation_members SET role = 'ADMIN'
             WHERE conversation_id = ${conversationId}::uuid AND user_id = ${others[0].user_id}::uuid`;
        }
      }
      await this.endMembership(tx, conversationId, userId);
      emitAfterCommit(tx, 'conversation.updated', { conversationId });
    });
  }

  private async endMembership(
    tx: Tx,
    conversationId: string,
    userId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE conversation_members SET left_at = now()
       WHERE conversation_id = ${conversationId}::uuid AND user_id = ${userId}::uuid AND left_at IS NULL`;
    emitAfterCommit(tx, 'conversation.removed', { conversationId, userId });
  }

  /** Members can be managed in a group only: a direct conversation has two fixed people, a course channel follows the enrollment. */
  private assertGroup(type: string): void {
    if (type !== 'GROUP')
      throw new ApiException('INVALID_STATE_TRANSITION', {
        message:
          'Only a group has members you can change; a course channel follows the course enrollment',
      });
  }
}
