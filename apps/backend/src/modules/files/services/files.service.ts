import { Injectable, Logger } from '@nestjs/common';
import {
  FILE_LIMITS,
  TIME_LIMITS,
  type FileKind,
} from '../../../common/constants/limits.js';
import { ApiException } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import {
  PrismaService,
  isForeignKeyViolation,
} from '../../../infrastructure/database/index.js';
import type { FileAssetDto, SignedUrlDto } from '../dto/file.dto.js';
import { StorageDriver } from '../storage/storage-driver.js';
import { detectFileType } from './file-type-detector.js';
import {
  generateStorageKey,
  isPublicKind,
  sanitizeOriginalName,
} from './file-names.js';

/** What the multipart parser gives us for the `file` part (memory storage). */
export interface UploadedFileData {
  readonly buffer: Buffer;
  readonly originalname: string;
  readonly size: number;
}

export interface FileView {
  readonly id: string;
  readonly kind: FileKind;
  readonly originalName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly url: string | null;
  readonly createdAt: Date;
}

const MB = 1024 * 1024;

/** Upload, delete and URLs of files (docs/architecture.md section 16, Decisions 64, 116, 127). The only module that touches storage. */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageDriver,
  ) {}

  /**
   * Stores one uploaded file. Order of the checks (cheapest and most definite first): who may upload this kind (403), a file was sent
   * (400), size of the kind (413), real type (415). Order of the effects: STORAGE first, then the metadata row; if the row cannot be
   * written the object is removed again (best effort), so a failure leaves at most an unreferenced object, never a row without bytes.
   */
  async upload(
    user: AuthenticatedUser,
    input: { kind: FileKind; file: UploadedFileData | undefined },
  ): Promise<FileView> {
    const { kind, file } = input;
    if (kind !== 'AVATAR' && !user.activeRoles.includes('TEACHER'))
      throw new ApiException('TEACHER_NOT_APPROVED');
    if (!file)
      throw validation(
        'file',
        'file is required: send it as the multipart part named "file"',
      );
    if (file.size === 0 || file.buffer.length === 0)
      throw validation('file', 'file must not be empty');

    const limits = FILE_LIMITS[kind];
    if (file.size > limits.maxBytes) {
      throw new ApiException('FILE_TOO_LARGE', {
        message: `A ${kind} can be at most ${limits.maxBytes / MB} MB`,
      });
    }

    const detected = detectFileType(file.buffer);
    if (
      detected.kind !== 'allowed' ||
      !limits.mimeTypes.includes(detected.mimeType)
    ) {
      // Never say what the file was detected as: the answer must not help someone probing the detector.
      throw new ApiException('FILE_TYPE_NOT_ALLOWED', {
        message: `This type of file is not allowed for the ${kind} kind`,
      });
    }

    const storageKey = generateStorageKey(kind, detected.extension);
    await this.storage.put(storageKey, file.buffer, detected.mimeType);
    try {
      const row = await this.prisma.fileAsset.create({
        data: {
          uploadedBy: user.id,
          kind,
          storageKey,
          originalName: sanitizeOriginalName(file.originalname),
          mimeType: detected.mimeType,
          sizeBytes: file.buffer.length,
        },
      });
      return this.view(row);
    } catch (error) {
      await this.storage.delete(storageKey).catch((cleanup: unknown) => {
        this.logger.warn({
          event: 'upload_cleanup_failed',
          error: cleanup instanceof Error ? cleanup.name : 'unknown',
        });
      });
      throw error;
    }
  }

  /**
   * Deletes an unattached file of the caller. The row goes first, the object second (docs/architecture.md section 16). The row is
   * not found for somebody else's file (404, so existence is not revealed). A file that something still references is refused by the
   * database itself (every reference is RESTRICT): 409 `FILE_IN_USE`. A failing object delete is logged and leaves an unreferenced
   * object, which is harmless.
   */
  async delete(user: AuthenticatedUser, fileId: string): Promise<void> {
    const row = await this.prisma.fileAsset.findFirst({
      where: { id: fileId, uploadedBy: user.id },
      select: { storageKey: true },
    });
    if (!row) throw new ApiException('NOT_FOUND');
    try {
      const { count } = await this.prisma.fileAsset.deleteMany({
        where: { id: fileId, uploadedBy: user.id },
      });
      if (count === 0) throw new ApiException('NOT_FOUND'); // deleted by a concurrent request
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new ApiException('FILE_IN_USE');
      throw error;
    }
    await this.deleteObject(row.storageKey);
  }

  /**
   * A short-lived download link for a private attachment. The CALLER (the Content module) has already checked that the user may
   * read the lesson block that holds this file; this service only signs. Anything that is not an attachment is not found.
   */
  async signedDownload(fileId: string): Promise<SignedUrlDto> {
    const row = await this.prisma.fileAsset.findUnique({
      where: { id: fileId },
      select: {
        kind: true,
        storageKey: true,
        originalName: true,
        mimeType: true,
      },
    });
    if (!row || row.kind !== 'LESSON_ATTACHMENT')
      throw new ApiException('NOT_FOUND');
    const ttl = TIME_LIMITS.SIGNED_URL_TTL_MS;
    const url = await this.storage.signedGetUrl(row.storageKey, {
      expiresInSeconds: Math.floor(ttl / 1000),
      downloadName: row.originalName,
      contentType: row.mimeType,
    });
    return { url, expiresAt: new Date(Date.now() + ttl).toISOString() };
  }

  /** The public URL of an AVATAR or COURSE_COVER given its storage key; for the mappers of Users and Courses. */
  publicUrl(storageKey: string): string {
    return this.storage.publicUrl(storageKey);
  }

  /** Removes an object from storage without ever throwing (used after the row is already gone). */
  async deleteObject(storageKey: string): Promise<boolean> {
    try {
      await this.storage.delete(storageKey);
      return true;
    } catch (error) {
      this.logger.warn({
        event: 'storage_delete_failed',
        error: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
  }

  toDto(view: FileView): FileAssetDto {
    return { ...view, createdAt: view.createdAt.toISOString() };
  }

  private view(row: {
    id: string;
    kind: FileKind;
    originalName: string;
    mimeType: string;
    sizeBytes: bigint;
    storageKey: string;
    createdAt: Date;
  }): FileView {
    return {
      id: row.id,
      kind: row.kind,
      originalName: row.originalName,
      mimeType: row.mimeType,
      sizeBytes: Number(row.sizeBytes),
      url: isPublicKind(row.kind)
        ? this.storage.publicUrl(row.storageKey)
        : null,
      createdAt: row.createdAt,
    };
  }
}

function validation(field: string, message: string): ApiException {
  return new ApiException('VALIDATION_FAILED', {
    message: 'Validation failed',
    errors: [{ field, messages: [message] }],
  });
}
