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

The character set of `ContentBlock.video_external_id` (provider-specific validation, M10b; its length is decided in section 11), slug generation rules for `Category`/`Tag`, and the audit `metadata` shape. (The password-reset and verification email wording is proposed in section 12.) None of them is encoded yet. (The `Report` snapshot size is decided in section 11.)

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

## 11. Added in M7 (approved by the owner 2026-10-26, after review)

M7 built schema groups G2-G5. The documents fix the tables, columns, CHECKs and indexes (architecture sections 8-10); the points below were not specified and were proposed by the implementer. The owner approved all twelve on 2026-10-26, with one revision (the report snapshot is `text`, not `jsonb`) and the follow-up items named below. Each is one migration or one constant away from a change.

- **Conversation shape** (`conversations_type_shape`): `DIRECT` has no title and no course; `GROUP` has a title (1-80 characters, `TEXT_LIMITS.GROUP_TITLE`) and no course; `COURSE_CHANNEL` has a course and **no title of its own**, because it is shown under the course title, which can change. `created_by` is nullable and has no CHECK (a channel has no creator). `last_seq >= 0`.
- **Report evidence** (revised on review, aligned with Decision 77: "a text snapshot"): `message_snapshot` is `text`, not `jsonb`. It preserves the **message body** as it was when the report was filed, so it survives a later edit. Sender, conversation, `seq` and time cannot change and are read from the message row (messages are soft-deleted, never hard-deleted). A `MESSAGE` report must carry it and a `USER` report must not (`reports_target_shape`). Its size follows the existing `TEXT_LIMITS.MESSAGE_BODY` limit, 1-2000 characters (`reports_message_snapshot_length`, migration `g5_report_snapshot_text`), which closes the "snapshot size" item that section 9 had listed as undecided.
- **`Message.client_id` is a `uuid`** (the frontend generates it, for example with `crypto.randomUUID()`); `seq` and `last_seq` are `integer`. The sender of a message must be a row of `conversation_members` (composite foreign key), which a former member keeps (`left_at`), so history stays valid; whether a former member may still send is a service rule.
- **`updated_at`** exists on mutable entities edited in place or moving through a state machine: `categories`, `courses`, `sections`, `lessons`, `content_blocks`, `conversations`, `enrollments`, `invitations`, `reports` (and, from M5, `users`, `user_roles`). It is absent from append-only, join and immutable rows: `tags`, `course_tags`, `course_teachers`, `notifications`, `lesson_completions` (its time is `completed_at`), `direct_conversations`, `conversation_members` (`joined_at`/`left_at`), `messages` (as documented), `audit_logs`. **Review rule (approved):** `updated_at` is maintained by Prisma only (`@updatedAt`), not by a trigger, so **every raw-SQL `UPDATE` on a table that has `updated_at` must set `updated_at = now()` explicitly** (it is an item of the review checklist in the roadmap).
- **`courses.enrollment_policy` has no database default, and the API does not default it either** (owner decision): the course-create request must carry `enrollmentPolicy` explicitly (`OPEN`, `APPROVAL_REQUIRED` or `INVITATION_ONLY`); a missing or unknown value is 400 `VALIDATION_FAILED`, and the OpenAPI schema lists the field as required. `courses.status` defaults to `DRAFT`, `invitations.status` to `PENDING`, `reports.status` to `OPEN`, `conversation_members.role` to `MEMBER`.
- **`courses.search_vector`** is generated from `title`, `summary` and `description` with the `simple` configuration.
- **Lesson CHECK** is only for `PUBLISHED` (needs `first_published_at`), as documented; an `ARCHIVED` lesson that was never published is allowed. **Follow-up (roadmap M10b):** permanent deletion of a lesson is allowed only if it was never published (`first_published_at IS NULL`) and has no completions; "not currently published" is not enough.
- **Ordering**: `position` columns are plain integers with no unique constraint on `(parent, position)`; reordering rewrites the full list (as documented). One extra index not in the architecture list: `content_blocks (lesson_id, position)`, because blocks are always read in order within a lesson and the cascade delete needs the foreign-key child index.
- **`content_blocks.video_external_id`** must be 1-64 characters in SQL (the documents leave the length undecided). **Follow-up (roadmap M10b, not implemented yet):** provider-specific id validation in the Content module (for YouTube and Vimeo), because the embed URL is built from provider + id.
- **G1 text-limit CHECKs** (`g1_text_limits` migration, approved): `users.email` 3-254, `users.full_name` 1-100, `user_roles.application_message` 10-1000, `user_roles.decision_note` 1-1000, `file_assets.original_name` 1-255. Their numbers were already approved as `TEXT_LIMITS`; M5 only created the columns. `PASSWORD` (hash only) and `ADMIN_LOCK_REASON` (no column) have no SQL counterpart, and a test lists them as the deliberate exceptions.
- **Foreign-key `ON UPDATE`** is Prisma's default `CASCADE` everywhere (ids never change).
- **Open-report uniqueness** is per reporter and target: one `OPEN` report of a given message, and one of a given user, per reporter. A new report is possible once the previous one is `DISMISSED` or `ACTIONED`.

