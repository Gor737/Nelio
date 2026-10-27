import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  JOB_SCHEDULE,
  JOB_TIME_ZONE,
} from '../../../common/constants/job-schedule.js';
import { runGuarded } from '../../../common/scheduling/guarded-run.js';
import { AuthCleanupService } from './auth-cleanup.service.js';

/** Removes refresh tokens and email tokens that expired more than a day ago. Scheduled nightly ({@link JOB_SCHEDULE}), one instance only (Decision 162). Not exposed as an endpoint. */
@Injectable()
export class AuthCleanupJob {
  private readonly logger = new Logger(AuthCleanupJob.name);

  constructor(private readonly cleanup: AuthCleanupService) {}

  @Cron(JOB_SCHEDULE.AUTH_CLEANUP.cron, {
    name: JOB_SCHEDULE.AUTH_CLEANUP.name,
    timeZone: JOB_TIME_ZONE,
  })
  run() {
    return runGuarded(JOB_SCHEDULE.AUTH_CLEANUP.name, this.logger, () =>
      this.cleanup.run(),
    );
  }
}
