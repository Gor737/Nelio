import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  JOB_SCHEDULE,
  JOB_TIME_ZONE,
} from '../../../common/constants/job-schedule.js';
import { runGuarded } from '../../../common/scheduling/guarded-run.js';
import { NotificationRetention } from './notification-retention.service.js';

/** Removes read notifications older than the retention period. Scheduled nightly ({@link JOB_SCHEDULE}), one instance only (Decision 162). Not exposed as an endpoint. */
@Injectable()
export class NotificationRetentionJob {
  private readonly logger = new Logger(NotificationRetentionJob.name);

  constructor(private readonly retention: NotificationRetention) {}

  @Cron(JOB_SCHEDULE.NOTIFICATION_RETENTION.cron, {
    name: JOB_SCHEDULE.NOTIFICATION_RETENTION.name,
    timeZone: JOB_TIME_ZONE,
  })
  run() {
    return runGuarded(
      JOB_SCHEDULE.NOTIFICATION_RETENTION.name,
      this.logger,
      () => this.retention.purgeOldRead(),
    );
  }
}