## 12. Added in M8 (approved by the owner 2026-10-26, after review)

M8 built the guards, the course-access service, the Socket.IO server and the mail service. The documents fix the algorithm and the
codes (architecture sections 11, 12 and 14, Decisions 107, 108, 119, 121, 136, 140, 152, 167); the points below were not
specified and were proposed by the implementer. The owner approved them on 2026-10-26, with the review outcome below.

**Review outcome (2026-10-26)**
- **Approved:** the check order with user-keyed 429 after 401; the visibility readings for PENDING, REMOVED, REJECTED and valid pending invitations; the handshake Origin policy; the email wording and page paths; the mail defaults (SMTP defaults, 15 s send deadline) and the 64 KB Socket.IO packet cap.
- **Kept unresolved:** the email token lifetime (see the last Mail bullet). The implementation is not changed; M11a reconciles it.
- **Scheduled, not done:** applying `PER_CONVERSATION_BURST` to the real chat routes and events (M10c); a shared DTO character-count helper based on Unicode code points (a prerequisite at the start of M9, then used by every DTO); the `npm audit` advisories in the scaffold dependencies (a dependency review before release, M14); the first CI run on GitHub, which stays open (the Mailpit SMTP test skips itself there).

**Authentication and authorization**
- **Check order with user-keyed rate limits.** The rate limiter has two phases. Keys that exist before authentication (`ip`, `email`) are counted by the first global guard, so a flood is still a 429 before any token is verified. Keys that need the user (`user`, `user + conversation`) can only be counted after authentication, so the order is `429 (ip/email) → 401 → 403 ACCOUNT_SUSPENDED → 429 (user/conversation) → role and course guards → 400 → 409`. This is Decision 167's follow-up (the gap tracked since M6) and is a clarification of the literal "429 first" wording of Decision 140 for the user-keyed classes.
- **Per-conversation burst is one counter per user per conversation** (30 in 10 s), not one counter for the whole conversation; a missing conversation id is counted in a shared "no conversation" bucket (stricter, never unlimited). REST and Socket.IO share the same budget through one `RateLimiter` service.
- **Bearer header**: exactly `Authorization: Bearer <token>`; any other scheme or shape is 401. A missing token and an invalid token give the identical response.
- **Token header/claims**: `alg` must be exactly `HS256`; `typ`, if present, must be `JWT`; the signature must be canonical base64url; `sub` must be a UUID; `iat` and `exp` must be integers; an `exp` equal to "now" is expired; the token may not exceed 4096 characters. No clock-skew leeway (one server).
- **`@Roles` on a Teacher route**: anyone without an `ACTIVE` Teacher role, including an Admin without the Teacher role, gets `TEACHER_NOT_APPROVED`; on any other role route the code is `FORBIDDEN`.
- **Course visibility** (the 108-case grid in `test/common/course-access.spec.ts`): Owner and Assistants always see the course; ACTIVE and LEFT students see published and archived courses (a LEFT student also sees an invitation-only page); a PENDING student sees only a published course (once archived it is hidden, although the request stays); an invitee sees only a published course; REMOVED, REJECTED and strangers see only a published course whose policy is not invitation-only; a lock shows students 403 `COURSE_ADMIN_LOCKED` and everyone else 404. A REMOVED or REJECTED student with a valid pending invitation is an INVITEE. Two of these are readings of Decisions 119/121: a PENDING student does not see an archived course, and REMOVED/REJECTED students are treated as ordinary visitors.
- **`@CourseRole` guard** answers a malformed `courseId` with 400 itself (before any query); everything else follows the check list (404, then the lock gate, then 403 `FORBIDDEN`).
- **Public routes** must be marked `@Public()`; the only one today is `GET /health`. The OpenAPI document derives each operation's security (`[]` for public, optional for `@OptionalAuth`, bearer otherwise) and the 400/401/403/429/500/503 responses from the same decorators.

