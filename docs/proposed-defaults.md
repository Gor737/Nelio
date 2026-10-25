# Initial implementation defaults for values the documents do not state

> **Status: APPROVED by the owner on 2026-10-25 as initial implementation defaults.** They were proposed by the implementer (2026-10-25, "proposed defaults") and approved as a set; they are **not requirements of the original documents**, and they supersede and change no numbered decision. Where a value is stated in `decision.log.md`, `architecture.md` or `roadmap.md`, that text wins: the value is marked **documented** in code and is not listed here. Changing any value below later needs the owner's approval and, for a *SQL CHECK*, a migration. (The file keeps its original name `proposed-defaults.md` so earlier references stay valid.)
> **Source of the values:** `apps/backend/src/common/constants/` and `apps/backend/src/infrastructure/events/event-contracts.ts`. In code each entry below is marked `approved-default` or `approved-derived` (versus `documented` for values the documents state). A test (`test/constants/shared-constants.spec.ts`) fails if such a name is missing from this file, so this list cannot silently fall behind the code.
> **Date:** 2026-10-25 · **Related:** Decision 165 (PostgreSQL 18+ and `uuidv7()`), Accepted, see `decision.log.md`. **Unresolved:** the production hosting provider is not selected; its PostgreSQL 18 compatibility is a deployment requirement (`roadmap.md` M14).

**Labels.** `approved-default` (shown below as *proposed*) = the documents say nothing, so this is the smallest reasonable value. `approved-derived` (shown below as *derived*) = the documents name the thing, and the value follows from a stated rule (for example the status-code test of Decision 140).
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

## 10. Added in M6 (approved by the owner 2026-10-25, after review)

These were introduced when M6 needed concrete values, and were approved on 2026-10-25 after a review against the architecture, the decision log and the roadmap. The architecture-level parts are recorded as **Decision 166** (`SERVICE_UNAVAILABLE`) and **Decision 167** (own rate limiter, logger location, `/health`, JSON 413/415). Each value is a one-line change in the file named. Spike B (`docs/spikes/m2-spike-b-report.md`, section 3) is the source for the transaction values.

