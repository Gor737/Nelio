import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  JOB_SCHEDULE,
  JOB_TIME_ZONE,
} from '../../../common/constants/job-schedule.js';
import { runGuarded } from '../../../common/scheduling/guarded-run.js';
import { CompletionService } from './completion.service.js';

/** Safety net: re-checks every ACTIVE incomplete enrollment; logs when it repairs something. Scheduled nightly ({@link JOB_SCHEDULE}), one instance only (Decision 162). Not exposed as an endpoint. */
@Injectable()
export class CompletionRecheckJob {
  private readonly logger = new Logger(CompletionRecheckJob.name);

  constructor(private readonly completion: CompletionService) {}

  @Cron(JOB_SCHEDULE.COMPLETION_RECHECK.cron, {
    name: JOB_SCHEDULE.COMPLETION_RECHECK.name,
    timeZone: JOB_TIME_ZONE,
  })
  run() {
    return runGuarded(JOB_SCHEDULE.COMPLETION_RECHECK.name, this.logger, () =>
      this.completion.recheckAllCourses(),
    );
  }
}
