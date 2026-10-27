import {
  Body,
  CallHandler,
  Controller,
  Delete,
  ExecutionContext,
  HttpCode,
  HttpException,
  Injectable,
  NestInterceptor,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { type Observable, catchError, throwError } from 'rxjs';
import { FILE_LIMITS } from '../../../common/constants/limits.js';
import { CurrentUser, RateLimit } from '../../../common/decorators/index.js';
import {
  ApiException,
  ErrorResponseDto,
} from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import {
  FileAssetDto,
  UploadFileBodyDto,
  UploadFileDto,
} from '../dto/file.dto.js';
import {
  FilesService,
  type UploadedFileData,
} from '../services/files.service.js';

/** The multipart parser stops reading at the largest limit of any kind; the limit of the chosen kind is checked afterwards. */
export const MAX_UPLOAD_BYTES = Math.max(
  ...Object.values(FILE_LIMITS).map((limit) => limit.maxBytes),
);

/**
 * On an UPLOAD route a body over the limit is 413 `FILE_TOO_LARGE`. (On every other route the global filter answers 400 for an
 * oversized body: Decision 167. The multipart parser's size error reaches us as a 413 HttpException; this is where it becomes the
 * documented code.)
 */
@Injectable()
export class UploadTooLargeInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof HttpException && error.getStatus() === 413
            ? new ApiException('FILE_TOO_LARGE', {
                message: `A file can be at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`,
              })
            : error,
        ),
      ),
    );
  }
}

@ApiTags('Files')
@ApiBearerAuth('access-token')
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @HttpCode(201)
  @RateLimit('TIGHT')
  @UseInterceptors(
    UploadTooLargeInterceptor,
    // No `fileFilter` on purpose: all checks happen on the complete file, and an asynchronous filter is the trigger of a known
    // denial-of-service advisory in the multipart parser. Memory storage, one file, a handful of small text fields.
    FileInterceptor('file', {
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
        fields: 4,
        fieldSize: 1024,
        parts: 6,
      },
    }),
  )
  @ApiOperation({
    summary: 'Upload a file',
    description:
      'Multipart upload through the API server. Limits per kind: AVATAR 2 MB (JPEG, PNG, WebP), COURSE_COVER 5 MB (JPEG, PNG, WebP), LESSON_ATTACHMENT 25 MB (PDF, JPEG, PNG, WebP, ZIP, plain text). The type is detected from the content; executables are refused whatever the name says. AVATAR for any user; COURSE_COVER and LESSON_ATTACHMENT for an ACTIVE Teacher.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadFileBodyDto })
  @ApiCreatedResponse({ type: FileAssetDto })
  @ApiResponse({
    status: 413,
    type: ErrorResponseDto,
    description: 'FILE_TOO_LARGE: over the limit of the kind (or over 25 MB).',
  })
  @ApiResponse({
    status: 415,
    type: ErrorResponseDto,
    description:
      'FILE_TYPE_NOT_ALLOWED: the real type of the file is not allowed for this kind.',
  })
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UploadFileDto,
    @UploadedFile() file?: UploadedFileData,
  ): Promise<FileAssetDto> {
    return this.files.toDto(
      await this.files.upload(user, { kind: dto.kind, file }),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete one of your own files that nothing uses',
    description:
      'A file that is somebody else`s, or does not exist, is 404. A file still used as an avatar, cover or attachment is 409 FILE_IN_USE.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description:
      'FILE_IN_USE: the file is an avatar, a cover or an attachment.',
  })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
  ): Promise<void> {
    await this.files.delete(user, id);
  }
}
