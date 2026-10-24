# Nelio — Decision Log

> **Scope:** the authoritative chronological record of Decisions 1–164. Decision 165 is listed as Proposed (awaiting owner approval) and is not yet part of the accepted record.
> **Purpose:** records WHAT was decided and WHY. `architecture.md` describes the final HOW; `roadmap.md` describes implementation order.
> **Status convention:** "Accepted" means the decision was approved by the project owner. Where a decision was later amended, tightened, extended, finalized or had its implementation changed by a later decision, this is stated in its Status line and in the later decision. Original wording is preserved, and the amendment is recorded rather than silently resolved.

---

## Decision 1 — Modular monolith, no microservices

**Status:** Accepted

### Decision
Nelio is built as a modular monolith. Microservices are not used.

### Reason / Context
The project is a graduation project built by one developer. The architecture must be clean, maintainable and not over-engineered.

### Consequences / Constraints
Later decisions assume a single backend instance (presence, throttling and scheduled jobs are in-process).

---

## Decision 2 — PostgreSQL as the main relational database

**Status:** Accepted

### Decision
PostgreSQL is the primary database, modeled relationally.

### Reason / Context
The domain is highly relational, and integrity should be enforced by the database wherever possible.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 3 — Backend independent of the frontend state-management library

**Status:** Accepted

### Decision
Backend and database design do not depend on the frontend choice (Redux Toolkit or Zustand, not finalized).

### Reason / Context
The backend exposes an API and does not care which library holds client state.

### Consequences / Constraints
Decision 143 later notes that the frontend must still be built around the cookie and in-memory token design, without changing this decision.

---

## Decision 4 — Users can hold multiple platform roles

**Status:** Accepted (amended by Decision 51)

### Decision
A user can hold several platform roles (for example Teacher and Student). Originally modeled as a `Role` table plus a `UserRole` junction table.

### Reason / Context
A teacher must be able to enroll in another teacher's course. Platform roles (global) are distinct from course roles (contextual).

### Consequences / Constraints
`UserRole` carries data (status), so it is a real entity. Decision 51 replaced the `Role` table with an enum column on `UserRole`, while keeping the many-to-many relationship through `UserRole`.

---

## Decision 5 — Teacher role requires Admin approval

**Status:** Accepted

### Decision
Anyone can apply to be a Teacher, but the Teacher role needs Admin approval before the user can create or manage courses. The state lives on `UserRole`.

### Reason / Context
Approval is a business requirement.

### Consequences / Constraints
A pending teacher must be blocked on the server, not only in the UI. Decision 108 and 152 make this automatic through the per-request role load.

---

## Decision 6 — Course teachers: fixed roles, Owner and Assistant

**Status:** Accepted

### Decision
A course can have multiple teachers with fixed course roles: Owner and Assistant. Fine-grained per-teacher permissions are not used.

### Reason / Context
Fixed roles are simple, testable and fit a graduation project. Fine-grained permissions would be over-engineering.

### Consequences / Constraints
No policy library (see Decision 109). Assistant capabilities are specified in Decision 37.

---

## Decision 7 — Enrollment policy is set per course

**Status:** Accepted

### Decision
Each course defines one enrollment policy: open, approval required, or invitation only.

### Reason / Context
Flexibility requested by the project owner.

### Consequences / Constraints
Enrollment needs a status. Invitation-only requires an Invitation concept (see Decisions 43 and 71).

---

## Decision 8 — One enrollment per student per course; leaving is a status change

**Status:** Accepted

### Decision
There is one enrollment record per student per course. Leaving changes the status, and returning reactivates the same row. Progress is preserved.

### Reason / Context
Progress must not be destroyed when a student leaves.

### Consequences / Constraints
Unique `(course_id, user_id)`. No hard delete of enrollments.

---

## Decision 9 — Content is never hard-deleted when progress exists

**Status:** Accepted (implementation changed by Decision 69)

### Decision
Course content is not hard-deleted when student progress depends on it. Mechanism proposed: a status field (draft / published / archived) plus soft delete, with no versioning.

### Reason / Context
Teachers may edit content after students enroll, but progress must not be destroyed. Full versioning was judged too heavy.

### Consequences / Constraints
Decision 69 keeps the intent but drops `deleted_at` for lessons in favor of the `ARCHIVED` status.

---

## Decision 10 — Owner must transfer courses before Teacher revocation; Admin may transfer on behalf

**Status:** Accepted

### Decision
An Owner must transfer ownership of their courses before their Teacher role can be revoked. An Admin may perform the transfer on behalf of an unreachable Owner.

### Reason / Context
Prevents courses from being left without a valid Owner, and avoids a deadlock when an Owner is unreachable.

### Consequences / Constraints
The transfer is recorded for audit. The new Owner must hold an approved Teacher role. Revocation also removes Assistant memberships.

---

## Decision 11 — Course lifecycle: DRAFT → PUBLISHED → ARCHIVED

**Status:** Accepted

### Decision
Courses move DRAFT → PUBLISHED → ARCHIVED. Drafts are not enrollable; published courses are available; archived courses accept no new enrollments but keep student data and progress. A course with enrolled students never returns to draft. Archived courses can be restored to PUBLISHED.

### Reason / Context
Students with progress must not lose access to their data.

### Consequences / Constraints
"No draft once students exist" is a service-layer rule, since PostgreSQL cannot express it.

---

## Decision 12 — Completion is a permanent snapshot plus a live percentage

**Status:** Accepted

### Decision
Course completion is a permanent `completed_at` snapshot. New lessons added later count as additional unfinished content, but do not remove the earned completion.

### Reason / Context
Fairness to students who completed the course.

### Consequences / Constraints
A student can be "completed" while their live percent is below 100. The API keeps `completedAt` and `percent` separate (Decision 126).

---

## Decision 13 — Lesson content v1: text, video, files

**Status:** Accepted

### Decision
Lessons support text, video and file attachments. No quizzes, assignments or grading in v1.

### Reason / Context
Keeps scope manageable.

### Consequences / Constraints
Future quizzes would be a separate domain.

---

## Decision 14 — Exactly one Owner per course

**Status:** Accepted

### Decision
A course has exactly one Owner.

### Reason / Context
Keeps ownership transfer a clean, unambiguous operation.

### Consequences / Constraints
The enforcement mechanism was finalized in Decision 61 (partial unique index for "at most one" plus transaction-safe logic for "never zero").

---

## Decision 15 — Permanent course deletion only if never enrolled

**Status:** Accepted (tightened by Decision 88)

### Decision
A course can be permanently deleted only if it has never had any enrollment. Courses with enrollment history are never permanently deleted.

### Reason / Context
Enrollment history and progress must not be destroyed.

### Consequences / Constraints
The `Enrollment → Course` FK is `RESTRICT` as a backstop. Decision 88 tightened the rule to "never published" and keeps this one as a second safety net.

---

## Decision 16 — Completion is automatic only

**Status:** Accepted

### Decision
A student is marked completed automatically when all currently published lessons are completed. Teachers cannot mark completion manually.

### Reason / Context
Project owner's rule.

### Consequences / Constraints
Completion logic has several triggers (see Decisions 19, 27 and 160).

---

## Decision 17 — Video is an external URL only

**Status:** Accepted

### Decision
Videos use external URLs (YouTube/Vimeo). Uploaded video hosting is not provided in v1.

### Reason / Context
Hosting video means storage, streaming and cost, which is too large for one developer.

### Consequences / Constraints
Allowed providers are validated; see Decision 68 (provider plus external id are stored).

---

## Decision 18 — A lesson contains multiple ordered content blocks

**Status:** Accepted

### Decision
A lesson contains ordered content blocks (text, video, file). Teachers control order and may repeat block types.

### Reason / Context
More flexible than fixed fields; adding block types later is easy.

### Consequences / Constraints
Progress stays at lesson level, not block level. Ordering strategy is in Decision 67; table design in Decision 68.

---

## Decision 19 — Completion is re-evaluated when a teacher unpublishes or archives a lesson

**Status:** Accepted

### Decision
When a teacher unpublishes or archives a lesson, completion is re-evaluated, and active students who now have all remaining published lessons completed are marked completed.

### Reason / Context
Following decision 16, a student can qualify without doing anything new.

### Consequences / Constraints
Applies to `ACTIVE` enrollments only. This is a second trigger beyond a student finishing a lesson.

---

## Decision 20 — Completion requires at least one published lesson

**Status:** Accepted

### Decision
A course must have at least one published lesson before any student can be marked completed.

### Reason / Context
Prevents instant completion of an empty course.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 21 — Lesson completion is manual, per lesson, irreversible and idempotent