**Socket.IO**
- **Handshake Origin**: when an `Origin` header is present it must equal `FRONTEND_ORIGIN` (403 otherwise); an absent `Origin` is accepted, because same-origin polling requests and non-browser clients omit it and a browser always sends it on the WebSocket upgrade. The token is read only from the `auth` payload.
- **Per-event re-check** (`RealtimeService.requireActiveUser`): the user must still exist, not be suspended, and the token's `iat` must not be before `tokens_valid_after`. The token's expiry is not re-checked (a connection outlives its 15-minute token; the client refreshes before reconnecting).
- **Errors on events** are acknowledgements `{ ok: false, statusCode, code, message, errors? }` with the REST codes, or an `exception` event when the client sent no acknowledgement callback. Nest does not apply the global exception filter to gateways, so **every gateway must bind `@UseFilters(AllExceptionsFilter)`** (a roadmap item for the Chat gateway in M10c).
- **Packet size cap** 64 KB (`MAX_SOCKET_PAYLOAD_BYTES`); a larger packet closes the connection.
- **`session:revoked`** is sent to every device, with an empty payload, and then the sockets are closed.

**Mail**
- **Wording and pages**: English text; the links go to the frontend pages `/verify-email?token=…`, `/reset-password?token=…`, `/login` and `/forgot-password` under `FRONTEND_ORIGIN`. The sender defaults to `Nelio <no-reply@nelio.local>` outside production. Subjects: "Confirm your email address for Nelio", "Reset your Nelio password", "You already have a Nelio account".
- **Delivery contract**: `MailService` never throws; each method resolves `true` or `false`. A recipient that is not a single plain address is refused (header injection). The whole send has a 15 s deadline on top of the transport's 10 s timeouts. The log names the template and the SMTP error code only, never the address, the link or the token.
- **Environment variables**: `SMTP_HOST` (default `127.0.0.1` = Mailpit; required in production), `SMTP_PORT` (default 1025), `SMTP_SECURE` (default false), `SMTP_USER` and `SMTP_PASSWORD` (both or neither), `MAIL_FROM` (required in production). In production STARTTLS is required unless `SMTP_SECURE=true`. The numeric loopback address is the default because resolving `localhost` delayed the first connection by about 5 seconds.
- **Token validity in the email — UNRESOLVED (kept open by the owner on 2026-10-26).** The email takes the validity from the caller (`validForHours`); the architecture says 24 hours for verification and 1 hour for password reset (section 11), but `TIME_LIMITS.EMAIL_TOKEN_TTL_MS` holds a single value (1 hour) that does not match the 24-hour verification token. Nothing is changed now; M11a reconciles the constant, the architecture text and the email, and decides which value is the requirement.

## 13. Added in M9 (PROPOSED, pending review by the owner)

M9 built the five Layer 0 modules (Files, Catalog, Moderation, Progress, Notifications) and the shared code-point length helper. The
documents fix the endpoints, locks, limits and error codes; the points below were not specified and are the implementer's proposal.
**Nothing here is approved yet.** The two items under "Owner decisions" were decided on 2026-10-26 (below); every other point stays proposed.

