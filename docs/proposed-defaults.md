# Proposed defaults for values the documents do not state

> **Status: PROPOSED, requires owner review. None of this is an approved product decision.** It supersedes and changes no numbered decision. Where a value is stated in `decision.log.md`, `architecture.md` or `roadmap.md`, that text wins and the value is marked **documented** in code and is not listed here.
> **Source of the values:** `apps/backend/src/common/constants/` and `apps/backend/src/infrastructure/events/event-contracts.ts`. Each entry below is marked `proposed` or `derived` there. A test (`test/constants/shared-constants.spec.ts`) fails if a proposed or derived name is missing from this file, so this list cannot silently fall behind the code.
> **Date:** 2026-10-25 · **Related, still pending:** Decision 165 (PostgreSQL 18+ and `uuidv7()`), see `decision.log.md`.

**Labels.** `proposed` = the documents say nothing, so this is the smallest reasonable value. `derived` = the documents name the thing, and the value follows from a stated rule (for example the status-code test of Decision 140).
**Where it lands.** *SQL CHECK* = a database CHECK constraint created in M5/M7 (the architecture says "title/length limits from shared constants" are CHECKed, and `Message` has a body-length CHECK). *DTO* = request validation only. *Service* = business rule in the owning service. *Config* = runtime configuration. Everything not marked SQL CHECK stays out of the database on purpose, so it can be changed without a migration.

## 1. Text lengths (characters)

| Constant | Proposed | Column or use | Rationale | Where |
|---|---|---|---|---|
| `EMAIL` | 3–254 | `User.email` | 254 is the practical maximum of an address (RFC 5321). | DTO |
| `USER_FULL_NAME` | 1–100 | `User.full_name` | Fits long Armenian, Russian and compound names; short enough for the trigram index. | DTO |
| `TEACHER_APPLICATION_MESSAGE` | 10–1000 | `UserRole.application_message` | Enough for a real motivation, bounded for Admin review. | DTO |
| `DECISION_NOTE` | 1–1000 | `UserRole.decision_note` | Same bound as the application message. | DTO |
| `COURSE_TITLE` | 3–120 | `Course.title` | Catalog cards and search results need short titles. | SQL CHECK + DTO |
| `COURSE_SUMMARY` | 10–300 | `Course.summary` | Publishing requires a summary (roadmap M7 G2), so a non-trivial minimum. | DTO |
| `COURSE_DESCRIPTION` | 0–5000 | `Course.description` | Optional long text. | DTO |
| `SECTION_TITLE` | 1–120 | `Section.title` | Same scale as a course title. | SQL CHECK + DTO |
| `LESSON_TITLE` | 1–150 | `Lesson.title` | Lessons often have descriptive titles. | SQL CHECK + DTO |
| `TEXT_BLOCK_BODY` | 1–20000 | `ContentBlock.text_body` | Markdown is stored as text with a length limit (Decision 66, roadmap M10b); about 3 pages. | DTO |
| `TAG_NAME` | 2–30 | `Tag.name` | Tags are short labels; autocomplete. | SQL CHECK + DTO |
| `CATEGORY_NAME` | 2–60 | `Category.name` | Admin-managed, short. | SQL CHECK + DTO |
| `GROUP_TITLE` | 1–80 | `Conversation.title` | Group names in a chat list. | SQL CHECK + DTO |
| `MESSAGE_BODY` | 1–2000 | `Message.body` | Plain text only (Decision 85); roughly a long chat message. The architecture requires a body-length CHECK. | SQL CHECK + DTO |
| `REPORT_DESCRIPTION` | 1–1000 | `Report.description` | Optional free text next to the `reason` enum. | DTO |
| `REPORT_RESOLUTION_NOTE` | 1–1000 | `Report.resolution_note` | Admin note on closing a report. | DTO |
| `FILE_ORIGINAL_NAME` | 1–255 | `FileAsset.original_name` | Common file-name limit; the stored key is generated, never this name. | DTO |
| `ADMIN_LOCK_REASON` | 5–500 | no column; in the `COURSE_ADMIN_LOCKED` notification `data` and audit metadata | Required explanation shown to the Owner (Decision 139). | DTO |

## 2. Counts, pagination and times

| Constant | Proposed | Rationale | Where |
|---|---|---|---|
| `PAGE_SIZE_DEFAULT` | 20 | Default offset page; the maximum (50) is documented. | DTO |
| `CURSOR_PAGE_SIZE_DEFAULT` / `CURSOR_PAGE_SIZE_MAX` | 50 / 100 | Cursor lists for messages, notifications and the audit log (documented as cursor-based, size not stated). | DTO |
| `TAGS_PER_COURSE_MAX` | 10 | The architecture lists a "tag cap" without a number; 10 keeps the filter useful. | Service |
| `EMAIL_TOKEN_TTL_MS` | 1 hour | Single-use verification and reset tokens; short because a token is a bearer credential. | Config |

## 3. File uploads (`FILE_LIMITS`)

The real content type is verified from the file bytes (documented, Decision 64 and roadmap M9a); these are the allowed types and size caps per kind.

| Kind | Max size | Allowed content types | Rationale |
|---|---|---|---|
| `AVATAR` | 2 MB | jpeg, png, webp | Small display image. |
| `COURSE_COVER` | 5 MB | jpeg, png, webp | Larger hero image. |
| `LESSON_ATTACHMENT` | 25 MB | pdf, jpeg, png, webp, zip, text/plain | Typical course material; no executables. |

`FileAsset.size_bytes > 0` is documented and stays a SQL CHECK; the size caps are enforced by the upload service (413 `FILE_TOO_LARGE`).

## 4. Rate-limit classes (`RATE_LIMIT_CLASSES`)

