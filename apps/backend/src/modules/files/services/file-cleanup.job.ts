import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  JOB_SCHEDULE,
  JOB_TIME_ZONE,
} from '../../../common/constants/job-schedule.js';
import { runGuarded } from '../../../common/scheduling/guarded-run.js';
import { FileCleanupService } from './file-cleanup.service.js';

/** Deletes uploaded files that nothing references after the grace period. Scheduled nightly ({@link JOB_SCHEDULE}), one instance only (Decision 162). Not exposed as an endpoint. */
@Injectable()
export class FileCleanupJob {
  private readonly logger = new Logger(FileCleanupJob.name);

  constructor(private readonly cleanup: FileCleanupService) {}

  @Cron(JOB_SCHEDULE.FILE_CLEANUP.cron, {
    name: JOB_SCHEDULE.FILE_CLEANUP.name,
    timeZone: JOB_TIME_ZONE,
  })
  run() {
    return runGuarded(JOB_SCHEDULE.FILE_CLEANUP.name, this.logger, () =>
      this.cleanup.run(),
    );
  }
}
