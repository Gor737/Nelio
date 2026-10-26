import { Prisma } from '../../../generated/prisma/client.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import type {
  CategoryRefDto,
  CourseCardDto,
  CourseStatusName,
  EnrollmentPolicyName,
  PersonRefDto,
  TagRefDto,
} from '../dto/courses.dto.js';

type Db = Pick<PrismaClient, '$queryRaw'>;

export interface CourseRow {
  id: string;
  title: string;
  summary: string | null;
  description: string | null;
  status: CourseStatusName;
  enrollment_policy: EnrollmentPolicyName;
  first_published_at: Date | null;
  archived_at: Date | null;
  locked_by_admin_at: Date | null;
  created_at: Date;
  cover_key: string | null;
  category_id: string | null;
  category_name: string | null;
  category_slug: string | null;
  owner_id: string;
  owner_name: string;
  owner_key: string | null;
  tags: TagRefDto[];
}

/** The columns every course view needs: course, cover, category, Owner and tags in one statement. */
export const COURSE_SELECT = Prisma.sql`
  c.id, c.title, c.summary, c.description, c.status, c.enrollment_policy, c.first_published_at, c.archived_at,
  c.locked_by_admin_at, c.created_at,
  f.storage_key AS cover_key,
  cat.id AS category_id, cat.name AS category_name, cat.slug AS category_slug,
  o.id AS owner_id, o.full_name AS owner_name, of.storage_key AS owner_key,
  COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'slug', t.slug) ORDER BY t.name, t.id)
              FROM course_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.course_id = c.id), '[]'::json) AS tags`;

export const COURSE_FROM = Prisma.sql`
  FROM courses c
  JOIN course_teachers ot ON ot.course_id = c.id AND ot.role = 'OWNER'
  JOIN users o ON o.id = ot.user_id
  LEFT JOIN file_assets of ON of.id = o.avatar_file_id
  LEFT JOIN file_assets f ON f.id = c.cover_file_id
  LEFT JOIN categories cat ON cat.id = c.category_id`;

export async function readCourse(
  db: Db,
  courseId: string,
): Promise<CourseRow | null> {
  const rows = await db.$queryRaw<CourseRow[]>`
    SELECT ${COURSE_SELECT} ${COURSE_FROM} WHERE c.id = ${courseId}::uuid`;
  return rows[0] ?? null;
}

export function toCard(
  row: CourseRow,
  publicUrl: (key: string | null) => string | null,
): CourseCardDto {
  const category: CategoryRefDto | null = row.category_id
    ? {
        id: row.category_id,
        name: row.category_name as string,
        slug: row.category_slug as string,
      }
    : null;
  const owner: PersonRefDto = {
    id: row.owner_id,
    fullName: row.owner_name,
    avatarUrl: publicUrl(row.owner_key),
  };
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    coverUrl: publicUrl(row.cover_key),
    category,
    tags: row.tags,
    enrollmentPolicy: row.enrollment_policy,
    owner,
    firstPublishedAt: row.first_published_at,
  };
}
