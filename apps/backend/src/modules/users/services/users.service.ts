import { Injectable } from '@nestjs/common';
import { COUNT_LIMITS } from '../../../common/constants/limits.js';
import { ApiException } from '../../../common/filters/index.js';
import { PrismaService } from '../../../infrastructure/database/index.js';
import { FilesService } from '../../files/index.js';
import type {
  MeDto,
  RoleName,
  RoleStatusName,
  UserSummaryDto,
} from '../dto/users.dto.js';

/** `LIKE`/`ILIKE` treat `%`, `_` and the escape character specially; a search for "50%" must find "50%", not everything. */
export const escapeLike = (text: string): string =>
  text.replace(/[\\%_]/g, (c) => `\\${c}`);

interface UserRow {
  id: string;
  full_name: string;
  storage_key: string | null;
}

/** Profile, user search and public profiles. The email address leaves this service only through `getMe`. */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async getMe(userId: string): Promise<MeDto> {
    const [user] = await this.prisma.$queryRaw<
      {
        id: string;
        email: string;
        full_name: string;
        email_verified_at: Date | null;
        created_at: Date;
        storage_key: string | null;
      }[]
    >`
      SELECT u.id, u.email, u.full_name, u.email_verified_at, u.created_at, f.storage_key
        FROM users u LEFT JOIN file_assets f ON f.id = u.avatar_file_id
       WHERE u.id = ${userId}::uuid`;
    if (!user) throw new ApiException('NOT_FOUND');
    const roles = await this.prisma.$queryRaw<
      { role: RoleName; status: RoleStatusName }[]
    >`SELECT role, status FROM user_roles WHERE user_id = ${userId}::uuid ORDER BY role`;
    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      avatarUrl: this.avatarUrl(user.storage_key),
      roles,
      emailVerified: user.email_verified_at !== null,
      createdAt: user.created_at,
    };
  }

  /**
   * Changes the caller's name and/or avatar. Only these two fields exist on the DTO, and the global validation pipe rejects every
   * other property (`role`, `status`, `email`, ...) with 400, so there is no way to write another column through this route.
   * The avatar must be a file the caller uploaded as kind AVATAR; anything else is the same 404 as a missing file.
   */
  async updateMe(
    userId: string,
    input: { fullName?: string; avatarFileId?: string | null },
  ): Promise<MeDto> {
    if (typeof input.avatarFileId === 'string') {
      const file = await this.prisma.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM file_assets
         WHERE id = ${input.avatarFileId}::uuid AND kind = 'AVATAR' AND uploaded_by = ${userId}::uuid`;
      if (file.length === 0) throw new ApiException('NOT_FOUND');
    }
    const data: { fullName?: string; avatarFileId?: string | null } = {};
    if (input.fullName !== undefined) data.fullName = input.fullName;
    if (input.avatarFileId !== undefined)
      data.avatarFileId = input.avatarFileId;
    if (Object.keys(data).length > 0) {
      await this.prisma.user.update({ where: { id: userId }, data });
    }
    return this.getMe(userId);
  }

  /**
   * Name search for people to message or invite (Decision 31, 128): signed-in users only, at least 2 characters, at most 20 results,
   * no pagination, safe fields only, suspended accounts never listed. Names that start with the text come first. The trigram index on
   * `full_name` serves the substring match.
   */
  async search(query: string): Promise<UserSummaryDto[]> {
    const text = query.trim();
    if (Array.from(text).length < COUNT_LIMITS.USER_SEARCH_MIN_QUERY_LENGTH) {
      throw new ApiException('VALIDATION_FAILED', {
        errors: [
          {
            field: 'q',
            messages: [
              `q must be at least ${COUNT_LIMITS.USER_SEARCH_MIN_QUERY_LENGTH} characters`,
            ],
          },
        ],
      });
    }
    const contains = `%${escapeLike(text)}%`;
    const starts = `${escapeLike(text)}%`;
    const rows = await this.prisma.$queryRaw<UserRow[]>`
      SELECT u.id, u.full_name, f.storage_key
        FROM users u LEFT JOIN file_assets f ON f.id = u.avatar_file_id
       WHERE u.status = 'ACTIVE' AND u.full_name ILIKE ${contains} ESCAPE '\\'
       ORDER BY (u.full_name ILIKE ${starts} ESCAPE '\\') DESC, u.full_name, u.id
       LIMIT ${COUNT_LIMITS.USER_SEARCH_MAX_RESULTS}`;
    return rows.map((r) => this.summary(r));
  }

  /** Another user's public profile. A suspended or unknown account is 404. */
  async getProfile(userId: string): Promise<UserSummaryDto> {
    const rows = await this.prisma.$queryRaw<UserRow[]>`
      SELECT u.id, u.full_name, f.storage_key
        FROM users u LEFT JOIN file_assets f ON f.id = u.avatar_file_id
       WHERE u.id = ${userId}::uuid AND u.status = 'ACTIVE'`;
    if (rows.length === 0) throw new ApiException('NOT_FOUND');
    return this.summary(rows[0]);
  }

  private summary(row: UserRow): UserSummaryDto {
    return {
      id: row.id,
      fullName: row.full_name,
      avatarUrl: this.avatarUrl(row.storage_key),
    };
  }

  private avatarUrl(storageKey: string | null): string | null {
    return storageKey ? this.files.publicUrl(storageKey) : null;
  }
}
