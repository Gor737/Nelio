// Factories: direct INSERTs through the pool (no ORM, no service code), so a test can build any state, including states the
// application would refuse. Later milestones add courses, enrollments and conversations here.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Queryable } from './database.js';

export type PlatformRoleName = 'STUDENT' | 'TEACHER' | 'ADMIN';
export type RoleStatusName = 'PENDING' | 'ACTIVE' | 'REJECTED' | 'REVOKED';

let counter = 0;
export const unique = () =>
  `${Date.now().toString(36)}${(counter++).toString(36)}${randomBytes(3).toString('hex')}`;

export interface UserRow {
  id: string;
  email: string;
  full_name: string;
}

export async function createUser(
  q: Queryable,
  overrides: {
    email?: string;
    fullName?: string;
    status?: 'ACTIVE' | 'SUSPENDED';
  } = {},
): Promise<UserRow> {
  const { rows } = await q.query<UserRow>(
    `INSERT INTO users (email, full_name, status, password_hash, email_verified_at)
     VALUES ($1, $2, $3, 'argon2-placeholder', now()) RETURNING id, email, full_name`,
    [
      overrides.email ?? `user-${unique()}@example.test`,
      overrides.fullName ?? `User ${unique()}`,
      overrides.status ?? 'ACTIVE',
    ],
  );
  return rows[0];
}

/** A user with the given platform roles (default: ACTIVE STUDENT, the role every user gets at registration). */
export async function createUserWithRoles(
  q: Queryable,
  roles: { role: PlatformRoleName; status?: RoleStatusName }[] = [
    { role: 'STUDENT', status: 'ACTIVE' },
  ],
  overrides: Parameters<typeof createUser>[1] = {},
): Promise<UserRow> {
  const user = await createUser(q, overrides);
  for (const { role, status } of roles) {
    await q.query(
      'INSERT INTO user_roles (user_id, role, status) VALUES ($1, $2, $3)',
      [user.id, role, status ?? 'ACTIVE'],
    );
  }
  return user;
}

export const createAdmin = (q: Queryable) =>
  createUserWithRoles(q, [
    { role: 'STUDENT', status: 'ACTIVE' },
    { role: 'ADMIN', status: 'ACTIVE' },
  ]);

export const createTeacher = (q: Queryable) =>
  createUserWithRoles(q, [
    { role: 'STUDENT', status: 'ACTIVE' },
    { role: 'TEACHER', status: 'ACTIVE' },
  ]);

export async function createFile(
  q: Queryable,
  uploadedBy: string,
  overrides: {
    kind?: 'AVATAR' | 'COURSE_COVER' | 'LESSON_ATTACHMENT';
    sizeBytes?: number;
    mimeType?: string;
  } = {},
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO file_assets (uploaded_by, kind, storage_key, original_name, mime_type, size_bytes)
     VALUES ($1, $2, $3, 'file.png', $4, $5) RETURNING id`,
    [
      uploadedBy,
      overrides.kind ?? 'AVATAR',
      `files/${randomUUID()}`,
      overrides.mimeType ?? 'image/png',
      overrides.sizeBytes ?? 1024,
    ],
  );
  return rows[0].id;
}

export async function createRefreshToken(
  q: Queryable,
  userId: string,
  overrides: {
    familyId?: string;
    familyStartedAt?: Date;
    expiresAt?: Date;
    tokenHash?: string;
  } = {},
): Promise<string> {
  const startedAt = overrides.familyStartedAt ?? new Date();
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, family_started_at, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      userId,
      overrides.tokenHash ?? `hash-${unique()}`,
      overrides.familyId ?? randomUUID(),
      startedAt,
      overrides.expiresAt ??
        new Date(startedAt.getTime() + 7 * 24 * 3600 * 1000),
    ],
  );
  return rows[0].id;
}

export async function createAuditEntry(
  q: Queryable,
  actorId: string,
  overrides: {
    action?: string;
    targetType?: string;
    targetId?: string;
    metadata?: unknown;
  } = {},
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [
      actorId,
      overrides.action ?? 'USER_SUSPENDED',
      overrides.targetType ?? 'USER',
      overrides.targetId ?? randomUUID(),
      JSON.stringify(overrides.metadata ?? {}),
    ],
  );
  return rows[0].id;
}
