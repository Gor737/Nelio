/**
 * Lock-table whitelist and global lock order (Decisions 159 and 160, docs/architecture.md section 15).
 * `lockRow(tx, table, id, mode)` (M6, designed in docs/spikes/m2-spike-b-report.md section 3) accepts only names from
 * LOCKABLE_TABLES; the SQL table behind each logical name is mapped in the database module once the schema exists (M5).
 *
 * Global lock order: advisory -> User rows (ascending id) -> Course -> Conversation(s) (ascending id) -> child rows
 * (Section ascending id -> Lesson -> Enrollment -> ConversationMember) -> moderation (Message before Report).
 * Spike B (M2) showed that the reverse order, or locking one kind of row in descending id order, deadlocks with 40P01.
 */
export const LOCK_ORDER = [
  'advisory',
  'user',
  'course',
  'conversation',
  'section',
  'lesson',
  'enrollment',
  'conversation_member',
  'message',
  'report',
] as const;
export type LockStage = (typeof LOCK_ORDER)[number];

/**
 * Tables that `lockRow` may lock by `id`. `advisory` is taken with `lockAdvisory`, and `conversation_member` has a
 * composite key (conversation_id, user_id) and is locked through its own statement, so neither is in this list.
 */
export const LOCKABLE_TABLES = [
  'user',
  'course',
  'conversation',
  'section',
  'lesson',
  'enrollment',
  'message',
  'report',
] as const;
export type LockableTable = (typeof LOCKABLE_TABLES)[number];

/** Row-lock modes: S = FOR SHARE (Course-S), X = FOR NO KEY UPDATE (Course-X); never FOR UPDATE (it blocks FK checks). */
export const ROW_LOCK_MODES = ['SHARE', 'NO_KEY_UPDATE'] as const;
export type RowLockMode = (typeof ROW_LOCK_MODES)[number];

/** Advisory lock keys (hashed with hashtextextended). Decision 160. */
export const ADVISORY_LOCK_KEYS = ['ADMIN-SET'] as const;
export type AdvisoryLockKey = (typeof ADVISORY_LOCK_KEYS)[number];
