/**
 * The nightly jobs (docs/architecture.md section 18, Decision 162): cleanup jobs (Auth tokens, Files orphans, Notification retention) and the
 * two safety-net sweepers (Chat channel reconcile, Progress full completion recheck). They are scheduled with `@nestjs/schedule` INSIDE the
 * process, which is only correct because v1 runs ONE backend instance: a second instance would run every job twice (the jobs are idempotent
 * and take the same locks as requests, so this would be wasteful rather than wrong, but it is not a supported deployment).
 *
 * The times are UTC, staggered by ten minutes in the quiet hours, and written as six-field cron expressions (seconds first). They are not
 * configurable in v1 (there is no flag to switch a job off).
 * No job is exposed as an Admin endpoint.
 */
export const JOB_SCHEDULE = {
  AUTH_CLEANUP: { name: 'auth-cleanup', cron: '0 10 3 * * *' },
  FILE_CLEANUP: { name: 'file-cleanup', cron: '0 20 3 * * *' },
  NOTIFICATION_RETENTION: {
    name: 'notification-retention',
    cron: '0 30 3 * * *',
  },
  CHANNEL_RECONCILE: { name: 'channel-reconcile', cron: '0 40 3 * * *' },
  COMPLETION_RECHECK: { name: 'completion-recheck', cron: '0 50 3 * * *' },
} as const satisfies Record<string, { name: string; cron: string }>;

export type JobKey = keyof typeof JOB_SCHEDULE;
export const JOB_TIME_ZONE = 'UTC';