**Owner decisions (2026-10-26)**
- **MinIO Compose service (roadmap M9a, first item stays OPEN).** The official `minio/minio` and `quay.io/minio/minio` images can no longer be pulled, so no `minio` service was added to Docker Compose. **Owner decision:** do not adopt a community MinIO mirror or the frozen `bitnamilegacy` image as the default; a specific S3-compatible development image/provider with acceptable provenance must be selected and verified first, and only then implemented. The storage code is generic S3 (AWS SDK v3, path-style) and was verified in M9 against a temporary container of the frozen Bitnami image (12 tests in `files-s3.integration-spec.ts`, which skip themselves when no S3 endpoint is configured; the container was removed). Candidates seen to be pullable, none evaluated for provenance: Chainguard, `rustfs/rustfs`, SeaweedFS, Garage, LocalStack, `adobe/s3mock`, VersityGW. Decision 64 ("MinIO in development") is not changed by this; the production store and hosting are still chosen in M14. The rest of the project does not wait for it.
- **Lock mode of the Enrollment row when marking a lesson complete: APPROVED as Decision 168.** Architecture section 15 said Course-S, then the Enrollment row `FOR SHARE`; tested against the real database that mode deadlocks (and can miss a completion) when one student marks twice at once. The Enrollment row is locked `FOR NO KEY UPDATE` after Course-S; `architecture.md` was updated and the concurrency regression tests stay (parallel marks of the last lesson, parallel marks of the last two lessons, mutation checks).

**Shared helper (`common/decorators/text-length.decorator.ts`)**
- `@TextLength({min, max})` counts Unicode code points (`[...value].length`), like PostgreSQL `char_length`. It also refuses a string that contains a NUL character or a lone surrogate, because PostgreSQL cannot store either (both would otherwise reach the database CHECK or the driver and become a 500). A real-database test proves that anything the helper accepts is accepted by the matching SQL CHECK for all 18 limited columns, over seven alphabets (ASCII, Armenian, emoji, combining marks, and others), and fails if the helper uses `.length`.

