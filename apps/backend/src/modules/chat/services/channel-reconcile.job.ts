import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  JOB_SCHEDULE,
  JOB_TIME_ZONE,
} from '../../../common/constants/job-schedule.js';
import { runGuarded } from '../../../common/scheduling/guarded-run.js';
import { CourseChannelService } from './course-channel.service.js';

/** Safety net: re-syncs the membership of every course channel; logs when it repairs something. Scheduled nightly ({@link JOB_SCHEDULE}), one instance only (Decision 162). Not exposed as an endpoint. */
@Injectable()
export class ChannelReconcileJob {
  private readonly logger = new Logger(ChannelReconcileJob.name);

  constructor(private readonly channels: CourseChannelService) {}

  @Cron(JOB_SCHEDULE.CHANNEL_RECONCILE.cron, {
    name: JOB_SCHEDULE.CHANNEL_RECONCILE.name,
    timeZone: JOB_TIME_ZONE,
  })
  run() {
    return runGuarded(JOB_SCHEDULE.CHANNEL_RECONCILE.name, this.logger, () =>
      this.channels.reconcileAll(),
    );
  }
}