**Status:** Accepted

### Decision
Students mark a lesson complete with a button. Completion is tracked per lesson, cannot be undone, and repeating the action is harmless.

### Reason / Context
Simple and reliable for every block type. Behavior-based tracking is unreliable with embedded video.

### Consequences / Constraints
The server enforces that the lesson is published, the enrollment active and the lesson in the course. Completions are insert-only.

---

## Decision 22 — "Last visited lesson" is stored per enrollment; no time tracking

**Status:** Accepted

### Decision
The last visited lesson is stored on the enrollment. Time spent is not tracked.

### Reason / Context
Cheap "continue where you left off" without extra tables.

### Consequences / Constraints
The pointer is nullable and must tolerate an archived lesson.

---

## Decision 23 — No enforced lesson order

**Status:** Accepted

### Decision
Students may open and complete lessons in any order.

### Reason / Context
Removes problems around reordering breaking access.

### Consequences / Constraints
Progress is a simple set of completed lessons.

---

## Decision 24 — One auto-created general channel per course, on first publish

**Status:** Accepted

### Decision
One general channel is created automatically when a course is first published. A course has one channel in v1.

### Reason / Context
Requirement from the project owner.

### Consequences / Constraints
Created only on first publish, so restoring an archived course reuses it. Draft courses have no channel. At most one channel per course is guaranteed by a unique constraint.

---

## Decision 25 — Course channel members: Owner, Assistants and active students

**Status:** Accepted

### Decision
The Owner, Assistants and active enrolled students are automatically channel members. A student who leaves is removed from the channel.

### Reason / Context
Channel access follows course participation.

### Consequences / Constraints
Membership must stay in sync with enrollments and teaching roles. Decision 87 settles stored rows plus a reconcile function.

---

## Decision 26 — Any user can DM any user; students can create group chats

**Status:** Accepted

### Decision
Students can message any platform user directly, and students may create group chats.

### Reason / Context
Project owner's choice. The risk (spam, harassment, user discovery) was flagged and accepted.

### Consequences / Constraints
Safeguards are covered by Decisions 30, 31, 76 and 84.

---

## Decision 27 — Re-check completion when an enrollment is reactivated

**Status:** Accepted

### Decision
Course completion is re-checked when an enrollment is reactivated.

### Reason / Context
A lesson may have been archived while the student was away, leaving them at 100% of published lessons without `completed_at`.

### Consequences / Constraints
Also applied to approval and invitation acceptance (see Decision 79).

---

## Decision 28 — Archived course channel is read-only, history kept

**Status:** Accepted

### Decision
When a course is archived, its channel becomes read-only and history stays accessible.

### Reason / Context
No separate channel flag is needed: the course status is checked when sending.

### Consequences / Constraints
Restoring the course makes the channel writable again. Decision 131 keeps message deletion allowed in read-only channels.

---

## Decision 29 — Returning students see the full channel history

**Status:** Accepted

### Decision
A student who leaves and returns sees all messages, including those sent while away.

### Reason / Context
Simpler membership model.

### Consequences / Constraints
Messages sent during absence count as unread on return.

---

## Decision 30 — Blocking and reporting in v1, plus simple Admin moderation

**Status:** Accepted

### Decision
Blocking and reporting are included in v1, with simple Admin moderation.

### Reason / Context
Mitigation for the abuse potential of open DMs (Decision 26).

### Consequences / Constraints
Block behavior is defined in Decisions 76 and 84; report handling in Decisions 77 and 132.

---

## Decision 31 — User search by name only; email never exposed

**Status:** Accepted

### Decision
Users can be searched by name. Email addresses are not publicly searchable or exposed.

### Reason / Context
Privacy.

### Consequences / Constraints
Search returns safe fields only; suspended users are excluded. Search limits are in Decision 128.

---

## Decision 32 — Messages are soft-deleted and kept for moderation

**Status:** Accepted

### Decision
Deleted messages remain in the database but are hidden from normal chat views.

### Reason / Context
Needed as report and moderation evidence.

### Consequences / Constraints
See Decision 86 (bodies kept permanently).

---

## Decision 33 — Notifications are in-app only; no email notifications

**Status:** Accepted (amended by Decision 53)

### Decision
Notifications are in-app only in v1. Relevant events: new messages, enrollment approval/rejection, invitations, new lesson publication, Teacher approval.

### Reason / Context
Avoids a mail provider and background jobs for notifications.

### Consequences / Constraints
Decision 53 allows transactional authentication emails (verification, reset), which are not notifications. Decision 41 keeps chat messages out of notification rows. Event list extended by Decisions 74 and 130.

---

## Decision 34 — Courses are free; no payments

**Status:** Accepted

### Decision
Courses are free in v1. Payments are out of scope.

### Reason / Context
Payments would add an entire domain.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 35 — Catalog v1: categories, tags and search

**Status:** Accepted

### Decision
The catalog includes categories, tags and search. Ratings, reviews and certificates are deferred.

### Reason / Context
Scope control.

### Consequences / Constraints
Search technology is settled in Decision 62. `completed_at` is already suitable for future certificates.

---

## Decision 36 — New users automatically receive the Student role

**Status:** Accepted

### Decision
Every newly registered user receives the `STUDENT` role.

### Reason / Context
Lets a teacher enroll elsewhere.

### Consequences / Constraints
The user and their `STUDENT` role are created in one transaction.

---

## Decision 37 — Assistant permissions

**Status:** Accepted

### Decision
Assistants can approve or reject enrollment requests and view student progress, and edit course content. They cannot remove or ban students, manage course teachers, transfer ownership, or delete/archive the course.

### Reason / Context
Defines "view/manage students" narrowly.

### Consequences / Constraints
Settings remain Owner-only (Decision 118).

---

## Decision 38 — Owner and Assistants can invite students

**Status:** Accepted

### Decision
In invitation-only courses, both Owner and Assistants can invite students.

### Reason / Context
Project owner's choice.

### Consequences / Constraints
Invitations record the inviter.

---

## Decision 39 — Admins can suspend users; access must be lost immediately

**Status:** Accepted (implementation finalized by Decisions 108, 145, 147 and 152)

### Decision
Admins can suspend or ban accounts, and suspended users immediately lose platform access.

### Reason / Context
Moderation requirement.

### Consequences / Constraints
This conflicts with the stateless nature of JWTs, which was flagged as a requirement with a known cost. It is resolved by the per-request user load (108/152), refresh-token revocation (145), `tokens_valid_after` (152) and socket disconnection (147).

---

## Decision 40 — Owner and Admin can remove students; Assistants cannot

**Status:** Accepted

### Decision
Only the Owner and Admin can remove students from a course.

### Reason / Context
Consistent with Decision 37.

### Consequences / Constraints
Admin removal goes through Admin endpoints (Decision 110).

---

## Decision 41 — Chat unread uses read positions, not notification rows

**Status:** Accepted

### Decision
Chat messages are tracked by unread counts from read positions, not by notification rows.

### Reason / Context
One notification row per message would flood the table.

### Consequences / Constraints
The notification table is reserved for discrete events.

---

## Decision 42 — Edited messages store only `edited_at`

**Status:** Accepted

### Decision
In v1 an edit overwrites the body and stores `edited_at`. No edit history.

### Reason / Context
Keeps v1 simple.

### Consequences / Constraints
Report evidence is preserved by a snapshot taken at report time (Decision 77).

---

## Decision 43 — Invitations expire after 7 days and can be revoked by the inviter

**Status:** Accepted

### Decision
Invitations expire after 7 days. The inviter can revoke them.

### Reason / Context
Prevents stale invitations.

### Consequences / Constraints
Expiry is derived from `expires_at`, not stored as a status. Revocation was extended to the Owner in Decision 125.

---

## Decision 44 — One Admin-managed category per course, plus free-form tags

**Status:** Accepted

### Decision
Each course has one Admin-managed category and free-form tags.

### Reason / Context
Controlled list for categories, flexible labels for tags.

### Consequences / Constraints
Tag hygiene via normalization, caps and Admin merge (see Decisions 62 and 133).

---

## Decision 45 — A suspended Owner follows the same transfer-first rule

**Status:** Accepted

### Decision
A suspended Owner is handled with the same transfer-first rule as a revoked teacher. An Admin can transfer first.

### Reason / Context
Consistency with Decision 10.

### Consequences / Constraints
Applies to every owned course regardless of status (Decision 133).

---

## Decision 46 — Twelve domains approved

**Status:** Accepted

### Decision
The domains are: Auth, Users, Courses, Catalog, Content, Files, Enrollments, Progress, Chat, Notifications, Moderation, Admin.

