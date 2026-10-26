import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { BlockTypeName, ContentBlockDto } from '../dto/content.dto.js';
import { type VideoProvider, buildEmbedUrl } from './video-url.js';

interface BlockRow {
  id: string;
  position: number;
  type: BlockTypeName;
  text_body: string | null;
  video_provider: VideoProvider | null;
  video_external_id: string | null;
  original_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
}

/** The blocks of one lesson in order, as response objects. The storage key of a file never leaves the server. */
export async function readBlocks(
  db: Pick<PrismaClient, '$queryRaw'>,
  lessonId: string,
): Promise<ContentBlockDto[]> {
  const rows = await db.$queryRaw<BlockRow[]>`
    SELECT b.id, b.position, b.type, b.text_body, b.video_provider, b.video_external_id,
           f.original_name, f.mime_type, f.size_bytes::int AS size_bytes
      FROM content_blocks b LEFT JOIN file_assets f ON f.id = b.file_id
     WHERE b.lesson_id = ${lessonId}::uuid
     ORDER BY b.position, b.id`;
  return rows.map(toBlockDto);
}

export function toBlockDto(row: BlockRow): ContentBlockDto {
  return {
    id: row.id,
    position: row.position,
    type: row.type,
    textBody: row.text_body,
    video:
      row.video_provider && row.video_external_id
        ? {
            provider: row.video_provider,
            externalId: row.video_external_id,
            embedUrl: buildEmbedUrl(row.video_provider, row.video_external_id),
          }
        : null,
    file: row.original_name
      ? {
          name: row.original_name,
          mimeType: row.mime_type as string,
          sizeBytes: row.size_bytes as number,
        }
      : null,
  };
}
