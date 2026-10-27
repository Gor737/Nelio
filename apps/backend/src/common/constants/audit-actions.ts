/**
 * Audit actions: a constant list, separate from notification names (docs/architecture.md section 20, Decisions 78,
 * 137, 141). `AuditLog.action` is stored as text and validated against this list by `AuditWriter.record(tx, entry)`
 * (M6). Only privileged and relationship-changing actions are audited (Decision 78).
 *
 * Documented names: TEACHER_APPROVED (Decision 137 keeps it for audit while the notification is
 * TEACHER_APPLICATION_APPROVED), COURSE_ADMIN_UNLOCKED (Decision 141), REPORT_CONTEXT_VIEWED (Decision 77/78 area).
 * The remaining names are `approved-derived`: derived from the transaction catalog and the endpoint groups, listed in
 * docs/proposed-defaults.md and approved by the owner on 2026-10-25. `writer` is the module that calls `AuditWriter`,
 * and must be in AUDIT_WRITER_MODULES, which the
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
  readonly source: 'documented' | 'approved-derived';
}

const documented = (writer: AuditWriterModule): AuditActionSpec => ({
  writer,
  source: 'documented',
});
const approvedDerived = (writer: AuditWriterModule): AuditActionSpec => ({
  writer,
  source: 'approved-derived',
});

export const AUDIT_ACTIONS = {
  // users and roles
  TEACHER_APPROVED: documented('users'),
  TEACHER_REJECTED: approvedDerived('users'),
  TEACHER_REVOKED: approvedDerived('users'),
  /** Decision 128: a REJECTED or REVOKED user applies again; the overwritten application message is kept here. */
  TEACHER_REAPPLIED: approvedDerived('users'),
  USER_SUSPENDED: approvedDerived('users'),
  USER_UNSUSPENDED: approvedDerived('users'),
  ADMIN_ROLE_GRANTED: approvedDerived('users'),
  ADMIN_ROLE_REVOKED: approvedDerived('users'),
  // course lifecycle and team
  COURSE_PUBLISHED: approvedDerived('courses'),
  COURSE_ARCHIVED: approvedDerived('courses'),
  COURSE_RESTORED: approvedDerived('courses'),
  COURSE_DELETED: approvedDerived('courses'),
  COURSE_ADMIN_LOCKED: approvedDerived('courses'),
  COURSE_ADMIN_UNLOCKED: documented('courses'),
  COURSE_ADMIN_RESTORED: approvedDerived('courses'),
  COURSE_OWNERSHIP_TRANSFERRED: approvedDerived('courses'),
  COURSE_ASSISTANT_ADDED: approvedDerived('courses'),
  COURSE_ASSISTANT_REMOVED: approvedDerived('courses'),
  // students
  STUDENT_REMOVED: approvedDerived('enrollments'),
  STUDENT_REINSTATED: approvedDerived('enrollments'),
  // chat moderation
  MESSAGE_DELETED_BY_MODERATOR: approvedDerived('chat'),
  // reports
  REPORT_CONTEXT_VIEWED: documented('moderation'),
  REPORT_DISMISSED: approvedDerived('moderation'),
  REPORT_ACTIONED: approvedDerived('moderation'),
  // catalog management (Admin orchestrates the Catalog module)
  CATEGORY_CREATED: approvedDerived('admin'),
  CATEGORY_UPDATED: approvedDerived('admin'),
  CATEGORY_DELETED: approvedDerived('admin'),
  TAG_MERGED: approvedDerived('admin'),
} as const satisfies Record<string, AuditActionSpec>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as AuditAction[];