### Reason / Context
Boundaries based on things that change for the same reasons. Roles/Permissions folded into Users; Catalog, Files, Moderation and Admin added.

### Consequences / Constraints
Infrastructure concerns are not counted as domains (Decision 98).

---

## Decision 47 — Admin is a thin orchestration module

**Status:** Accepted

### Decision
Admin owns almost no tables and calls other modules. It contains no business rules belonging to other modules.

### Reason / Context
Keeps privileged workflows in one place without making Admin a dumping ground.

### Consequences / Constraints
`AuditLog` belongs to the audit infrastructure, not Admin (see Decision 98 and the Phase 5 clarification).

---

## Decision 48 — Content is a separate module from Courses

**Status:** Accepted

### Decision
Content (sections, lessons, blocks) is separate from Courses.

### Reason / Context
Lesson editing should not bloat the course module.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 49 — Hybrid consistency: direct calls in transactions, events for side effects

**Status:** Accepted

### Decision
Consistency-critical effects use direct service calls inside a transaction. Harmless side effects such as notifications use events.

### Reason / Context
Events run outside the transaction by default and could leave data out of sync.

### Consequences / Constraints
Events are emitted after commit (Decision 100).

---

## Decision 50 — Audit logging is a requirement; dashboards are read-only queries

**Status:** Accepted

### Decision
Audit logging is required, especially for admin actions such as ownership transfers. Dashboards are read-only queries, not domains.

### Reason / Context
History belongs in an audit log, not in extra tables.

### Consequences / Constraints
Exact design settled in Decision 78.

---

## Decision 51 — Platform role is an enum on `UserRole`; no `Role` table

**Status:** Accepted (amends Decision 4)

### Decision
The platform role is an enum column (`STUDENT`, `TEACHER`, `ADMIN`) on `UserRole`. There is no `Role` table.

### Reason / Context
Roles carry no data of their own because fine-grained permissions were ruled out (Decision 6).

### Consequences / Constraints
The many-to-many relationship remains through `UserRole`. Registration can never choose a role.

---

## Decision 52 — Single `full_name` field

**Status:** Accepted

### Decision
Users have a single `full_name` field.

### Reason / Context
Simple, and one search field.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 53 — Email verification and password reset are included in v1

**Status:** Accepted (amends Decision 33)

### Decision
Email verification and password reset are included. Transactional authentication emails are allowed; notification emails are not.

### Reason / Context
These are security flows, not notifications.

### Consequences / Constraints
A mail provider is required for these flows only.

---

## Decision 54 — Teacher application carries a short message

**Status:** Accepted (storage finalized by Decision 60)

### Decision
Teacher application is simple, with a short message/bio for the Admin. A rejected applicant can re-apply.

### Reason / Context
Keep it minimal in v1.

### Consequences / Constraints
Storage left open until Decision 60.

---

## Decision 55 — No account deletion in v1; suspension only

**Status:** Accepted

### Decision
Users cannot delete their accounts. Suspension is the only removal mechanism.

### Reason / Context
Users own messages, progress, enrollments and reports; hard deletion would orphan or destroy them.

### Consequences / Constraints
Future anonymization is on the future-improvements list.

---

## Decision 56 — Multiple simultaneous sessions

**Status:** Accepted

### Decision
A user may stay logged in on several devices. User 1:N RefreshToken.

### Reason / Context
Project owner's choice.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 57 — Google OAuth login linked to the existing User identity

**Status:** Accepted

### Decision
Users can register/login with Google, and the Google account links to the existing `User` identity rather than creating a separate one.

### Reason / Context
Requested by the project owner.

### Consequences / Constraints
Stored in a separate `AuthIdentity` table. Linking rules in Decision 59.

---

## Decision 58 — Password users must verify email before login

**Status:** Accepted

### Decision
Password users must verify their email before logging in. Google users count as verified.

### Reason / Context
Makes Google linking safe and prevents unverified accounts.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 59 — Four Google sign-in rules

**Status:** Accepted

### Decision
(1) A matching `AuthIdentity` logs in (suspended users rejected). (2) Otherwise, if Google says the email is verified and a user with that email exists, link; if that user's email was unverified, clear their password hash, mark verified and revoke sessions. (3) Otherwise create a new user with `STUDENT` role. (4) If Google reports the email unverified, reject.

### Reason / Context
Prevents account pre-hijacking.

### Consequences / Constraints
Matching is on Google's `sub`, never email. No Google tokens are stored.

---

## Decision 60 — Teacher application stored on `UserRole`

**Status:** Accepted (finalizes Decision 54; extended by Decision 128)

### Decision
Teacher application data lives on `UserRole`. Applying is a separate action after registration. Rejected applicants can re-apply.

### Reason / Context
History is the audit log's job; a second table would create two places holding Teacher status.

### Consequences / Constraints
Re-applying overwrites the message; the old one is kept in the audit record.

---

## Decision 61 — Ownership stored in `CourseTeacher` with role OWNER

**Status:** Accepted

### Decision
Ownership lives in `CourseTeacher`. "Exactly one" is enforced by a partial unique index (at most one) plus transaction-safe service logic (never zero).

### Reason / Context
Authorization runs on every request, so one uniform lookup is cleaner.

### Consequences / Constraints
Ownership transfer demotes the old Owner first, then promotes the new one. Needs a raw SQL migration.

---

## Decision 62 — Search configuration

**Status:** Accepted

### Decision
Course full-text search uses the PostgreSQL `simple` configuration; user-name search uses `pg_trgm`.

### Reason / Context
Courses may be Armenian, English, Russian or mixed. The `simple` configuration works for any language but does not stem.

### Consequences / Constraints
No external search service.

---

## Decision 63 — Public catalog visibility

**Status:** Accepted

### Decision
Logged-out visitors can browse published courses. `OPEN` and `APPROVAL_REQUIRED` courses are public; `INVITATION_ONLY` courses are hidden from the catalog.

### Reason / Context
Discoverability while keeping invitation-only courses private.

### Consequences / Constraints
"Hidden from the catalog" is not "forbidden": invitees, students, teachers and Admins can still open it; everyone else gets 404, not 403.

---

## Decision 64 — S3-compatible object storage behind a Files interface

**Status:** Accepted

### Decision
File bytes use S3-compatible storage behind a small interface in the Files module. MinIO is used in development.

### Reason / Context
Survives redeploys, supports signed URLs.

### Consequences / Constraints
Upload flow settled in Decision 116.

---

## Decision 65 — Database conventions

**Status:** Accepted

### Decision
UUID v7 keys, `timestamptz`, PostgreSQL enums for fixed value sets, status columns for lifecycle state, and `deleted_at` only where history requires it.

### Reason / Context
Non-guessable keys that remain index-friendly; avoids time-zone bugs.

### Consequences / Constraints
The UUID v7 generation mechanism is confirmed in Spike A.

---

## Decision 66 — Text blocks store Markdown

**Status:** Accepted

### Decision
Text blocks store Markdown. The frontend renders it safely, and the server limits its length.

### Reason / Context
Simple and easy to sanitize; teacher-authored content is untrusted.

### Consequences / Constraints
A rich-text editor is deferred.

---

## Decision 67 — Ordering strategy

**Status:** Accepted

### Decision
Reordering sends the full ordered list of IDs, rewritten in a transaction. The submitted list is validated (409 on a stale list), the parent row is locked, and there is no unique constraint on `(parent, position)`.

### Reason / Context
Sibling lists are small, and this approach is easiest to reason about and test.

### Consequences / Constraints
Reads order by `position, id`.

---

## Decision 68 — `ContentBlock` is one table with type-specific columns

**Status:** Accepted

### Decision
One table with nullable type-specific columns and CHECK constraints. Videos store provider plus external id, not the raw URL.

### Reason / Context
Real FK for files; avoids JSON integrity problems and per-type tables.

### Consequences / Constraints
Embed URLs are built server-side.

---

## Decision 69 — Lesson structure and deletion

**Status:** Accepted (changes the implementation of Decision 9, not its intent)

### Decision
`Lesson` has `course_id` with a composite FK to `Section`, every lesson belongs to a section, and there is no `deleted_at` (ARCHIVED is the soft state). A lesson can be permanently deleted only if no student ever completed it.

### Reason / Context
Prevents cross-course errors in the database and avoids two hidden-state mechanisms.

### Consequences / Constraints
`LessonCompletion → Lesson` is `RESTRICT`.

---

## Decision 70 — Re-entry rules

**Status:** Accepted

