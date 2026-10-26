import { Injectable } from '@nestjs/common';
import { TIME_LIMITS } from '../../../common/constants/limits.js';
import { ApiException } from '../../../common/filters/index.js';
import {
  PrismaService,
  TransactionService,
  type Tx,
} from '../../../infrastructure/database/index.js';
import { emitAfterCommit } from '../../../infrastructure/events/index.js';
import { FilesService } from '../../files/index.js';
import type {
  EnrollmentDto,
  InvitationDto,
  InvitationsPageDto,
  MyInvitationDto,
} from '../dto/enrollments.dto.js';
import { EnrollmentMachine } from './enrollment-machine.service.js';
import { EnrollmentsService } from './enrollments.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface InvitationRow {
  id: string;
  course_id: string;
  invited_user_id: string;
  invited_by: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED';
  expired: boolean;
  expires_at: Date;
  created_at: Date;
}

/**
 * Invitations (Decisions 38, 43, 71, 125). For existing users only; ONE reusable row per (course, user). Expiry is derived from `expires_at`
 * (7 days), never a stored status or a job. A valid PENDING invitation is never silently reset (409 `INVITATION_PENDING`); an expired,
 * revoked, declined or used one is reused and reset to PENDING with a new expiry. Accept, decline and revoke are conditional updates of the
 * same row, so accept versus revoke has exactly one winner. Accepting makes the student ACTIVE through the enrollment machine in the same
 * transaction, so a refusal there (already ACTIVE, archived course) rolls the acceptance back.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly machine: EnrollmentMachine,
    private readonly enrollments: EnrollmentsService,
    private readonly files: FilesService,
  ) {}

  private readonly url = (key: string | null): string | null =>
    key ? this.files.publicUrl(key) : null;

  /** Owner or Assistant invites an existing user to a published course. */
  async create(
    actorId: string,
    courseId: string,
    inviteeId: string,
  ): Promise<InvitationDto> {
    const id = await this.transactions.run(async (tx) => {
      const course = await this.machine.lockCourse(tx, courseId);
      this.machine.assertJoinable(course);
      const user = await tx.$queryRaw<
        { one: number }[]
      >`SELECT 1 AS one FROM users WHERE id = ${inviteeId}::uuid AND status = 'ACTIVE'`;
      if (user.length === 0) throw new ApiException('NOT_FOUND');
      const teacher = await tx.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM course_teachers WHERE course_id = ${courseId}::uuid AND user_id = ${inviteeId}::uuid`;
      if (teacher.length > 0)
        throw new ApiException('RESOURCE_CONFLICT', {
          message: 'A teacher of this course cannot be invited as a student',
        });
      const student = await tx.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM enrollments WHERE course_id = ${courseId}::uuid AND user_id = ${inviteeId}::uuid AND status IN ('ACTIVE', 'PENDING')`;
      if (student.length > 0) throw new ApiException('ALREADY_ENROLLED');
      const expiresAt = new Date(
        Date.now() + TIME_LIMITS.INVITATION_TTL_DAYS * DAY_MS,
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        const existing = await tx.$queryRaw<
          { id: string; status: string; expired: boolean }[]
        >`
          SELECT id, status, (expires_at <= now()) AS expired FROM invitations
           WHERE course_id = ${courseId}::uuid AND invited_user_id = ${inviteeId}::uuid FOR NO KEY UPDATE`;
        if (existing.length > 0) {
          if (existing[0].status === 'PENDING' && !existing[0].expired)
            throw new ApiException('INVITATION_PENDING');
          await tx.$executeRaw`
            UPDATE invitations SET status = 'PENDING', invited_by = ${actorId}::uuid, expires_at = ${expiresAt}, responded_at = NULL, updated_at = now()
             WHERE id = ${existing[0].id}::uuid`;
          return this.announce(
            tx,
            courseId,
            inviteeId,
            actorId,
            existing[0].id,
          );
        }
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO invitations (course_id, invited_user_id, invited_by, expires_at)
          VALUES (${courseId}::uuid, ${inviteeId}::uuid, ${actorId}::uuid, ${expiresAt})
          ON CONFLICT (course_id, invited_user_id) DO NOTHING RETURNING id`;
        if (inserted.length > 0)
          return this.announce(
            tx,
            courseId,
            inviteeId,
            actorId,
            inserted[0].id,
          );
      }
      throw new ApiException('RESOURCE_CONFLICT');
    });
    return this.one(id);
  }

  /** The invitations of a course for its teachers, newest first; EXPIRED is derived. */
  async list(
    courseId: string,
    window: { page: number; pageSize: number; offset: number },
  ): Promise<InvitationsPageDto> {
    const rows = await this.prisma.$queryRaw<
      (InvitationRow & { total: number })[]
    >`
      SELECT i.id, i.course_id, i.invited_user_id, i.invited_by, i.status, (i.expires_at <= now()) AS expired, i.expires_at, i.created_at,
             count(*) OVER ()::int AS total
        FROM invitations i WHERE i.course_id = ${courseId}::uuid
       ORDER BY i.updated_at DESC, i.id LIMIT ${window.pageSize} OFFSET ${window.offset}`;
    return {
      items: await this.view(rows),
      page: window.page,
      pageSize: window.pageSize,
      total: rows[0]?.total ?? 0,
    };
  }

  /** Revoke: the inviter or the Owner. Only a PENDING invitation can be revoked; losing to an accept is 409. */
  async revoke(
    actorId: string,
    courseId: string,
    invitationId: string,
  ): Promise<void> {
    const rows = await this.prisma.$queryRaw<{ invited_by: string }[]>`
      SELECT invited_by FROM invitations WHERE id = ${invitationId}::uuid AND course_id = ${courseId}::uuid`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    if (rows[0].invited_by !== actorId) {
      const owner = await this.prisma.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM course_teachers WHERE course_id = ${courseId}::uuid AND user_id = ${actorId}::uuid AND role = 'OWNER'`;
      if (owner.length === 0) throw new ApiException('FORBIDDEN');
    }
    const revoked = await this.prisma.$executeRaw`
      UPDATE invitations SET status = 'REVOKED', responded_at = now(), updated_at = now() WHERE id = ${invitationId}::uuid AND status = 'PENDING'`;
    if (revoked === 0)
      throw new ApiException('INVALID_STATE_TRANSITION', {
        message: 'The invitation is no longer pending',
      });
  }

  /** My valid (PENDING and not expired) invitations. */
  async mine(userId: string): Promise<MyInvitationDto[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        course_id: string;
        title: string;
        cover_key: string | null;
        inviter_id: string;
        inviter_name: string;
        inviter_key: string | null;
        expires_at: Date;
      }[]
    >`
      SELECT i.id, i.course_id, c.title, f.storage_key AS cover_key, u.id AS inviter_id, u.full_name AS inviter_name,
             uf.storage_key AS inviter_key, i.expires_at
        FROM invitations i JOIN courses c ON c.id = i.course_id JOIN users u ON u.id = i.invited_by
        LEFT JOIN file_assets f ON f.id = c.cover_file_id LEFT JOIN file_assets uf ON uf.id = u.avatar_file_id
       WHERE i.invited_user_id = ${userId}::uuid AND i.status = 'PENDING' AND i.expires_at > now()
         AND c.status = 'PUBLISHED' AND c.locked_by_admin_at IS NULL
       ORDER BY i.updated_at DESC, i.id`;
    return rows.map((r) => ({
      id: r.id,
      courseId: r.course_id,
      courseTitle: r.title,
      coverUrl: this.url(r.cover_key),
      invitedBy: {
        id: r.inviter_id,
        fullName: r.inviter_name,
        avatarUrl: this.url(r.inviter_key),
      },
      expiresAt: r.expires_at,
    }));
  }

  /** Accept: Course-S, then the conditional invitation update, then the student becomes ACTIVE; any refusal rolls all of it back. */
  async accept(userId: string, invitationId: string): Promise<EnrollmentDto> {
    const found = await this.prisma.$queryRaw<{ course_id: string }[]>`
      SELECT course_id FROM invitations WHERE id = ${invitationId}::uuid AND invited_user_id = ${userId}::uuid`;
    if (found.length === 0) throw new ApiException('NOT_FOUND');
    const courseId = found[0].course_id;
    await this.transactions.run(async (tx) => {
      const course = await this.machine.lockCourse(tx, courseId);
      this.machine.assertJoinable(course);
      const accepted = await tx.$executeRaw`
        UPDATE invitations SET status = 'ACCEPTED', responded_at = now(), updated_at = now()
         WHERE id = ${invitationId}::uuid AND invited_user_id = ${userId}::uuid AND status = 'PENDING' AND expires_at > now()`;
      if (accepted === 0)
        throw new ApiException('INVALID_STATE_TRANSITION', {
          message: 'The invitation is no longer valid',
        });
      await this.machine.apply(tx, course, {
        courseId,
        userId,
        action: 'ACCEPT_INVITATION',
      });
    });
    return this.enrollments.mine(userId, courseId);
  }

  async decline(userId: string, invitationId: string): Promise<void> {
    const declined = await this.prisma.$executeRaw`
      UPDATE invitations SET status = 'DECLINED', responded_at = now(), updated_at = now()
       WHERE id = ${invitationId}::uuid AND invited_user_id = ${userId}::uuid AND status = 'PENDING' AND expires_at > now()`;
    if (declined > 0) return;
    const exists = await this.prisma.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM invitations WHERE id = ${invitationId}::uuid AND invited_user_id = ${userId}::uuid`;
    throw new ApiException(
      exists.length === 0 ? 'NOT_FOUND' : 'INVALID_STATE_TRANSITION',
      {
        message: exists.length
          ? 'The invitation is no longer valid'
          : undefined,
      },
    );
  }

  private announce(
    tx: Tx,
    courseId: string,
    inviteeId: string,
    actorId: string,
    id: string,
  ): string {
    emitAfterCommit(tx, 'invitation.created', {
      courseId,
      inviteeId,
      invitedBy: actorId,
    });
    return id;
  }

  private async one(id: string): Promise<InvitationDto> {
    const rows = await this.prisma.$queryRaw<InvitationRow[]>`
      SELECT id, course_id, invited_user_id, invited_by, status, (expires_at <= now()) AS expired, expires_at, created_at FROM invitations WHERE id = ${id}::uuid`;
    return (await this.view(rows))[0];
  }

  private async view(rows: InvitationRow[]): Promise<InvitationDto[]> {
    if (rows.length === 0) return [];
    const ids = [
      ...new Set(rows.flatMap((r) => [r.invited_user_id, r.invited_by])),
    ];
    const people = await this.prisma.$queryRaw<
      { id: string; full_name: string; storage_key: string | null }[]
    >`
      SELECT u.id, u.full_name, f.storage_key FROM users u LEFT JOIN file_assets f ON f.id = u.avatar_file_id WHERE u.id = ANY(${ids}::uuid[])`;
    const byId = new Map(
      people.map((p) => [
        p.id,
        { id: p.id, fullName: p.full_name, avatarUrl: this.url(p.storage_key) },
      ]),
    );
    return rows.map((r) => ({
      id: r.id,
      invitee: byId.get(r.invited_user_id) as InvitationDto['invitee'],
      status: r.status === 'PENDING' && r.expired ? 'EXPIRED' : r.status,
      invitedBy: byId.get(r.invited_by) as InvitationDto['invitedBy'],
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }));
  }
}