The four classes and the endpoints each applies to are documented; the numbers are proposed. A global throttler runs before authentication.

| Class | Proposed | Keys | Rationale |
|---|---|---|---|
| `STRICT` | 5 per 60 s | IP and email | Login, registration, forgot-password, resend-verification: brute-force and enumeration targets. |
| `TIGHT` | 20 per 60 s | IP and user | User search, DM/group creation, uploads, reports, teacher application, invitations. |
| `PER_CONVERSATION_BURST` | 30 per 10 s | user and conversation | Message send and typing; allows a normal burst, stops flooding. |
| `DEFAULT` | 120 per 60 s | IP | Everything else. |

## 5. HTTP status of error codes whose name is documented but status is not (`derived`)

Applied from the status test of Decision 140 (400 wrong regardless of data; 403 not entitled; 404 hidden; 409 entitled but data conflicts).

| Code | Status | Why |
|---|---|---|
| `NOT_FOUND` | 404 | Generic hidden resource. |
| `TOO_MANY_REQUESTS` | 429 | Throttling. |
| `INTERNAL_ERROR` | 500 | Includes CHECK violations (a service bug, logged loudly). |
| `RESOURCE_CONFLICT` | 409 | Unique or foreign-key violation no service rule translated. |
| `TOKEN_INVALID` | 400 | Unknown, used or expired email token. |
| `NO_LOGIN_METHOD_REMAINING` | 409 | Entitled caller, data conflict. |
| `COURSE_ALREADY_LOCKED` | 409 | Lock on a locked course. |
| `INVALID_STATE_TRANSITION` | 409 | Transition the state machine forbids. |
| `ALREADY_ENROLLED` | 409 | Documented as the result of accepting an `ACTIVE` enrollment. |
| `APPLICATION_PENDING` | 409 | Teacher application while one is pending. |
| `LAST_PLATFORM_ADMIN` | 409 | Last active Admin (Decision 135 split). |
| `LAST_GROUP_ADMIN` | 409 | Last admin of a group (Decision 135 split). |
| `CANNOT_BLOCK_SELF` | 400 | Wrong regardless of data. |
| `MEMBERS_UNAVAILABLE` | 409 | Neutral result when some members cannot be added. |
| `CANNOT_MESSAGE_USER` | 403 | Not entitled; identical in both directions. |
| `CLIENT_ID_REUSED` | 409 | Same `client_id`, different body. |
| `REPORT_ALREADY_RESOLVED` | 409 | A sibling resolution closed it first. |
| `FILE_IN_USE` | 409 | Deleting a referenced file. |

## 6. Audit action names (`derived`)

Only `TEACHER_APPROVED`, `COURSE_ADMIN_UNLOCKED` and `REPORT_CONTEXT_VIEWED` are named in the documents. The rest follow the privileged and relationship-changing actions of the transaction catalog and the endpoint groups. The module that calls `AuditWriter` is in brackets.

- users: `TEACHER_REJECTED`, `TEACHER_REVOKED`, `USER_SUSPENDED`, `USER_UNSUSPENDED`, `ADMIN_ROLE_GRANTED`, `ADMIN_ROLE_REVOKED`
- courses: `COURSE_PUBLISHED`, `COURSE_ARCHIVED`, `COURSE_RESTORED`, `COURSE_DELETED`, `COURSE_ADMIN_LOCKED`, `COURSE_ADMIN_RESTORED`, `COURSE_OWNERSHIP_TRANSFERRED`, `COURSE_ASSISTANT_ADDED`, `COURSE_ASSISTANT_REMOVED`
- enrollments: `STUDENT_REMOVED`, `STUDENT_REINSTATED`
- chat: `MESSAGE_DELETED_BY_MODERATOR`
- moderation: `REPORT_DISMISSED`, `REPORT_ACTIONED`
- admin: `CATEGORY_CREATED`, `CATEGORY_UPDATED`, `CATEGORY_DELETED`, `TAG_MERGED`

The audit writer allow-list (`users, courses, enrollments, chat, moderation, admin`) is derived from these writers and is enforced by the dependency-cruiser rule `audit-only-by-audited-modules`.

## 7. Notification recipients (`derived`)

The 12 types are documented; the recipient is named for most. Not named: `ENROLLMENT_REJECTED` (the student), `REMOVED_FROM_COURSE` (the removed student), `INVITATION_RECEIVED` (the invitee), `OWNERSHIP_TRANSFERRED` (the new Owner; the previous Owner performed it).

## 8. Structure, event payloads and permissions (proposed)

- **Event payloads** (`event-contracts.ts`): the five infrastructure events and the 12 notification events carry ids only. The event names `teacher-application.received` … `course.admin-locked` and their fields are a proposal; only `message.created`, `membership.ended`, `session.revoked`, `socket.connected` and `socket.disconnected` are named in the architecture.
- **Student-side permissions** in the permission matrix (`enrollment.request`, `enrollment.leave`, `lesson.read-content`, `lesson.mark-complete`, …) restate Decisions 70 and 123 as data; the full status × action table is built in M11c.
- **Module `index.ts`** exports the Nest module class (needed for `AppModule`); layering is "any lower layer" rather than the exact edges of the architecture diagram.

## 9. Not yet decided (will be proposed when the module is built)

`ContentBlock.video_external_id` length and character set, slug generation rules for `Category`/`Tag`, password-reset and verification email wording, the exact `Report` snapshot size, and the audit `metadata` shape. None of them is encoded yet.

## How to approve

Reply with the items to change (for example "COURSE_TITLE 3–150") or "approve all". An approved value moves from `proposed` to `documented` in code and is recorded in `decision.log.md` when it affects the schema or the API contract; until then M5 uses these values only where the table above says *SQL CHECK*.