### Decision
`LEFT` students return under the course's current policy with progress restored. `REMOVED` students return only through Owner/Admin reinstatement or a new invitation. `REJECTED` students can request again.

### Reason / Context
Removal must mean something on open courses.

### Consequences / Constraints
Added transitions are in Decision 123.

---

## Decision 71 — Invitations: existing users only, one reusable row

**Status:** Accepted

### Decision
Invitations are for existing users only, with one reusable row per `(course, user)`.

### Reason / Context
Email invitations would need a new email flow; reuse avoids expiry edge cases.

### Consequences / Constraints
Accepting is a conditional update, so accept and revoke cannot both win.

---

## Decision 72 — A user cannot be both a course teacher and an active student

**Status:** Accepted

### Decision
A user cannot be a course teacher (Owner/Assistant) and an `ACTIVE`/`PENDING` student in the same course.

### Reason / Context
Avoids double channel-membership sources and inflated numbers.

### Consequences / Constraints
Spans two tables, so it is a service rule protected by the course-row lock (Decision 160).

---

## Decision 73 — Syllabus visible to visitors and non-enrolled users

**Status:** Accepted

### Decision
Visitors and non-enrolled users can see section and lesson titles, but not lesson content.

### Reason / Context
Helps people decide to enroll.

### Consequences / Constraints
Only `PUBLISHED` lessons and sections containing at least one are shown. `INVITATION_ONLY` follows the course visibility rule.

---

## Decision 74 — Notification events added

**Status:** Accepted (extended by Decision 130)

### Decision
Add `ENROLLMENT_REQUESTED`, `REMOVED_FROM_COURSE`, `OWNERSHIP_TRANSFERRED` and `TEACHER_APPLICATION_RECEIVED`.

### Reason / Context
Teachers and Admins would otherwise never learn of waiting requests.

### Consequences / Constraints
Fan-outs use bulk insert.

---

## Decision 75 — Notification structure and retention

**Status:** Accepted

### Decision
A notification is a type plus optional `course_id`/`actor_id` plus a JSON display snapshot. Read notifications are deleted after about 90 days.

### Reason / Context
A notification is a display record, not an integrity record.

### Consequences / Constraints
Created after commit; losing one is acceptable.

---

## Decision 76 — Block behavior

**Status:** Accepted (completed by Decision 84)

### Decision
Blocks apply to chat/DM only. Blocked users cannot send new DMs to each other. Old history remains. Shared course channels, enrollment, invitations and teaching are unaffected. Blocks do not apply to Admins.

### Reason / Context
A block cannot remove someone from a course.

### Consequences / Constraints
The "cannot add you to groups" line was resolved in Decision 84.

---

## Decision 77 — Report privacy

**Status:** Accepted

### Decision
Admins see the reported message, its snapshot and about 10 messages before and after, never the whole conversation.

### Reason / Context
Limits exposure of private conversations.

### Consequences / Constraints
Viewing the context is audited (`REPORT_CONTEXT_VIEWED`). The report stores a text snapshot at report time.

---

## Decision 78 — AuditLog design

**Status:** Accepted

### Decision
Immutable, protected by a trigger rejecting UPDATE/DELETE, written in the same transaction as the action, `action` stored as text validated against code constants, and only privileged and relationship-changing actions audited.

### Reason / Context
An audit row for a rolled-back action would be a lie; enums would need a migration per action.

### Consequences / Constraints
Target reference is intentionally loose (no FK).

---

## Decision 79 — LessonCompletion design

**Status:** Accepted

### Decision
Composite PK `(enrollment_id, lesson_id)`, same-course composite FKs, insert-only records, and percentage computed on read.

### Reason / Context
The database then guarantees a completion cannot cross courses.

### Consequences / Constraints
Completion runs as a conditional update on `Enrollment.completed_at`, triggered by student marking, teacher unpublish/archive, and enrollment activation (approve, accept, reinstate, return).

---

## Decision 80 — Direct conversations use a `DirectConversation` table

**Status:** Accepted

### Decision
A separate `DirectConversation` table holds an ordered user pair (`user_a_id < user_b_id`) with a unique constraint.

### Reason / Context
Real FKs and database-enforced uniqueness.

### Consequences / Constraints
A first-DM race is resolved by catching the unique violation outside the transaction and reloading.

---

## Decision 81 — Message ordering by per-conversation `seq`; `client_id` idempotency

**Status:** Accepted

### Decision
Messages are ordered by `seq` taken from `Conversation.last_seq`. `client_id` with `UNIQUE (sender_id, client_id)` is the idempotency key.

### Reason / Context
Strict order with no gaps or ties and a perfect read position and cursor.

### Consequences / Constraints
Sends in a conversation serialize on a short row lock. Decision 131 adds a check that a reused `clientId` belongs to the same conversation.

---

## Decision 82 — Unread counts computed on read

**Status:** Accepted

### Decision
Unread counts are calculated from `seq` and `last_read_seq`, with no stored counter.

### Reason / Context
Accurate; excludes deleted messages.

### Consequences / Constraints
A stored difference remains a possible future optimization.

---

## Decision 83 — Group rules

**Status:** Accepted

### Decision
The creator becomes `ADMIN`. Group admins add/remove members and rename. Any member can leave. Maximum 50 members. If the last admin leaves, the oldest remaining member is promoted.

### Reason / Context
Project owner's choice.

### Consequences / Constraints
Cap and add-member race are serialized by the Conversation row lock.

---

## Decision 84 — Blocked users cannot add the blocker to new groups

**Status:** Accepted (completes Decision 76)

### Decision
A user cannot add someone who has blocked them to a new group. Existing shared groups are unaffected.

### Reason / Context
Otherwise blocking could be bypassed by creating a group.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 85 — Message scope for v1

**Status:** Accepted

### Decision
Plain text only: no attachments, replies, reactions, mentions or Markdown. Senders edit/delete their own messages at any time. Course Owners and Assistants can delete messages in their course channel. Admins can delete reported messages.

### Reason / Context
Keep chat scope manageable.

### Consequences / Constraints
Moderator deletions are audited. A deleted message cannot be edited.

---

## Decision 86 — Deleted message bodies kept permanently

**Status:** Accepted

### Decision
Deleted message bodies are retained; the API hides them.

### Reason / Context
Moderation and report evidence.

### Consequences / Constraints
Privacy cost accepted: deleted text stays in the database and backups.

---

## Decision 87 — Stored `ConversationMember` rows with reconcile function

**Status:** Accepted

### Decision
Course-channel membership is stored in `ConversationMember` rows synchronized in the same transaction as enrollment and teacher-role changes, plus a reconcile function as a safety net.

### Reason / Context
One chat model for all conversation types and a natural home for read positions.

### Consequences / Constraints
Sync drift is the main risk; mitigated by the reconcile function (see Decision 162).

---

## Decision 88 — Course permanent deletion only if never published

**Status:** Accepted (tightens Decision 15)

### Decision
A course can be permanently deleted only if `first_published_at IS NULL`. After publication it can only be archived.

### Reason / Context
A published course may have a channel with messages and reports.

### Consequences / Constraints
Decision 15 stays as a second safety net.

---

## Decision 89 — The 25 entities are final for v1

**Status:** Accepted (columns added later by Decisions 134, 145 and 152)

### Decision
The 25 entities are sufficient for v1. Profile bio, notification preferences and bookmarks are deferred.

### Reason / Context
Scope control.

### Consequences / Constraints
Later decisions added columns, not entities: `Course.locked_by_admin_at`, `User.tokens_valid_after`, `RefreshToken.used_at`/`family_started_at`, plus `User.email_verified_at` and `UserRole.application_message`/`decision_note` (from Phase 3).

---

## Decision 90 — Phase 3 (conceptual database design) approved

**Status:** Accepted

### Decision
The consolidated Phase 3 design is approved.

### Reason / Context
Allows progress to relationship review.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 91 — Delete-behavior principle

**Status:** Accepted (amended during approval: `Invitation.course_id → Course` is `RESTRICT`)

### Decision
`RESTRICT` by default, `CASCADE` for owned or disposable data, `SET NULL` only for convenience pointers. Paired "who and when" columns are always `RESTRICT`.

### Reason / Context
A CHECK on paired columns cannot coexist with `SET NULL`; RESTRICT is a stronger backstop against bugs.

### Consequences / Constraints
The course-deletion transaction does not delete invitations; an existing one makes PostgreSQL refuse the delete, surfaced as a loud 409.

---

## Decision 92 — Deleting a never-published course is one transaction

**Status:** Accepted

### Decision
One transaction deletes lessons, then sections, then the course. Blocks go through their `CASCADE`.

