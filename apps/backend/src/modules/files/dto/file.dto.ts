import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { FILE_KINDS, type FileKind } from '../../../common/constants/limits.js';

/** The text fields of the multipart upload request (the file itself is the `file` part). Unknown fields are rejected (400). */
export class UploadFileDto {
  @ApiProperty({
    enum: FILE_KINDS,
    description:
      'What the file is for. AVATAR: any logged-in user. COURSE_COVER and LESSON_ATTACHMENT: an ACTIVE Teacher (otherwise 403 TEACHER_NOT_APPROVED).',
  })
  @IsIn(FILE_KINDS)
  kind!: FileKind;
}

/** Documentation shape of the multipart body (Swagger cannot infer it from `@UploadedFile`). */
export class UploadFileBodyDto extends UploadFileDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description:
      'The file. The type is detected from its content, never from its name or Content-Type.',
  })
  file!: unknown;
}

/** A stored file, as the API shows it. The storage key is never exposed. */
export class FileAssetDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: FILE_KINDS })
  kind!: FileKind;

  @ApiProperty({
    example: 'syllabus.pdf',
    description: 'The uploaded name, sanitized; for display only.',
  })
  originalName!: string;

  @ApiProperty({
    example: 'application/pdf',
    description: 'The DETECTED type, not the one the client claimed.',
  })
  mimeType!: string;

  @ApiProperty({ example: 52311, description: 'Size in bytes.' })
  sizeBytes!: number;

  @ApiProperty({
    type: String,
    format: 'uri',
    nullable: true,
    description:
      'Public URL of an AVATAR or COURSE_COVER. Null for a LESSON_ATTACHMENT (served through signed URLs only).',
  })
  url!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/** A short-lived link for downloading a private attachment. */
export class SignedUrlDto {
  @ApiProperty({ format: 'uri' })
  url!: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'When the URL stops working. Request a new one instead of storing this.',
  })
  expiresAt!: string;
}
