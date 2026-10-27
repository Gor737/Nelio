import { Module } from '@nestjs/common';
import {
  FilesController,
  UploadTooLargeInterceptor,
} from './controllers/files.controller.js';
import { FileCleanupJob } from './services/file-cleanup.job.js';
import { FileCleanupService } from './services/file-cleanup.service.js';
import { FilesService } from './services/files.service.js';
import { S3StorageDriver } from './storage/s3-storage.driver.js';
import { StorageDriver } from './storage/storage-driver.js';

/**
 * Files (Layer 0): upload through the API server, delete, public URLs and signed URLs, and the orphan cleanup job.
 * It imports no other domain module; `StorageDriver` is private to this module.
 */
@Module({
  controllers: [FilesController],
  providers: [
    { provide: StorageDriver, useClass: S3StorageDriver },
    FilesService,
    FileCleanupService,
    FileCleanupJob,
    UploadTooLargeInterceptor,
  ],
  exports: [FilesService, FileCleanupService],
})
export class FilesModule {}