### Reason / Context
Avoids relying on cascade ordering.

### Consequences / Constraints
Foreign-key violations (invitation, channel, enrollment) indicate a bug.

---

## Decision 93 — Message sender must have been a conversation member

**Status:** Accepted

### Decision
Composite FK `Message(conversation_id, sender_id) → ConversationMember(conversation_id, user_id)`. Current membership (`left_at`) remains a service rule.

### Reason / Context
Prevents messages from users who were never members.

### Consequences / Constraints
`ConversationMember` rows are permanent.

---

## Decision 94 — `Conversation.course_id → Course` is RESTRICT

**Status:** Accepted

### Decision
A course with a channel can never be deleted.

### Reason / Context
Database backstop for Decision 88.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 95 — Phase 4 approved

**Status:** Accepted

### Decision
The relationship and integrity review is approved.

### Reason / Context
Allows progress to NestJS architecture.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 96 — Reads cross modules; writes go through the owner

**Status:** Accepted

### Decision
Reads may cross module boundaries through Prisma. Writes go only through the owning module's exported service. The single exception is Progress writing `Enrollment.completed_at`.

### Reason / Context
Reading creates no import or cycle; calling write logic is the dangerous part.

### Consequences / Constraints
Decision 113 and Phase 5 corrections confirm that "last visited lesson" is written by Enrollments, not Progress.

---

## Decision 97 — Progress is a leaf module

**Status:** Accepted

### Decision
Progress imports no domain module. Enrollments and Content call `CompletionService` inside their own transaction.

### Reason / Context
Removes Enrollments ↔ Progress and Content ↔ Progress cycles while keeping the check in the caller's transaction.

### Consequences / Constraints
Progress reads `Enrollment` and `Lesson` tables directly.

---

## Decision 98 — Downward-only module layering

**Status:** Accepted

### Decision
Dependencies point downward only, with no `forwardRef`. Database, Config, Audit, Mail and Event contracts are infrastructure, outside the 12 domains.

### Reason / Context
Avoids circular imports.

### Consequences / Constraints
Enforced by dependency-cruiser (Decision 104).

---

## Decision 99 — Services use Prisma directly

**Status:** Accepted

### Decision
No repository layer. Complex or raw queries live in `*.queries.ts`.

### Reason / Context
Repositories would be unnecessary abstraction; tests run against real PostgreSQL.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 100 — Explicit `tx` parameter; events after commit

**Status:** Accepted

### Decision
The entry service owns the transaction and passes `tx` explicitly to cross-module methods. Events are emitted only after commit.

### Reason / Context
Visible rather than hidden transaction behavior; listeners before commit would see old data.

### Consequences / Constraints
The audit writer takes `tx` (with Decision 78).

---

## Decision 101 — Multi-file Prisma schema

**Status:** Accepted

### Decision
One `.prisma` file per domain.

### Reason / Context
Mirrors the modules.

### Consequences / Constraints
Exact setup is verified in Spike A.

---

## Decision 102 — Migration and testing workflow

**Status:** Accepted

### Decision
`--create-only` migrations with hand-written SQL, an early spike verifying how Prisma treats manual indexes, and a real-PostgreSQL integration test suite.

### Reason / Context
Prisma cannot express CHECKs, partial indexes, triggers or generated columns.

### Consequences / Constraints
Every hand-written object gets a test that tries to break it.

---

## Decision 103 — "Visible to students" conditions defined once

**Status:** Accepted

### Decision
Shared query conditions for student-visible lessons are defined in Content and reused everywhere.

### Reason / Context
Prevents draft/archived lessons leaking through ad-hoc queries.

### Consequences / Constraints
A review-checklist item.

---

## Decision 104 — Automated dependency checking

**Status:** Accepted

### Decision
dependency-cruiser (or equivalent) enforces layering and bans cycles.

### Reason / Context
Boundaries are easy to violate by accident.

### Consequences / Constraints
To be set up before the second module exists.

---

## Decision 105 — Request DTOs and allowlist response DTOs

**Status:** Accepted

### Decision
Request DTOs per endpoint, explicit allowlist response DTOs with mapper functions, and no Prisma models in responses.

### Reason / Context
A new sensitive column must never leak by default.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 106 — Validation approach

**Status:** Accepted

### Decision
`class-validator` + `class-transformer`, a global `ValidationPipe` with whitelist, `forbidNonWhitelisted` and transform, shared limit constants, normalization in DTOs, and a global exception filter mapping database errors.

### Reason / Context
Defends against mass assignment; official NestJS default.

### Consequences / Constraints
Every DTO field needs a validator decorator. Pipe applicability to gateways is verified during implementation.

---

## Decision 107 — Secure-by-default authentication guard and throttling

**Status:** Accepted

### Decision
A global JWT guard with `@Public()` and an optional-auth variant, plus a global throttler with stricter limits on authentication endpoints.

### Reason / Context
Forgetting a decorator then fails closed.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 108 — Access token carries only the user id

**Status:** Accepted (directionally; finalized by Decision 152)

### Decision
The access token carries only the user id. The guard loads current status and active platform roles from the database on every request.

### Reason / Context
Makes suspension, revocation and pending-teacher enforcement immediate.

### Consequences / Constraints
Costs one indexed query per request. A cache is a future improvement.

---

## Decision 109 — Three authorization levels

**Status:** Accepted

### Decision
`@Roles()`, a course-access lookup with `@CourseRole()`, and service-layer state rules. Course routes nest under `/courses/:courseId`. Hidden courses return 404. No policy library.

### Reason / Context
Fine-grained permissions were ruled out.

### Consequences / Constraints
Exact routes finalized in Phase 6.

---

## Decision 110 — Admins act only through Admin endpoints

**Status:** Accepted

### Decision
Admins use dedicated Admin-module endpoints rather than implicit bypasses.

### Reason / Context
Privileged actions are explicit and auditable.

### Consequences / Constraints
Admins are ordinary users in normal endpoints.

---

## Decision 111 — Socket.IO real-time structure

**Status:** Accepted

### Decision
Socket.IO, one connection per client, a Realtime infrastructure module, thin gateways, handshake authentication, emit-after-commit.

### Reason / Context
Needs reconnection, acknowledgements and rooms.

### Consequences / Constraints
Delivery strategy was settled in Decision 155.

---

## Decision 112 — Infrastructure batch

**Status:** Accepted

### Decision
Swagger/OpenAPI, validated configuration, Helmet, restricted CORS, rate limiting, health endpoint, structured logging with request IDs, and an `/api/v1` prefix without a versioning system.

### Reason / Context
Standard choices.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 113 — Module table, corrections and layers; separate rule sets

**Status:** Accepted

### Decision
The module table, three corrections (Moderation does not import Users; last-visited is written by Enrollments; report resolution is orchestrated by Admin) and Layer 0–3 structure are final. Two separate rule sets: domain → domain (downward, through `index.ts`, no cycles) and domain → infrastructure/common (explicit per-module list). Infrastructure and `common` never import a domain module.

### Reason / Context
Infrastructure dependencies are not domain layering violations.

### Consequences / Constraints
"Imports: none" means no domain imports.

---

## Decision 114 — Public module API through `index.ts`

**Status:** Accepted

### Decision
Other modules import only a module's `index.ts`, which exports only the intentional API.

### Reason / Context
Makes the exported API a real boundary.

### Consequences / Constraints
Enforced by dependency-cruiser.

---

## Decision 115 — Folder layout

**Status:** Accepted

### Decision
Per-module folders: `controllers/`, `services/`, `dto/`, `mappers/`, `queries/`, optional event contracts and `index.ts`.

### Reason / Context
Flat and boring.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 116 — Files uploaded through the API server

**Status:** Accepted

### Decision
Files are uploaded through the API server, which validates size and real file type and writes through `StorageDriver`. Presigned direct upload is deferred.

### Reason / Context
Simpler for one developer; verifies real type; keeps S3 credentials server-side.

### Consequences / Constraints
The API carries file bytes.

---

## Decision 117 — API conventions

**Status:** Accepted

### Decision
Action endpoints for state changes, offset pagination for catalog/admin lists, cursor pagination for messages and notifications, stable error codes, `/me` routes, and the status-code rules.

### Reason / Context
Transitions have different permissions and side effects.

### Consequences / Constraints
Refined by Decision 140.

---

## Decision 118 — Course settings are Owner-only

**Status:** Accepted

### Decision
Course settings, enrollment policy and tags are Owner-only. Assistants cannot archive or delete.

### Reason / Context
Consistent with Decision 37.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 119 — Course visibility

**Status:** Accepted (amended during approval)