**Files**
- **Storage keys**: `public/avatars/<uuid>.<ext>`, `public/covers/<uuid>.<ext>`, `private/attachments/<uuid>.<ext>`; the extension comes from the detected type, never from the file name. The original name is kept (sanitized, at most 255 characters, no path parts or control characters) only for display and for the download name.
- **Type check**: an own magic-byte detector (no extra dependency). Allowed: JPEG, PNG, WebP, PDF, ZIP and plain text (valid UTF-8 with no NUL and no control characters except tab, line feed, form feed and carriage return), each only for the kinds `FILE_LIMITS` allows. Known executables (Windows PE, ELF, Mach-O, shebang scripts, Java class, PHP) are refused whatever the name says. The stored `mime_type` is the detected type, not the one the client sent. An empty file is 400.
- **Who uploads**: `AVATAR` any signed-in user; `COURSE_COVER` and `LESSON_ATTACHMENT` an ACTIVE Teacher (403 `TEACHER_NOT_APPROVED`). `POST /files` is in the `TIGHT` rate-limit class.
- **Upload path**: multipart through the API, memory storage, one file per request, limits from `FILE_LIMITS` (the parser stops at 25 MB, the limit of the chosen kind is checked afterwards). There is deliberately no `fileFilter`: all checks run on the complete file, and an asynchronous filter is the trigger of a known denial-of-service advisory in the multipart parser.
- **Order**: storage first, then the row (best-effort removal of the object if the row fails); delete removes the row first, then the object. A file used as an avatar, cover or attachment is 409 `FILE_IN_USE`; someone else's file or a missing one is 404.
- **URLs**: avatars and covers are public URLs under `S3_PUBLIC_BASE_URL`; attachments are signed GET URLs valid for **5 minutes** (`TIME_LIMITS.SIGNED_URL_TTL_MS`), with an RFC 6266 `Content-Disposition`.
- **Orphan cleanup** is a callable service method (`FileCleanupService.run`): files older than 24 hours that no user, course or content block references, in batches; it loses cleanly to a concurrent attach (foreign key or lock timeout). The nightly schedule is wired in M13.
- **Configuration**: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (both keys or neither), `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_BASE_URL`. Outside production the endpoint defaults to `http://127.0.0.1:9000`, the bucket to `nelio-files`, and the keys to `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` when those are set; in production the endpoint, keys and public base URL are required. An unconfigured or failing store is 503 `SERVICE_UNAVAILABLE`; the log names the operation and status only.
- **Dependencies**: `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, both pinned to 3.1156.0.

**Catalog**
- `GET /categories` and `GET /tags` are public (the public catalog is browsed without an account). Categories are sorted by name, not paginated. Tag autocomplete matches the prefix of the slug, ordered by use (most used first, then name), at most 20.
- **Tag normalization**: Unicode NFC, then NFKC per character except the Armenian ligatures (U+0587 `և`, U+FB13 to U+FB17), which stay as they are because NFKC would rewrite `և` as `եւ`; invisible and control characters removed or turned into spaces; whitespace collapsed and trimmed; lowercase. The length limit (2-30 code points) applies to the cleaned name, and the cleaned name must contain a letter or a digit. The slug is the name with spaces turned into hyphens. Consequence of the 2-character minimum (already approved as `TAG_NAME`): one-letter tags such as "C" or "R" are not possible.
- **`setCourseTags(tx, courseId, names)`** takes at most 10 distinct tags after normalization (more is 400 `VALIDATION_FAILED` with the failing positions), replaces the course's links, returns the tags in the order given, and inserts new tags in ascending slug order with `ON CONFLICT (slug) DO NOTHING`, so concurrent transactions creating the same new tags never deadlock (a test with 12 parallel transactions fails with deadlocks when the order is removed). The first spelling of a tag keeps its stored name.

**Moderation**
- **Blocks** (`GET /me/blocks`, `PUT` and `DELETE /me/blocks/:userId`): `PUT` and `DELETE` are idempotent and answer 204; `GET` is offset-paginated and shows only the people the caller blocked (id, name, time), never who blocked them. Checks in order: yourself (400 `CANNOT_BLOCK_SELF`), unknown user (404), an ACTIVE Admin (409 `CANNOT_BLOCK_ADMIN`). A block whose blocked party is an ACTIVE Admin is ignored by `isBlockedEitherWay` and `assertCanAdd` (blocks do not apply to Admins), even if the row exists from before the role was granted.
- **`assertCanAdd(adder, candidates)`** (Decision 84) refuses with the neutral 409 `MEMBERS_UNAVAILABLE` only when a candidate has blocked the adder; the adder having blocked a candidate is not a reason. The message does not say that a block exists. Chat (M10c) calls it.
- **Reports** (`POST /users/:id/report`, `POST /conversations/:conversationId/messages/:messageId/report`, both in the `TIGHT` class, 201 with only `id`, `status` and `createdAt`): the body is `{ reason, description? }` (`reason` is one of the four enum values, `description` 1-1000 code points). A message report requires the reporter to be an ACTIVE member of that conversation and the message to be in it and not deleted, otherwise 404 (the same answer as for a message that does not exist); your own message or yourself is 400 `VALIDATION_FAILED`; a second OPEN report of the same target by the same reporter is 409 `RESOURCE_CONFLICT`. The text snapshot is written by the same statement that checks membership, so a later edit or delete cannot change it; the snapshot is never returned to the reporter.

**Progress**
- **`PUT /courses/:courseId/lessons/:lessonId/completion`** is 200 (not 201: it is idempotent) with `{ lessonId, completedAt, courseCompleted, progress: { completedLessons, totalLessons, percent } }`. `courseCompleted` is true only in the response of the request whose conditional update wrote `Enrollment.completed_at`; a retry after a lost response therefore reads `false` (the state is visible in the enrollment summary of M11).
- **Who and what**: the route needs `STUDENT_ACTIVE`; a student who is removed at the moment of the request is 403 `FORBIDDEN`; a lesson that does not exist, is in another course or is not PUBLISHED is 404. An ACTIVE student of an archived course may keep marking lessons (marking is the student's own progress, not a content or settings mutation, so `COURSE_ARCHIVED` does not apply); an Admin lock still shuts students out (`COURSE_ADMIN_LOCKED`).
- **Percent** is a whole number, rounded down (a student with an open lesson never shows 100), 0 when no lesson is published, counted over the lessons published now and the completions of lessons published now. `completed_at` is never cleared and is independent of the percent (Decision 12).
- **`recheckEnrollment(tx, id)` / `recheckCourse(tx, courseId)`** run inside the caller's transaction, which must hold the Course lock; they complete only ACTIVE, incomplete enrollments of a course with at least one published lesson whose every published lesson is completed. `recheckAllCourses()` (the nightly sweep) re-checks each course with an ACTIVE incomplete enrollment in its own transaction under Course-S, logs and continues past a course that fails; its schedule is wired in M13. No event is emitted: there is no "course completed" notification type.
- **`ProgressQueries`** (`summaries`, `summary`, `completedLessonIds`) is one SQL statement per call, whatever the number of enrollments; it is what Enrollments (M11) calls for the student and teacher views.

**Notifications**
- **Display snapshot (`data`) per type**: `courseTitle` for every course-related type; `reinstated` (true/false) for `ENROLLMENT_APPROVED`; `lessonId` and `lessonTitle` for `LESSON_PUBLISHED`; `reason` for `COURSE_ADMIN_LOCKED`; empty for the four Teacher types. The actor's name is not in `data`: the list joins it live (`actor: {id, fullName}`, or null for system events and deleted accounts).
- **The person who caused the event is never a recipient** (for example an Admin who is also a teacher of the course they lock). `LESSON_PUBLISHED` has no actor. "All ACTIVE Admins" means users with status ACTIVE and an ACTIVE Admin role. An event about a course that no longer exists writes nothing.
- **Fan-out**: recipients are written in chunks of 500 (one `INSERT … SELECT` per chunk); a chunk that fails is logged and the next chunk still runs (a lost notification is not repaired, as the lost-effect policy says). The push `notification:new` carries the same object as a list item and is best effort.
- **Endpoints**: `GET /me/notifications` (cursor = id of the last item of the previous page, newest first, default 50, at most 100, optional `unread=true`), `GET /me/notifications/unread-count`, `PUT /me/notifications/:id/read` (204, idempotent, keeps the first read time, 404 for another user's or a missing one), `PUT /me/notifications/read-all` (204). There is no endpoint to create or delete one. A cursor that is not the caller's gives an empty page.
- **Retention** (`NotificationRetention.purgeOldRead`) deletes notifications that were **read** more than 90 days ago, measured from `read_at` (not from creation, so a notification read today is never removed at once), in batches of 1000; unread ones are never deleted. A callable method; the schedule is wired in M13.
- **No cron in M9.** The three jobs above (orphan files, completion recheck, notification retention) are callable, tested service methods; `@nestjs/schedule` wiring is M13, as in the roadmap.

## Approval and changes

All values in sections 1–9 were approved by the owner as a set on 2026-10-25 and are used as written. Section 10 was approved on 2026-10-25 after review (Decisions 166 and 167). Section 11 (M7) was approved on 2026-10-26 after review. Section 12 (M8) was approved on 2026-10-26 after review, except the email token lifetime, which stays unresolved until M11a. Section 13 (M9) is **PROPOSED and not yet reviewed**: only its Enrollment lock item was decided (Decision 168, 2026-10-26) and the MinIO item has an owner decision to keep Compose open; none of the other proposals is approved. To change one later: edit the constant, update this file, and add a migration if it is a *SQL CHECK*; record it in `decision.log.md` if it affects the schema or the API contract.