- **Transaction limits** (`TRANSACTION_LIMITS` in `limits.ts`): `STATEMENT_TIMEOUT_MS` 8000, `LOCK_TIMEOUT_MS` 5000, `PRISMA_TIMEOUT_MS` 10000, `PRISMA_MAX_WAIT_MS` 5000, `MAX_ATTEMPTS` 3 (deadlock/serialization retry, first attempt included), `RETRY_BASE_DELAY_MS` 20 (jittered, multiplied by the attempt number), `POOL_MAX` 10. **Revisit the pool size at M14**, when the hosting provider is selected (the provider's connection limits and pooler are unknown).
- **Error code `SERVICE_UNAVAILABLE` → 503** (Decision 166; `error-codes.ts`, now `source: 'documented'`): the health endpoint when the database is unreachable, a lock or statement timeout, and a deadlock or serialization failure that survived the retries. No `Retry-After` is sent with it, because no meaningful value can be determined.
- **Database error → HTTP mapping** (`all-exceptions.filter.ts`): unique, foreign-key and restrict violations that no service translated → 409 `RESOURCE_CONFLICT`; exhausted deadlock/serialization, lock timeout, statement timeout → 503 `SERVICE_UNAVAILABLE`; CHECK and NOT NULL violations → 500 `INTERNAL_ERROR` with a loud error log; anything else → 500 with a generic message.
- **Framework errors → codes**: unmatched route 404 `NOT_FOUND`; malformed JSON, a JSON body that is too large (413) or has an unsupported content type (415) → 400 `VALIDATION_FAILED`. `FILE_TOO_LARGE` and `FILE_TYPE_NOT_ALLOWED` are used only on upload routes (M9a).
- **Rate limiter** (Decision 167): own in-memory fixed-window store instead of `@nestjs/throttler`; counters are kept per class and per key; `Retry-After` is returned with every 429. The `email` key is read from `body.email` (lowercased, trimmed). **The store is bounded:** `COUNT_LIMITS.RATE_LIMIT_MAX_KEYS` = 50000 windows; when full, expired windows are swept first, then the earliest-started window is evicted (an evicted key starts a fresh window; evictions are counted). **Known gap:** the `user` and `conversation` keys do not exist before authentication, so the Per-conversation burst class does not limit yet. It is tracked for M8/M10 (roadmap), which must add a test proving it limits, plus an M8 test that the JWT guard runs after the rate limiter. A current test pins the gap so it cannot be forgotten; it is not fixed.
- **Request ids**: an incoming `X-Request-Id` is echoed only when it matches `[A-Za-z0-9._-]{8,64}`; otherwise a UUID is generated. The id is returned in `X-Request-Id`, exposed to the browser through CORS, and included in every log line.
- **Logging** (Decision 167): own JSON logger in `infrastructure/logging`. A field is redacted when any word of its name (split on case and separators) is one of the words in `redact.ts` (password, token, secret, authorization, cookie, message body, and similar); URLs lose their password; the access log records method, path without query, status and duration only. Every HTTP test suite of a new module must use `test/support/log-capture.ts` to assert that request bodies and sensitive header values are not logged.
- **Health and Swagger**: `GET /health` is **outside** the `/api/v1` prefix. Swagger UI at `/api/docs`, document at `/api/docs-json`, enabled outside production and in production only with `SWAGGER_ENABLED=true`; every operation lists 429, 500 and 503; `npm run openapi:export` writes `apps/backend/openapi.json`.
- **Environment variables**: `JWT_SECRET`, `DATABASE_URL`, `FRONTEND_ORIGIN`, `PORT`, `TRUST_PROXY` (0–10), `LOG_LEVEL`, `SWAGGER_ENABLED`; see `.env.example`. `FRONTEND_ORIGIN` defaults to `http://localhost:3001` outside production only. `npm start`, `start:dev` and `start:debug` load the root `.env` with Node's `--env-file-if-exists=../../.env` (the path is relative to `apps/backend`); variables already set in the environment take precedence, and `start:prod` loads no file. **`TRUST_PROXY` (the number of reverse proxies in front of the backend) stays a deployment requirement until the hosting provider is selected.**

## 11. Added in M7 (PROPOSED, pending owner review)

M7 built schema groups G2-G5. The documents fix the tables, columns, CHECKs and indexes (architecture sections 8-10); the points below were not specified and were decided by the implementer. They are **not yet approved**. Each is one migration or one constant away from a change.

- **Conversation shape** (`conversations_type_shape`): `DIRECT` has no title and no course; `GROUP` has a title (1-80 characters, `TEXT_LIMITS.GROUP_TITLE`) and no course; `COURSE_CHANNEL` has a course and **no title of its own**, because it is shown under the course title, which can change. `created_by` is nullable and has no CHECK (a channel has no creator). `last_seq >= 0`.
- **Report evidence**: `message_snapshot` is `jsonb`. A `MESSAGE` report must carry it and a `USER` report must not (`reports_target_shape`). Its contents are decided by the Moderation module in M9c (planned: `body`, `senderId`, `conversationId`, `seq`, `createdAt`); the exact snapshot size limit (listed as undecided in section 9) is still open.
- **`Message.client_id` is a `uuid`** (the frontend generates it, for example with `crypto.randomUUID()`); `seq` and `last_seq` are `integer`. The sender of a message must be a row of `conversation_members` (composite foreign key), which a former member keeps (`left_at`), so history stays valid; whether a former member may still send is a service rule.
- **`updated_at`** exists on mutable entities edited in place or moving through a state machine: `categories`, `courses`, `sections`, `lessons`, `content_blocks`, `conversations`, `enrollments`, `invitations`, `reports` (and, from M5, `users`, `user_roles`). It is absent from append-only, join and immutable rows: `tags`, `course_tags`, `course_teachers`, `notifications`, `lesson_completions` (its time is `completed_at`), `direct_conversations`, `conversation_members` (`joined_at`/`left_at`), `messages` (as documented), `audit_logs`.
- **`courses.enrollment_policy` has no database default** (the creator chooses it explicitly); `courses.status` defaults to `DRAFT`, `invitations.status` to `PENDING`, `reports.status` to `OPEN`, `conversation_members.role` to `MEMBER`.
- **`courses.search_vector`** is generated from `title`, `summary` and `description` with the `simple` configuration.
- **Lesson CHECK** is only for `PUBLISHED` (needs `first_published_at`), as documented; an `ARCHIVED` lesson that was never published is allowed.
- **Ordering**: `position` columns are plain integers with no unique constraint on `(parent, position)`; reordering rewrites the full list (as documented). One extra index not in the architecture list: `content_blocks (lesson_id, position)`, because blocks are always read in order within a lesson and the cascade delete needs the foreign-key child index.
- **`content_blocks.video_external_id`** must be 1-64 characters (the documents leave the length and character set undecided); the character set is not constrained in SQL.
- **G1 text-limit CHECKs** (`g1_text_limits` migration): `users.email` 3-254, `users.full_name` 1-100, `user_roles.application_message` 10-1000, `user_roles.decision_note` 1-1000, `file_assets.original_name` 1-255. Their numbers were already approved as `TEXT_LIMITS`; M5 only created the columns. `PASSWORD` (hash only) and `ADMIN_LOCK_REASON` (no column) have no SQL counterpart, and a test lists them as the deliberate exceptions.
- **Foreign-key `ON UPDATE`** is Prisma's default `CASCADE` everywhere (ids never change).
- **Open-report uniqueness** is per reporter and target: one `OPEN` report of a given message, and one of a given user, per reporter. A new report is possible once the previous one is `DISMISSED` or `ACTIONED`.

## Approval and changes

All values in sections 1–9 were approved by the owner as a set on 2026-10-25 and are used as written. Section 10 was approved on 2026-10-25 after review (Decisions 166 and 167). **Section 11 (M7) is awaiting review.** To change one later: edit the constant, update this file, and add a migration if it is a *SQL CHECK*; record it in `decision.log.md` if it affects the schema or the API contract.