### Decision
`DRAFT` visible to teachers only. `ARCHIVED` visible to teachers and to students with `ACTIVE` or `LEFT` enrollment. A `REMOVED` student keeps no access merely because they were enrolled before. `REJECTED`, never-enrolled and unauthorized users get 404. `INVITATION_ONLY` stays hidden from users with no valid relationship.

### Reason / Context
Removal should take access away.

### Consequences / Constraints
`CourseAccessService` returns the enrollment status itself.

---

## Decision 120 — Course and CourseTeacher endpoints

**Status:** Accepted

### Decision
Endpoints as listed in Phase 6, with no "unpublish to draft" endpoint.

### Reason / Context
Consistent with Decision 11.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 121 — 404 vs 403 and the visibility/content access tables

**Status:** Accepted

### Decision
404 when the caller may not know the course exists, 403 when they can see it but lack the role. A `LEFT` student still sees an `INVITATION_ONLY` page. A `PENDING` student sees a published course, and archiving leaves their request untouched (approval returns 409 while archived). `LEFT` students see page, syllabus and progress history but no lesson content. `ACTIVE` students keep published-lesson access and may keep marking lessons complete on archived courses.

### Reason / Context
Follows decision 11 ("existing student data and progress remain").

### Consequences / Constraints
Non-published lessons are always 404 for students.

---

## Decision 122 — Content endpoints and lesson lifecycle

**Status:** Accepted

### Decision
Lesson transitions: `DRAFT → PUBLISHED`, `PUBLISHED → DRAFT`, `PUBLISHED → ARCHIVED`, `ARCHIVED → PUBLISHED`; no `ARCHIVED → DRAFT`. A lesson needs at least one block to publish. Deletion requires a non-published, never-completed lesson. Content mutations on an archived course return 409 `COURSE_ARCHIVED`.

### Reason / Context
Keeps all completion-affecting changes on two endpoints.

### Consequences / Constraints
Publishing never needs a completion recheck.

---

## Decision 123 — Enrollment endpoints and added transitions

**Status:** Accepted

### Decision
Student enrollment endpoints plus transitions: `LEFT → ACTIVE` or `PENDING` per policy, `REJECTED → PENDING` or `ACTIVE`, `PENDING → LEFT`, `REMOVED → ACTIVE`. `LEFT` and `REJECTED` returns follow the current policy; `INVITATION_ONLY` requires a new invitation. `REMOVED → ACTIVE` is an explicit Owner/Admin reinstatement restoring `ACTIVE` directly.

### Reason / Context
The earlier state machine was incomplete.

### Consequences / Constraints
Allowed transitions live in one service function.

---

## Decision 124 — Teacher student-management endpoints

**Status:** Accepted

### Decision
Approve and reject by Owner and Assistant. Remove and reinstate by Owner (and Admin through Admin endpoints). No email in student lists.

### Reason / Context
Consistent with Decisions 37, 40 and 31.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 125 — Invitation endpoints

**Status:** Accepted (clarified)

### Decision
A valid `PENDING` invitation returns 409 `INVITATION_PENDING` and is never silently reset. Expired, revoked or declined invitations reuse the same row, reset to `PENDING` with a new 7-day expiry. Revocation by the inviter or the Owner.

### Reason / Context
Avoids invitee spam and a dead end when an inviting Assistant is removed.

### Consequences / Constraints
An `ACCEPTED` row is also reusable once the student has left or been removed.

---

## Decision 126 — Progress endpoints

**Status:** Accepted

### Decision
Idempotent `PUT` completion, no un-complete, explicit `PUT` for last-visited, and an enrollment summary keeping `completedAt` and `percent` separate.

### Reason / Context
A read endpoint must not write data.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 127 — Files endpoints

**Status:** Accepted

### Decision
Server upload by `kind`, delete-if-unattached, attachments served only through access-checked signed URLs.

### Reason / Context
Attachments are private.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 128 — `/me`, teacher application and user search endpoints

**Status:** Accepted (extends Decision 60)

### Decision
Endpoints as proposed. User search: login required, minimum 2 characters, at most 20 results, no pagination, safe fields only. A `REVOKED` teacher may re-apply (`REVOKED → PENDING`) like a `REJECTED` one. The overwritten application message is kept in the audit record.

### Reason / Context
User search is the largest privacy surface.

### Consequences / Constraints
Slow scraping by logged-in users is an accepted risk. Re-applying sets the decided pair to NULL.

---

## Decision 129 — Block endpoints and Admins in chat

**Status:** Accepted

### Decision
Block endpoints with no "who blocked me" endpoint. Admins are normal chat users who may hold DMs and groups; they are never added to conversations automatically or by moderation. Blocking an Admin returns 409 `CANNOT_BLOCK_ADMIN`.

### Reason / Context
Reconciles Decision 76 (blocks do not apply to Admins) with Admins being able to use chat.

### Consequences / Constraints
No schema change.

---

## Decision 130 — Notification endpoints and teacher lifecycle notifications

**Status:** Accepted (extends Decision 74)

### Decision
Cursor list, unread count, idempotent read, no delete, no creation endpoint. Teacher lifecycle notifications: `TEACHER_APPLICATION_RECEIVED`, `TEACHER_APPLICATION_APPROVED`, `TEACHER_APPLICATION_REJECTED`, `TEACHER_ROLE_REVOKED`.

### Reason / Context
Applicants should learn the outcome.

### Consequences / Constraints
`TEACHER_APPROVED` (Decisions 33/75) becomes `TEACHER_APPLICATION_APPROVED` as a notification type. The audit constant `TEACHER_APPROVED` keeps its name.

---

## Decision 131 — Chat REST endpoints and rules

**Status:** Accepted

### Decision
404 for non-members, get-or-create DMs hidden until the first message, groups without invitee consent, neutral `MEMBERS_UNAVAILABLE`, promote/demote, row reuse on return. Archived channels block send and edit but allow delete. `CLIENT_ID_REUSED` check. REST and WebSocket share the same services.

### Reason / Context
A reused `clientId` could otherwise return a message from another conversation; deletion must stay possible to remove abuse.

### Consequences / Constraints
Which operations also use the socket was settled in Decision 154.

---

## Decision 132 — Report endpoints and resolution

**Status:** Accepted

### Decision
Snapshot at report time, a separately audited context endpoint, sibling `OPEN` reports closed together when a message is deleted through resolution. Admins delete others' messages only through report resolution.

### Reason / Context
Evidence preservation and audited access to private context.

### Consequences / Constraints
No reporter-facing list in v1.

---

## Decision 133 — Admin endpoints

**Status:** Accepted (the `archive` endpoint was renamed by Decision 141)

### Decision
Admin endpoints as proposed. Suspension removes Assistant rows (not restored on unsuspend) and leaves student data alone. The transfer-first rule covers every owned course regardless of status. `LAST_ADMIN` protection, no self-suspension, an Admin-role grant/revoke endpoint. Admin lists may show email. Audit-log viewer and read-only stats are included.

### Reason / Context
Orchestration only, per Decision 47.

### Consequences / Constraints
`LAST_ADMIN` was split in Decision 135.

---

## Decision 134 — Admin takedown lock

**Status:** Accepted (amends Decision 89 by adding a column, not an entity)

### Decision
`Course.locked_by_admin_at` (nullable `timestamptz`). Admin takedown sets `status = ARCHIVED` and the timestamp. Owner/Assistant restore returns 409 `COURSE_ADMIN_LOCKED`. Only an Admin restore clears the lock and sets `PUBLISHED`. The locking Admin is recorded in `AuditLog` only.

### Reason / Context
Without a lock, an Owner could restore a course an Admin took down.

### Consequences / Constraints
CHECK: `locked_by_admin_at IS NULL OR status = 'ARCHIVED'`. Draft courses cannot be locked.

---

## Decision 135 — Four consistency fixes

**Status:** Accepted

### Decision
(1) `POST /courses/:courseId/assistants/me/leave`; (2) `LAST_GROUP_ADMIN` vs `LAST_PLATFORM_ADMIN`; (3) audit course lifecycle transitions; (4) team operations (assistants, ownership transfer) allowed in any course status.

### Reason / Context
A route collision with `me`, an ambiguous code, an unfulfillable "status history" promise, and a possible revocation deadlock on archived courses.

### Consequences / Constraints
Settings and content mutations still return `COURSE_ARCHIVED`.

---

## Decision 136 — Locked-course visibility

**Status:** Accepted

