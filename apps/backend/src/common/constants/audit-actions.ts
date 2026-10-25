/**
 * Audit actions: a constant list, separate from notification names (docs/architecture.md section 20, Decisions 78,
 * 137, 141). `AuditLog.action` is stored as text and validated against this list by `AuditWriter.record(tx, entry)`
 * (M6). Only privileged and relationship-changing actions are audited (Decision 78).
 *
 * Documented names: TEACHER_APPROVED (Decision 137 keeps it for audit while the notification is
 * TEACHER_APPLICATION_APPROVED), COURSE_ADMIN_UNLOCKED (Decision 141), REPORT_CONTEXT_VIEWED (Decision 77/78 area).
 * The remaining names are `derived` from the transaction catalog and the endpoint groups; they are listed in the M4
 * report for review. `writer` is the module that calls `AuditWriter`, and must be in AUDIT_WRITER_MODULES, which the
 * dependency-cruiser rule `audit-only-by-audited-modules` mirrors (a test keeps the two in sync).
 */
export const AUDIT_WRITER_MODULES = [
  'users',
  'courses',
  'enrollments',
  'chat',
  'moderation',
  'admin',
] as const;
export type AuditWriterModule = (typeof AUDIT_WRITER_MODULES)[number];

export interface AuditActionSpec {
  readonly writer: AuditWriterModule;
  readonly source: 'documented' | 'derived';
}

const documented = (writer: AuditWriterModule): AuditActionSpec => ({
  writer,
  source: 'documented',
});
const derived = (writer: AuditWriterModule): AuditActionSpec => ({
  writer,
  source: 'derived',
});

export const AUDIT_ACTIONS = {
  // users and roles
  TEACHER_APPROVED: documented('users'),
  TEACHER_REJECTED: derived('users'),
  TEACHER_REVOKED: derived('users'),
  USER_SUSPENDED: derived('users'),
  USER_UNSUSPENDED: derived('users'),
  ADMIN_ROLE_GRANTED: derived('users'),
  ADMIN_ROLE_REVOKED: derived('users'),
  // course lifecycle and team
  COURSE_PUBLISHED: derived('courses'),
  COURSE_ARCHIVED: derived('courses'),
  COURSE_RESTORED: derived('courses'),
  COURSE_DELETED: derived('courses'),
  COURSE_ADMIN_LOCKED: derived('courses'),
  COURSE_ADMIN_UNLOCKED: documented('courses'),
  COURSE_ADMIN_RESTORED: derived('courses'),
  COURSE_OWNERSHIP_TRANSFERRED: derived('courses'),
  COURSE_ASSISTANT_ADDED: derived('courses'),
  COURSE_ASSISTANT_REMOVED: derived('courses'),
  // students
  STUDENT_REMOVED: derived('enrollments'),
  STUDENT_REINSTATED: derived('enrollments'),
  // chat moderation
  MESSAGE_DELETED_BY_MODERATOR: derived('chat'),
  // reports
  REPORT_CONTEXT_VIEWED: documented('moderation'),
  REPORT_DISMISSED: derived('moderation'),
  REPORT_ACTIONED: derived('moderation'),
  // catalog management (Admin orchestrates the Catalog module)
  CATEGORY_CREATED: derived('admin'),
  CATEGORY_UPDATED: derived('admin'),
  CATEGORY_DELETED: derived('admin'),
  TAG_MERGED: derived('admin'),
} as const satisfies Record<string, AuditActionSpec>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as AuditAction[];
