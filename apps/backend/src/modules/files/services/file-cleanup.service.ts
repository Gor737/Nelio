import { Injectable, Logger } from '@nestjs/common';
import { TIME_LIMITS } from '../../../common/constants/limits.js';
import {
  PrismaService,
  TransactionService,
  isForeignKeyViolation,
  isLockTimeout,
} from '../../../infrastructure/database/index.js';
import { FilesService } from './files.service.js';

export interface FileCleanupResult {
  /** Rows deleted (and their objects removed or attempted). */
  readonly deleted: number;
  /** Files that became referenced between the check and the delete (a concurrent attach): left alone. */
  readonly skippedInUse: number;
  /** Objects that could not be removed from storage (the row is already gone). */
  readonly storageFailures: number;
}

const BATCH = 100;

/**
 * The orphan cleanup job (docs/architecture.md section 16, roadmap M9a): files older than 24 hours that nothing references (not an
 * avatar, a cover or a block attachment) are deleted. It is a plain service method; M13 schedules it nightly (single instance,
 * Decision 162). It reads the three referencing tables directly, as the architecture allows (reads may cross modules).
 *
 * The foreign keys make it safe against a concurrent attach: the DELETE needs a lock that an attach (an UPDATE or INSERT that
 * references the file) holds until it commits, and when the attach commits first the foreign key (RESTRICT) refuses the DELETE, so the
 * cleanup loses cleanly and leaves the file alone. A delete that cannot get its lock within the transaction's lock timeout is skipped as well.
 * Order: the database row first, the storage object second.
 */
@Injectable()
export class FileCleanupService {
  private readonly logger = new Logger(FileCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly files: FilesService,
  ) {}

  async run(
    now: Date = new Date(),
    olderThanHours: number = TIME_LIMITS.ORPHAN_FILE_AGE_HOURS,
  ): Promise<FileCleanupResult> {
    const cutoff = new Date(now.getTime() - olderThanHours * 3600 * 1000);
    let deleted = 0;
    let skippedInUse = 0;
    let storageFailures = 0;
    const seen = new Set<string>();

    for (;;) {
      const batch = await this.prisma.$queryRaw<
        { id: string; storage_key: string }[]
      >`
        SELECT f.id, f.storage_key
          FROM file_assets f
         WHERE f.created_at < ${cutoff}
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)
           AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.cover_file_id = f.id)
           AND NOT EXISTS (SELECT 1 FROM content_blocks b WHERE b.file_id = f.id)
         ORDER BY f.created_at, f.id
         LIMIT ${BATCH + seen.size}`;
      const fresh = batch.filter((row) => !seen.has(row.id));
      if (fresh.length === 0) break;

      for (const row of fresh) {
        seen.add(row.id);
        try {
          await this.transactions.run(
            (tx) => tx.fileAsset.delete({ where: { id: row.id } }),
            { maxAttempts: 1 },
          );
        } catch (error) {
          if (isForeignKeyViolation(error) || isLockTimeout(error)) {
            skippedInUse++;
            continue;
          }
          if ((error as { code?: string }).code === 'P2025') continue; // already deleted by someone else (the owner)
          throw error;
        }
        deleted++;
        if (!(await this.files.deleteObject(row.storage_key)))
          storageFailures++;
      }
    }

    if (deleted > 0 || skippedInUse > 0)
      this.logger.log({
        event: 'orphan_files_cleaned',
        deleted,
        skippedInUse,
        storageFailures,
      });
    return { deleted, skippedInUse, storageFailures };
  }
}