### Decision
Anonymous, never-enrolled, rejected, invitee and removed users get 404. `ACTIVE`, `LEFT` and `PENDING` students get 403 `COURSE_ADMIN_LOCKED`. Owner and Assistants keep management visibility. Admins use `/admin`. Enrollment state and progress are untouched, and the channel stays read-only.

### Reason / Context
A takedown that leaves content readable is not a takedown.

### Consequences / Constraints
Students remain members of the read-only channel. `GET /me/invitations` excludes archived and locked courses.

---

## Decision 137 — Single sources of truth in code; matrix correction

**Status:** Accepted

### Decision
The permission matrix, notification catalog, audit actions, error codes and rate-limit classes are single sources of truth in code. Correction: an `ACTIVE` Admin without an `ACTIVE` Teacher role may apply for Teacher; one who already has it gets 409 `ALREADY_TEACHER`.

### Reason / Context
Prevents drift between code, tests and docs.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 138 — Read-only Admin content review

**Status:** Accepted

### Decision
`GET /admin/courses/:courseId/outline` and `GET /admin/courses/:courseId/lessons/:lessonId`. They work on locked courses and write no audit rows.

### Reason / Context
An Admin needs to see what they are locking. Course content is not private like DMs.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 139 — Locking an already-archived course; lock notification

**Status:** Accepted

### Decision
An Admin may lock an already-`ARCHIVED` course (it stays `ARCHIVED` and gets `locked_by_admin_at`). New notification `COURSE_ADMIN_LOCKED` goes to the Owner and Assistants with the reason in `data`, emitted after commit.

### Reason / Context
Otherwise an Owner could dodge a takedown by archiving first.

### Consequences / Constraints
The notification catalog has 12 types. Locking uses a conditional update.

---

## Decision 140 — Status-code test, check order and error-code registry

**Status:** Accepted

### Decision
400 request wrong regardless of data; 403 caller not entitled; 404 hidden or not part of the URL's course; 409 caller entitled but data conflicts; 413/415 for uploads. Check order: `429 → 401 → 403 ACCOUNT_SUSPENDED → guards → 400 → service 409`. `INVITATION_REQUIRED` 403, `FILE_TOO_LARGE` 413, `FILE_TYPE_NOT_ALLOWED` 415. New codes `INVALID_STATE_TRANSITION`, `COURSE_ALREADY_LOCKED`, `COURSE_NOT_LOCKED`. Cross-course ids are 404. `COURSE_ADMIN_LOCKED` takes precedence over `COURSE_ARCHIVED` for teacher mutations.

### Reason / Context
Replaces "unmarked means 409".

### Consequences / Constraints
`COURSE_ADMIN_LOCKED` is 403 when a student is shut out and 409 when a teacher mutation is refused.

---

## Decision 141 — Admin `lock`, `unlock` and `restore`

**Status:** Accepted (renames the Admin `archive` endpoint from Decision 133)

### Decision
`lock` covers published and already-archived courses; `unlock` clears the lock and leaves the course `ARCHIVED`; `restore` clears the lock and sets `PUBLISHED`. Unlock and restore return 409 `COURSE_NOT_LOCKED` on an unlocked course. Audit adds `COURSE_ADMIN_UNLOCKED`.

### Reason / Context
Lifting a lock on an Owner-archived course must not publish it.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 142 — Exemptions from lock and archive rules

**Status:** Accepted

### Decision
Students may always leave or cancel a pending request, even on an archived or locked course. Owners and Admins may remove students in any course status. Approval, reinstatement and enrollment stay blocked on archived or locked courses.

### Reason / Context
Leaving is the student's right; removal takes access away rather than adding any.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 143 — Token storage and deployment

**Status:** Accepted

### Decision
Refresh token in an `HttpOnly`, `Secure`, `SameSite` cookie scoped to the auth path. Access token in JS memory only. The WebSocket handshake carries the access token. Deployment is same-site (shared registrable domain or reverse proxy), with no design for unrelated frontend/API domains.

### Reason / Context
`localStorage` would turn an XSS hole into a stolen long-lived session.

### Consequences / Constraints
Private pages render client-side after the first refresh call; the public catalog can be server-rendered.

---

## Decision 144 — Token formats and lifetimes

**Status:** Accepted

### Decision
Access token: JWT, HS256, only `sub`/`iat`/`exp`, 15 minutes, algorithm pinned. Refresh token: opaque 256-bit random value, hashed in the database, 30-day sliding expiry, 90-day absolute cap per family.

### Reason / Context
A refresh token must be looked up anyway, so a signed token adds nothing.

### Consequences / Constraints
Tokens are hashed with SHA-256 (fast hash suits high-entropy tokens).

---

## Decision 145 — Refresh rotation and reuse detection

**Status:** Accepted

### Decision
Rotation on every refresh, family-wide reuse detection and a ~10-second grace window. `RefreshToken` gains `used_at` and `family_started_at`. Admin calls `AuthService.revokeAllSessions(tx, userId)` through Auth's `index.ts` inside the suspension transaction.

### Reason / Context
Tolerates concurrent tabs while detecting theft.

### Consequences / Constraints
Teacher revocation does not revoke sessions (Decision 151). A lost refresh response after the grace window forces re-login.

---

## Decision 146 — Password hashing and rules

**Status:** Accepted

### Decision
Argon2id with current OWASP parameters verified at implementation, length 10–128, common-password check, no composition rules, dummy hash for unknown emails, throttle before hashing, no rehashing in v1.

### Reason / Context
Current guidance; prevents hash-DoS and email enumeration.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 147 — Socket authentication lifecycle

**Status:** Accepted

### Decision
Authenticate at the handshake, re-check status on events, disconnect on suspension, no periodic re-authentication.

### Reason / Context
Periodic re-auth would cause reconnects without security gain.

### Consequences / Constraints
"Log out everywhere" is included in v1, but "list my sessions" is not.

---

## Decision 148 — Auth endpoint list and cookie

**Status:** Accepted

### Decision
Auth endpoints as tabled. Cookie `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`, with an `Origin` check on refresh and logout. Tokens consumed by POST only. `login` returns tokens only.

### Reason / Context
Mail scanners open links automatically and would burn single-use tokens.

### Consequences / Constraints
`INVALID_CURRENT_PASSWORD` is 403 so the frontend does not treat it as session expiry.

---

## Decision 149 — Registration without enumeration

**Status:** Accepted

### Decision
Registration always answers 202 with the outcome delivered by email. Unverified re-registration replaces the password. Always hash, async mail, verification never logs in, newest-token cooldown. The narrow pre-verification race is accepted.

### Reason / Context
Closes account enumeration.

### Consequences / Constraints
Typos give no instant feedback.

---

## Decision 150 — Google via frontend-supplied ID token

**Status:** Accepted

### Decision
Frontend sends the Google ID token to `POST /auth/google`. The four sign-in rules, link/unlink, `NO_LOGIN_METHOD_REMAINING`, no Google tokens stored.

### Reason / Context
Fewer moving parts than a backend redirect flow.

### Consequences / Constraints
Accepted limitation: a stolen access token could link a Google account.

---

## Decision 151 — Password flows

**Status:** Accepted

### Decision
Reset verifies the email and revokes all sessions. Change keeps this device and revokes others. No `set-password` endpoint (Google-only users add a password via reset). No account lockout. Teacher revocation does not revoke sessions.

### Reason / Context
Lockout enables denial of service; emailed proof prevents a stolen token from creating a permanent way in.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 152 — Final form of Decision 108

**Status:** Accepted (finalizes Decision 108)

### Decision
The guard algorithm: verify JWT, load user and roles, suspended check, `tokens_valid_after` check, attach active roles only. Optional-auth with an invalid token returns 401. `User.tokens_valid_after` with a whole-second `iat` comparison; revoke-all updates it in the same transaction.

### Reason / Context
Access tokens cannot otherwise be revoked individually.

### Consequences / Constraints
Adds a column, not an entity.

---

## Decision 153 — Throttle keys, proxy trust and first Admin

**Status:** Accepted

### Decision
IP plus email throttle keys on sensitive endpoints, trusted-proxy configuration, environment-based first-Admin seed, and the Phase 7 test list.

### Reason / Context
Admin accounts cannot be created through registration.

### Consequences / Constraints
In-memory throttler storage fits the single-instance assumption.

---

## Decision 154 — REST and socket responsibilities for chat

**Status:** Accepted

### Decision
Commands and history over REST; the socket is for receiving. `message:send` runs over the socket with acknowledgement and over REST as fallback, both calling `MessagesService.send()` with the same error codes and `clientId` idempotency. Mark-read is REST only.

### Reason / Context
One service gives a fallback and testability.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 155 — Per-member fan-out delivery

**Status:** Accepted

### Decision
Delivery fans out to each current member's personal room, with recipients read from the database after commit. No per-conversation rooms in v1. Membership-change events go directly to the affected user.

### Reason / Context
A missed "leave room" would let a removed member keep receiving messages; reading membership from the database cannot drift.

### Consequences / Constraints
Cost grows with channel size (accepted at v1 scale).

---

## Decision 156 — Presence

**Status:** Accepted

### Decision
In memory, multi-socket, ~5 s offline debounce, shared only between DM and group peers (never in course channels), blocked pairs excluded, `last_seen_at` written on the last disconnect.

### Reason / Context
Global presence is a surveillance feature.

### Consequences / Constraints
`last_seen_at` is stored but exposed by no endpoint. Typing indicators are included for DMs and groups only.

---

## Decision 157 — Recovery by pull

**Status:** Accepted

### Decision
`seq` gap detection plus the `after=` endpoint. No server-side event buffering and no Socket.IO connection state recovery.

### Reason / Context
Buffering is memory-bound and would hide gaps.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 158 — Event contract and gateway lifecycle

**Status:** Accepted

### Decision
The event contract (including `conversation:read`), handshake checks with Origin validation, per-event re-checks, `session:revoked` followed by disconnect.

### Reason / Context
Defense in depth against cross-site WebSocket hijacking and stale sessions.

### Consequences / Constraints
Known limit: a single-device logout does not close that device's open socket.

---

## Decision 159 — Concurrency strategy and transaction hygiene

**Status:** Accepted

### Decision
READ COMMITTED plus four tools (unique constraints, conditional updates, row locks, advisory lock). State is read only after the lock. No hashing, token verification or network work inside transactions. Unique violations are handled outside the failed transaction. Helpers: bounded-retry `runInTransaction` and `lockRow` over a whitelisted table list.

### Reason / Context
SERIALIZABLE would require retry logic everywhere and is harder to debug.

### Consequences / Constraints
Lock-conflict claims are verified in Spike B.

---

## Decision 160 — Course mutex and global lock order

**Status:** Accepted

### Decision
The Course row is a shared/exclusive mutex (Course-S for student-side entries and completion, Course-X for lifecycle, team and lesson-status changes). Global lock order: advisory → User → Course → Conversation → child rows (Message before Report). User-S/User-X for teacher eligibility. `ADMIN-SET` advisory lock for last-Admin protection.

### Reason / Context
Resolves the collected races and prevents deadlock and stuck completion.

### Consequences / Constraints
Enrollments briefly wait during publish, team and lesson-status operations (accepted). `NO KEY UPDATE` is used for X so FK inserts are not blocked.

---

## Decision 161 — Transaction catalog

**Status:** Accepted

### Decision
The full catalog, including the Enrollment row as the per-student mutex, completion serialization, report-resolution lock order, send-message idempotency without `seq` gaps, single-statement progress reads and the accepted-races list. Accepting an invitation moves a `PENDING` enrollment to `ACTIVE`; accepting when already `ACTIVE` returns `ALREADY_ENROLLED` and rolls the acceptance back.

### Reason / Context
Two bugs were found: a stuck completion and a report-resolution deadlock; both are fixed by this catalog.

### Consequences / Constraints
None beyond the decision itself.

---

## Decision 162 — After-commit effect policy and safety-net sweepers

**Status:** Accepted

### Decision
Defined handling for lost after-commit effects. Two idempotent sweepers (channel reconcile, full completion recheck) run as nightly scheduled jobs, log whenever they repair something, and have no Admin endpoints.

### Reason / Context
Repairs silent drift without exposing manual controls.

### Consequences / Constraints
Safe only on a single instance. A scheduler (`@nestjs/schedule`) is needed.

---

## Decision 163 — Extra FK child indexes

**Status:** Accepted

### Decision
`User.avatar_file_id`, `Course.cover_file_id`, `ContentBlock.file_id`, `Enrollment.last_visited_lesson_id` (partial) and `Notification.course_id`.

### Reason / Context
PostgreSQL does not index the child side of a foreign key automatically.

### Consequences / Constraints
Later joined by `RefreshToken(family_id)` and `Invitation(invited_user_id)` through Decision 164.

---

## Decision 164 — Final v1 architecture consolidation

**Status:** Accepted

### Decision
The Phase 10 consolidation is the final v1 architecture, including the two added indexes `RefreshToken(family_id)` and `Invitation(invited_user_id)`, and `GET /me/presence` in v1 (block-filtered). All other findings, risks and future improvements stand as documented.

### Reason / Context
Closes the design phase.

### Consequences / Constraints
Implementation follows the roadmap. Any conflict found during implementation follows the Decision Governance rules below.

---

## Decision 165 — PostgreSQL 18 minimum and database-generated UUID v7 keys

**Status:** Proposed — awaiting owner approval. Not Accepted: Decision 65 stays authoritative exactly as written until this proposal is approved.

### Decision (proposed)
Require **PostgreSQL 18 or later** in local development, CI and eventual deployment. Where the schema specifies a UUID v7 primary key, the **database generates it** with PostgreSQL's native `uuidv7()` as the column default (in Prisma: `@default(dbgenerated("uuidv7()")) @db.Uuid`). Application-side generation (the `uuid` package, version 7) is used only where an id is needed before the INSERT.

This proposal does **not** select a hosting provider or deployment platform.

### Reason / Context
- Decision 65 fixed UUID v7 keys and deferred the generation mechanism to Spike A ("The UUID v7 generation mechanism is confirmed in Spike A"). The roadmap M1 item asks "database-generated or application-generated".
- Spike A (M1) verified on PostgreSQL 18.6 with Prisma 7.10.1 (`docs/spikes/m1-spike-a-report.md`, rows B1–B4): `uuidv7()` is built in (`pg_catalog`, no extension); generated ids are version 7 and sorted in creation order across 300 sequential and 500 bulk inserts. PostgreSQL's documentation describes the values as time-ordered but does not promise strict monotonicity, so ordering is a locality benefit, not a guarantee.
- Database-side generation also covers raw SQL, seed and migration inserts. A Prisma-side `@default(uuid(7))` leaves no database default, and a raw insert without an id then fails (SQLSTATE 23502).
- Docker Compose and CI already use `postgres:18.6` (M0).
- **Not verified:** whether any particular hosting provider offers PostgreSQL 18; behavior on PostgreSQL older than 18; a polyfill `uuidv7()` function for older versions.
- Alternatives considered: (B) application-generated ids only, with no PostgreSQL minimum but no default for raw inserts; (C) a hand-written `uuidv7()` polyfill for older PostgreSQL, which keeps the database default but adds code to maintain and may collide with the native function name on upgrade; (D) defer, which leaves M5 migrations without a fixed mechanism.

### Relationship to existing decisions
- References **Decision 65**. If accepted, this decision would supersede **only** the clause in Decision 65's Consequences, "The UUID v7 generation mechanism is confirmed in Spike A.", by fixing the mechanism as described above. It would also give the unspecified "deployment major version" wording (roadmap M0, architecture "same major version as deployment") the value "PostgreSQL 18 or later".
- Preserved unchanged: UUID v7 keys, `timestamptz`, PostgreSQL enums, status columns, `deleted_at` only where history requires it (all other provisions of Decision 65), and every other decision.
- On acceptance (not done now): the Status of Decision 65 becomes "Accepted (generation mechanism finalized by Decision 165)", recorded in both entries; `architecture.md` (primary-key convention and the PostgreSQL development-environment row) and the `roadmap.md` M0 wording lose their "proposed" label.

### Consequences / Constraints
- If accepted: Prisma models use `dbgenerated("uuidv7()")` for UUID v7 keys; the PostgreSQL minimum can only be lowered by a new decision; the owner confirms PostgreSQL 18 availability for the intended deployment before accepting.
- Until approved: no change to Decision 65; the M5 schema migrations depend on the outcome.

---

## Future Decisions

The next available decision number is:

**Decision 166** (Decision 165 is proposed and awaiting owner approval)

---

# Decision Governance

- **Current (accepted) decisions:** 1–164 · **Proposed, awaiting owner approval:** 165
- **Next available decision:** 166
- **No silent architectural changes.** The architecture may not be altered without a numbered decision.
- **Any implementation conflict must result in a new numbered decision.** If a spike or implementation step shows an existing decision is wrong or impossible, work stops, the conflict is written down, and a new proposal (166 and up; number 165 is already used by the proposal recorded above) is raised and approved before anything changes.
- **Existing decisions remain authoritative until explicitly superseded** by a later numbered decision, and the supersession is recorded in both entries.