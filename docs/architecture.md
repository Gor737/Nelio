# Nelio Architecture

> **Scope:** the final approved v1 architecture of Nelio, a web-based Learning Management System.
> **Source of truth:** Decisions 1–164 (all Decided). Historical reasoning and decision history live in `decision.log.md`.
> **Companion files:** `roadmap.md` (implementation order).
> **Verification note:** a few Prisma/PostgreSQL behaviors were stated from memory and are verified during Spikes A and B (M1, M2). Any contradiction is handled through the Change Protocol in `roadmap.md`, never silently.

---

## 1. System Overview

Nelio is a modular-monolith LMS built by one developer. It serves three platform roles (Student, Teacher, Admin). One user may hold several roles, and every user receives `STUDENT` at registration. Teacher requires Admin approval.

**Core capabilities (v1)**
- Courses organized as Course → Section → Lesson → ordered ContentBlocks (text as Markdown, external video, file attachments)
- Per-course enrollment policy: `OPEN`, `APPROVAL_REQUIRED`, `INVITATION_ONLY`
- Per-lesson progress, with a permanent course completion snapshot
- Slack-like chat: DMs, groups, and one auto-created channel per published course
- In-app notifications, user blocking and reporting, Admin moderation, audit log
- Email/password and Google sign-in

**Out of scope for v1:** payments, quizzes/assignments/grading, ratings/reviews, certificates, email notifications, invitations by email, account deletion, session list/device management, hosted video, rich-text editor, fine-grained course permissions.

**Deployment assumption:** a single backend instance, same-site with the frontend (shared registrable domain or reverse proxy).

---

## 2. High-Level Architecture

Browser (Next.js)
│ HTTPS, same-site (shared domain or reverse proxy)
▼
Reverse proxy (TLS, trusted-proxy configuration)
│
▼
┌──────────────────── NestJS modular monolith (1 instance) ────────────────────┐
│ REST /api/v1 guards → pipes → services → exception filter │
│ Socket.IO one connection per client, personal rooms │
│ In memory: presence, throttler counters, socket registry │
│ Scheduled jobs: cleanups, channel reconcile, completion recheck │
└───────┬──────────────────┬──────────────────┬──────────────────┬─────────────┘
▼ ▼ ▼ ▼
PostgreSQL S3 / MinIO SMTP / mail API Google (ID-token
(all state, (file bytes via (verification and signature keys)
source of truth) StorageDriver) reset emails only)



### Source-of-truth principles

| Principle | Meaning |
|---|---|
| PostgreSQL is the source of truth | All durable state lives in it, and the database enforces whatever it can (constraints, FKs, triggers) |
| REST is authoritative for commands and history | Sockets are a delivery channel; a client with no socket still has a working app |
| Events are a courtesy | Every effect can be re-fetched (`seq` catch-up, list reloads) |
| Stored membership is authoritative | `ConversationMember` rows, synchronized in the same transaction as the triggering change |
| Single sources of truth in code | Limits, error codes, permission matrix, notification types, audit actions, rate-limit classes, event contracts |

### Frontend boundary

The backend design is independent of the frontend state library (Redux Toolkit or Zustand is undecided and irrelevant to the backend). The frontend keeps the access token in JS memory only, renders private pages client-side, and uses the public catalog server-side where useful.

---

## 3. Technology Stack

| Area | Technology |
|---|---|
| Runtime / framework | Node.js, NestJS (modular monolith) |
| ORM / database | Prisma (multi-file schema, one file per domain), PostgreSQL |
| API | REST under `/api/v1`, Swagger/OpenAPI |
| Real-time | Socket.IO |
| Authentication | JWT access token (HS256), opaque refresh token, Argon2id, Google ID-token verification |
| Validation | `class-validator`, `class-transformer` |
| Object storage | S3-compatible storage behind a `StorageDriver` interface (MinIO for development) |
| Mail | Transactional auth emails only (Mailpit for development) |
| PostgreSQL features | `pg_trgm` (user-name search), `tsvector` with the `simple` configuration (course search), partial indexes, CHECK constraints, composite FKs, a trigger, enums, advisory locks |
| Tooling | dependency-cruiser (layering enforcement), `@nestjs/schedule` (jobs) |
| Frontend | Next.js |

---

## 4. Backend Module Architecture

### Folder structure

src/
main.ts
app.module.ts
infrastructure/
database/ config/ audit/ mail/ events/ realtime/
common/
guards/ decorators/ access/ filters/ pipes/ constants/
modules/
files/ catalog/ progress/ notifications/ moderation/
users/ auth/ chat/ courses/ content/ enrollments/ admin/
prisma/
schema/ # one .prisma file per domain
migrations/ # includes hand-written SQL
test/
integration/ # real-PostgreSQL tests


Each module is flat:

modules/<name>/
<name>.module.ts
controllers/
services/
dto/ # request DTOs + response DTOs
mappers/ # model → response DTO
queries/ # *.queries.ts for raw or complex SQL
<name>.events.ts # only if the module emits events
index.ts # the public API



### The 12 domains plus infrastructure

| Kind | Items |
|---|---|
| Domain modules (12) | Auth, Users, Courses, Catalog, Content, Files, Enrollments, Progress, Chat, Notifications, Moderation, Admin |
| Infrastructure (not domains) | `database`, `config`, `audit`, `mail`, `events`, `realtime`, and `common` (guards, decorators, `CourseAccessService`, `TokenVerifier`, exception filter, shared constants, pipes) |

### Data-access approach

- Services use Prisma directly. There is **no repository layer**.
- Complex or raw SQL lives in `*.queries.ts` inside the owning module.
- Raw SQL uses parameterized tagged-template queries only.
- Request DTOs per endpoint; **allowlist response DTOs** built by mapper functions. Prisma models are never returned.

---

## 5. Layer 0–3 Architecture

Layer 3 Admin ──► Users, Auth, Courses, Enrollments, Moderation, Chat, Catalog
(orchestration only, owns no tables)

Layer 2 Auth ─────────► Users
Courses ──────► Catalog, Files, Chat
Enrollments ──► Progress, Chat

Layer 1 Users ────────► Files
Chat ─────────► Moderation
Content ──────► Progress, Files

Layer 0 Files Catalog Progress Moderation Notifications
(import no other domain module)

Infrastructure (never imports a domain)
database · config · audit · mail · events · realtime · common



Dependencies point **downward only**. No `forwardRef` anywhere.

### How earlier cycles are resolved

| Former cycle | Resolution |
|---|---|
| Enrollments ↔ Progress, Content ↔ Progress | Progress is a leaf. Enrollments and Content call `CompletionService` inside their own transaction. Progress reads `Enrollment` and `Lesson` tables through Prisma |
| Courses/Enrollments ↔ Chat | Chat exposes the narrow `CourseChannelService`. Chat **reads** `Course` and `CourseTeacher` for archived/moderator checks |
| Chat ↔ Moderation | Moderation exposes `BlockService`. Moderation's report logic **reads** `Message` and `ConversationMember` through Prisma |
| Notifications ← everyone | Producers emit typed events; Notifications listens. No module imports Notifications |
| Users ↔ Courses (revoking a teacher) | Admin orchestrates in one transaction |
| Chat ↔ Realtime, Auth → Realtime | Through events: Realtime emits `socket.connected/disconnected` and listens for `session.revoked` |

---

## 6. Module Responsibilities

| Module | Layer | Writes (owns) | Responsibilities | Public API (`index.ts`) |
|---|---|---|---|---|
| **Files** | 0 | `FileAsset` | Multipart upload, real file-type and size validation, `StorageDriver` (S3/MinIO), signed URLs for attachments, public URLs for avatars/covers, orphan cleanup job | upload, delete, signed URL, `StorageDriver` |
| **Catalog** | 0 | `Category`, `Tag`, `CourseTag` | Category/tag reads, tag normalization and caps | `setCourseTags(tx, …)` |
| **Progress** | 0 | `LessonCompletion`, `Enrollment.completed_at` | Lesson completion, completion recheck, progress queries, nightly full recheck | `CompletionService` (`markComplete`, `recheckEnrollment(tx)`, `recheckCourse(tx)`), `ProgressQueries` |
| **Moderation** | 0 | `Block`, `Report` | Blocks, report creation (with snapshot) | `BlockService` (`isBlockedEitherWay`, `assertCanAdd`), report creation/queue |
| **Notifications** | 0 | `Notification` | Listens to events, chunked bulk insert, list/unread/read, Realtime push, retention job | none |
| **Users** | 1 | `User`, `UserRole` | Profile, user search, teacher application, role decisions, suspension primitives | `createWithStudentRole(tx)`, `setTokensValidAfter(tx)`, application/role/suspension primitives |
| **Content** | 1 | `Section`, `Lesson`, `ContentBlock` | CRUD, full-list reorder, lesson lifecycle, video URL parsing, student/teacher DTOs | `visibleLessonWhere`, lesson status operations |
| **Chat** | 1 | `Conversation`, `DirectConversation`, `ConversationMember`, `Message` | Conversations, membership, messages, unread, presence, gateway, channel sync, nightly reconcile | `CourseChannelService` (`createForCourse`, `addMember`, `endMembership`, `syncCourse`), `MessagesService.send`, `PresenceService` |
| **Auth** | 2 | `RefreshToken`, `AuthIdentity`, `EmailToken` | Registration, login, tokens, Google, verification, reset, sessions, token cleanup | `revokeAllSessions(tx, userId)` |
| **Courses** | 2 | `Course`, `CourseTeacher` | Lifecycle, assistants, ownership transfer, deletion, public catalog/search | lifecycle, team operations, `ownsCourses` |
| **Enrollments** | 2 | `Enrollment`, `Invitation` | Enrollment state machine, invitations, last-visited, student lists | state-machine operations (reinstate, remove, etc.) |
| **Admin** | 3 | none | Orchestration endpoints only; no business rules of its own | none |
| `audit` (infra) | — | `AuditLog` | `AuditWriter.record(tx, entry)`, the only writer of `AuditLog` | — |

**Two documented clarifications**
- Progress also writes `Enrollment.completed_at` (the single cross-module write exception).
- "Last visited lesson" is written by **Enrollments**, not Progress.

---

## 7. Module Dependency Rules

1. **Downward only** (Layer 0 → 3), no cycles.
2. **Public API through `index.ts` only.** Other modules import only a module's `index.ts`, which exports only the intentional API. Never internal files.
3. **Reads may cross modules via Prisma. Writes go only through the owning module's exported service.** Sole exception: Progress writes `Enrollment.completed_at`.
4. **Infrastructure and `common` never import a domain module.**
5. **Domain → infrastructure** imports follow an explicit per-module allow-list (for example `mail` only by Auth, `realtime` only by Chat and Notifications, `audit` only by modules that write audited actions).
6. **Gateways and controllers never touch Prisma** or the database service.
7. **Shared visibility conditions are defined once:** the Content module's `visibleLessonWhere` is reused by every module that reads lessons.
8. **Cross-module side effects:** consistency-critical effects use direct service calls inside the caller's transaction; harmless side effects (notifications, pushes) use events emitted after commit.

Enforcement: dependency-cruiser, run in CI, with two separate rule sets (domain-to-domain layering; domain-to-infrastructure allow-list). Rule tests use deliberately violating fixtures.

### Database ownership summary

Each of the 25 tables has exactly one writing module (see Section 6). Other modules may read it through Prisma. Admin writes none and calls owners' services.

---

## 8. Database Architecture

### Conventions

| Convention | Rule |
|---|---|
| Primary keys | UUID v7 (generation mechanism confirmed in Spike A) |
| Timestamps | `timestamptz`; `created_at` and `updated_at` on every table unless noted (append-only tables omit `updated_at`) |
| Fixed value sets | PostgreSQL enums |
| Lifecycle state | Status columns; `deleted_at` only where history requires it (Message) |
| Hard integrity | CHECK constraints, partial indexes, composite FKs, trigger, in hand-written SQL appended to `--create-only` migrations |

### Delete-behavior principle

`RESTRICT` by default. `CASCADE` only for owned or disposable data. `SET NULL` only for convenience pointers. Paired "who and when" columns are always `RESTRICT`.

| Behavior | Where |
|---|---|
| **RESTRICT** | Everything with business meaning: `Enrollment→Course/User`, `Invitation→Course`, `LessonCompletion→Enrollment/Lesson`, `Lesson→Section`, `Message→Conversation`, `Conversation→Course`, `Report→Message/users`, `AuditLog→User`, all "who and when" pairs, all `FileAsset` references, `Course→Category` |
| **CASCADE** | Credentials (`RefreshToken`, `AuthIdentity`, `EmailToken`), `Notification→User/Course`, `Block→User`, `CourseTag`, `CourseTeacher→Course`, `Section→Course`, `ContentBlock→Lesson`, `DirectConversation` and `ConversationMember→Conversation` |
| **SET NULL** | `Enrollment.last_visited_lesson_id`, `Notification.actor_id` |

### Deletion rules for core entities

- **Users are never deleted** (suspension only).
- **Course:** permanently deletable only if `first_published_at IS NULL`, in one transaction (lessons, then sections, then course). FK `RESTRICT` backstops (Enrollment, Invitation, Conversation) catch bugs.
- **Lesson:** no `deleted_at`; `ARCHIVED` is the soft state. Permanently deletable only if not published and never completed (FK `RESTRICT`).
- **Messages:** soft-deleted; text kept permanently for moderation evidence; the API hides it.

### ER-style diagram

USERS & AUTH
User 1──N UserRole (role enum, status, application)
User 1──N RefreshToken (family_id, used_at)
User 1──N AuthIdentity (Google sub)
User 1──N EmailToken
User N──0..1 FileAsset (avatar)

COURSES & CATALOG
Category 1──N Course
Course N──M Tag via CourseTag
User N──M Course via CourseTeacher (OWNER | ASSISTANT)
Course N──0..1 FileAsset (cover)

CONTENT
Course 1──N Section 1──N Lesson 1──N ContentBlock ──0..1 FileAsset
Lesson.(section_id, course_id) ──► Section.(id, course_id) composite FK

LEARNING
User N──M Course via Enrollment (status, completed_at)
Course 1──N Invitation N──1 User (invitee), User (inviter)
Enrollment 1──N LessonCompletion N──1 Lesson
both composite FKs share course_id → same-course guarantee
Enrollment N──0..1 Lesson (last visited, SET NULL)

CHAT
Course 1──0..1 Conversation (COURSE_CHANNEL)
Conversation 1──0..1 DirectConversation (ordered pair a < b)
Conversation 1──N ConversationMember N──1 User
Conversation 1──N Message
Message.(conversation_id, sender_id) ──► ConversationMember composite FK

PLATFORM
User N──M User via Block (directional)
Report N──1 User (reporter), N──0..1 Message, N──0..1 User (target)
User 1──N Notification; AuditLog (actor FK, loose target)



### Relationship types

| Kind | Relationships |
|---|---|
| N:M with data | `UserRole`, `CourseTeacher`, `Enrollment`, `ConversationMember`, `LessonCompletion` |
| N:M plain | `CourseTag`, `Block` (self-referencing, directional) |
| 1:N | Course → Section → Lesson → ContentBlock; Conversation → Message; User → RefreshToken/AuthIdentity/EmailToken/Notification; Category → Course |
| 1:0..1 | Course → Conversation (channel); Conversation → DirectConversation |

---

## 9. All 25 Database Entities

`?` = nullable. All keys are UUID v7. Every table has `created_at` (and `updated_at` unless noted).

### Users and Auth (5)

| Entity | Columns |
|---|---|
| `User` | id, email (unique, lowercased in code), password_hash?, full_name, avatar_file_id?, status (ACTIVE/SUSPENDED), suspended_at?, email_verified_at?, tokens_valid_after?, last_seen_at? |
| `UserRole` | PK (user_id, role STUDENT/TEACHER/ADMIN), status (PENDING/ACTIVE/REJECTED/REVOKED), application_message?, decision_note?, decided_by?, decided_at? |
| `RefreshToken` | id, user_id, token_hash (unique), family_id, family_started_at, expires_at, used_at?, revoked_at?, created_at |
| `AuthIdentity` | id, user_id, provider (GOOGLE), provider_account_id, provider_email?, created_at, last_used_at? |
| `EmailToken` | id, user_id, type (EMAIL_VERIFICATION/PASSWORD_RESET), token_hash (unique), expires_at, used_at?, created_at |

### Courses, Catalog, Files (6)

| Entity | Columns |
|---|---|
| `Course` | id, title, summary?, description?, cover_file_id?, category_id?, status (DRAFT/PUBLISHED/ARCHIVED), enrollment_policy (OPEN/APPROVAL_REQUIRED/INVITATION_ONLY), first_published_at?, archived_at?, locked_by_admin_at?, search_vector (generated) |
| `CourseTeacher` | PK (course_id, user_id), role (OWNER/ASSISTANT), added_by, created_at |
| `Category` | id, name, slug (unique) |
| `Tag` | id, name, slug (unique), created_at |
| `CourseTag` | PK (course_id, tag_id), created_at |
| `FileAsset` | id, uploaded_by, kind (AVATAR/COURSE_COVER/LESSON_ATTACHMENT), storage_key (unique), original_name, mime_type, size_bytes, created_at |

### Content (3)

| Entity | Columns |
|---|---|
| `Section` | id (+ unique (id, course_id)), course_id, title, position |
| `Lesson` | id (+ unique (id, course_id)), course_id, section_id, title, position, status (DRAFT/PUBLISHED/ARCHIVED), first_published_at? |
| `ContentBlock` | id, lesson_id, position, type (TEXT/VIDEO/FILE), text_body?, video_provider? (YOUTUBE/VIMEO), video_external_id?, file_id? (unique) |

### Learning (3)

| Entity | Columns |
|---|---|
| `Enrollment` | id (+ unique (id, course_id)), course_id, user_id, status (PENDING/ACTIVE/LEFT/REJECTED/REMOVED), decided_by?, decided_at?, first_activated_at?, left_at?, last_visited_lesson_id?, last_visited_at?, completed_at? |
| `Invitation` | id, course_id, invited_user_id, invited_by, status (PENDING/ACCEPTED/DECLINED/REVOKED), expires_at, responded_at? |
| `LessonCompletion` | PK (enrollment_id, lesson_id), course_id, completed_at (no `updated_at`) |

### Platform (4)

| Entity | Columns |
|---|---|
| `Notification` | id, user_id, type (12 values), course_id?, actor_id?, data jsonb, read_at?, created_at |
| `Block` | PK (blocker_id, blocked_id), created_at |
| `Report` | id, reporter_id, target_type (MESSAGE/USER), message_id?, target_user_id?, reason (SPAM/HARASSMENT/INAPPROPRIATE/OTHER), description?, message_snapshot?, status (OPEN/DISMISSED/ACTIONED), reviewed_by?, reviewed_at?, resolution_note?, created_at |
| `AuditLog` | id, actor_id, action (text, validated against code constants), target_type, target_id (loose, no FK), metadata jsonb, created_at (immutable) |

### Chat (4)

| Entity | Columns |
|---|---|
| `Conversation` | id, type (DIRECT/GROUP/COURSE_CHANNEL), title?, course_id? (unique), created_by?, last_seq, last_message_at? |
| `DirectConversation` | conversation_id (PK), user_a_id, user_b_id (unique pair, CHECK a < b) |
| `ConversationMember` | PK (conversation_id, user_id), role (MEMBER/ADMIN), joined_at, left_at?, last_read_seq, is_muted |
| `Message` | id, conversation_id, seq, sender_id, body, client_id, edited_at?, deleted_at?, deleted_by? (no `updated_at`) |

### Key integrity mechanisms

**Unique constraints:** `User.email`; `AuthIdentity (provider, provider_account_id)` and `(user_id, provider)`; `RefreshToken.token_hash`; `EmailToken.token_hash`; `Category.slug`; `Tag.slug`; `FileAsset.storage_key`; `Enrollment (course_id, user_id)`; `Invitation (course_id, invited_user_id)`; `ContentBlock.file_id`; `Conversation.course_id`; `DirectConversation (user_a_id, user_b_id)`; `Message (conversation_id, seq)` and `(sender_id, client_id)`; composite FK targets `Section (id, course_id)`, `Lesson (id, course_id)`, `Enrollment (id, course_id)`.

**Composite FKs:** `Lesson→Section`; `LessonCompletion→Enrollment` and `→Lesson` (shared `course_id`, guaranteeing same-course); `Message→ConversationMember`.

**CHECK constraints:**
- Course: published requires category and summary; non-draft requires `first_published_at`; `locked_by_admin_at IS NULL OR status = 'ARCHIVED'`
- Lesson published requires `first_published_at`
- ContentBlock columns match `type`
- Message body length; `deleted_at`/`deleted_by` pairing
- `decided_by`/`decided_at` pairing on `UserRole`, `Enrollment`, and `Report.reviewed_*`
- `Block`: `blocker_id <> blocked_id`
- `Report`: exactly one target, matching `target_type`
- `Conversation` type/`course_id`/title rules; `DirectConversation` `a < b`
- `Enrollment.completed_at` implies `first_activated_at`
- `RefreshToken.expires_at <= family_started_at + 90 days`
- `FileAsset.size_bytes > 0`; title/length limits from shared constants

**Partial indexes:** one `OWNER` per course (unique); open-report duplicates (message and user variants, unique); published lessons per course; `Enrollment` active-and-incomplete per course; unread notifications per user; active `ConversationMember` per user; partial FK child indexes (`Course.cover_file_id`, `User.avatar_file_id`, `Enrollment.last_visited_lesson_id`).

**Other indexes:** Course `(status, first_published_at DESC)`, `category_id`, GIN on `search_vector`; trigram GIN on `User.full_name`; `CourseTeacher(user_id)`; `CourseTag(tag_id)`; `Section(course_id, position)`; `Lesson(section_id, position)`; `UserRole(role, status)`; `Enrollment(course_id, status)` and `(user_id, status)`; `LessonCompletion(lesson_id, course_id)`; `Notification(user_id, created_at DESC)` and `(course_id)`; `Block(blocked_id)`; `Report(status, created_at)`, `(message_id)`, `(target_user_id)`; `AuditLog (target_type, target_id, created_at)`, `(actor_id, created_at)`, `(action, created_at)`; `RefreshToken(user_id)` and `(family_id)`; `EmailToken(user_id, type)`; `Invitation(invited_user_id)`; `ContentBlock.file_id`.

**Trigger and extensions:** `AuditLog` rejects UPDATE and DELETE; `pg_trgm`; generated `tsvector` with the `simple` configuration.

### Rules the database cannot enforce (service layer, covered by tests)

No return to `DRAFT` once enrollments exist; teacher/student exclusion per course; transfer-before-revocation/suspension; completion triggers; channel membership sync; block checks for DMs and group adds; group cap and last-admin promotion; "every user has a login method"; lesson completion requires a published lesson and an `ACTIVE` enrollment; `last_visited_lesson_id` belongs to the same course; a DM has exactly two members; `INVITATION_ONLY` visibility (404 not 403).

### Derived, never stored

Progress percentage is computed on read in a single SQL statement. Unread counts are computed from `seq` and `last_read_seq`. Invitation expiry is derived from `expires_at`.

---

## 10. Migration Groups G1–G5

Table order is not module order (Layer-0 modules own tables that reference higher-layer tables), so the schema is built in five dependency-ordered groups before modules are implemented.

| Group | Tables | Notes |
|---|---|---|
| **G1** (8) | `User`, `UserRole`, `RefreshToken`, `AuthIdentity`, `EmailToken`, `FileAsset`, `AuditLog`, `Block` | `User ↔ FileAsset` is circular; both created in one migration. Includes `pg_trgm`, audit trigger |
| **G2** (6) | `Category`, `Tag`, `Course`, `CourseTeacher`, `CourseTag`, `Notification` | Course CHECKs, `search_vector`, one-OWNER partial unique index |
| **G3** (3) | `Section`, `Lesson`, `ContentBlock` | `(id, course_id)` unique targets, composite FK `Lesson→Section` |
| **G4** (3) | `Enrollment`, `Invitation`, `LessonCompletion` | Same-course composite FKs |
| **G5** (5) | `Conversation`, `DirectConversation`, `ConversationMember`, `Message`, `Report` | Order inside G5: `ConversationMember` → `Message` → `Report` |

Migration workflow: change the Prisma schema, create the migration with `--create-only`, append hand-written SQL (CHECKs, partial indexes, trigger, `tsvector`), read the generated SQL for unexpected `DROP INDEX`, apply. Every hand-written object is covered by a real-PostgreSQL test, so a later migration that drops one fails the suite.

---

## 11. Authentication Architecture

### Token model

| | Access token | Refresh token |
|---|---|---|
| Format | JWT, HS256 (algorithm pinned), claims `sub`, `iat`, `exp` only | Opaque 256-bit random value |
| Lifetime | 15 minutes | 30-day sliding idle, 90-day absolute per family |
| Storage (server) | None | SHA-256 hash in `RefreshToken` |
| Storage (client) | JS memory only | `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth` cookie |

### Flow

Register POST /auth/register ─► 202 (always) ─► email: verify link / “already registered”
Verify frontend page posts token ─► POST /auth/verify-email ─► 204 (does not log in)
Login POST /auth/login ─► access JWT (body) + refresh cookie
Google frontend obtains ID token ─► POST /auth/google ─► four sign-in rules ─► same response as login
Request Authorization: Bearer ─► guard: verify JWT ─► load user + roles ─► suspended?
─► iat < tokens_valid_after? ─► attach ACTIVE roles only
Refresh POST /auth/refresh (cookie) ─► rotate; family reuse detection; ~10 s grace → 409;
reuse after grace ─► revoke whole family; 30 d sliding, 90 d absolute
Logout /auth/logout (this device), /auth/logout-all (revokeAllSessions)
Reset forgot-password (202) ─► link ─► reset-password: new hash, email verified,
all sessions revoked, tokens_valid_after set
Suspend Admin tx: status + Assistant rows + revokeAllSessions ─► after commit: session:revoked



### Auth endpoints

`register`, `verify-email`, `resend-verification`, `login`, `google`, `refresh`, `logout`, `logout-all`, `forgot-password`, `reset-password`, `change-password`, `google/link`, `DELETE /auth/google`. Registration, resend, and forgot-password always answer 202. `login` returns tokens only; the frontend then calls `GET /me`.

### Guard algorithm (decision 108 final form)

1. Verify the JWT (signature, pinned HS256, `exp`) → else 401 `UNAUTHENTICATED`
2. Load user and roles in one query → 401 if user missing
3. `SUSPENDED` → 403 `ACCOUNT_SUSPENDED`
4. Reject if `iat` (whole seconds) is earlier than `tokens_valid_after` → 401
5. Attach `AuthenticatedUser { id, activeRoles }` containing only `ACTIVE` role rows

Optional-auth endpoints: no token means anonymous; an invalid or expired token is a 401. The guard lives in `common` and uses a `TokenVerifier`; Auth owns the `TokenIssuer`. Both read secret and algorithm from validated config.

### Key rules

- **Passwords:** Argon2id (OWASP parameters verified at implementation), length 10–128, common-password check, no composition rules, dummy hash for unknown emails, throttle before hashing, no rehash in v1.
- **Email tokens** (verification 24 h, reset 1 h): hashed, single-use via conditional update, consumed by POST only, newest-token cooldown (60 s).
- **Registration:** unverified re-registration replaces the password; verified accounts are unchanged and receive an "already registered" email. Password users must verify email before login.
- **Google:** frontend-supplied ID token verified (signature, audience, issuer, expiry, `email_verified`); the four sign-in rules (match by `sub`; link to existing verified-email user, clearing the password of an unverified account; create new; reject unverified Google email). Match on `sub`, never email. No Google tokens stored. A login method must remain (`NO_LOGIN_METHOD_REMAINING`).
- **Revocation:** `revokeAllSessions(tx, userId)` revokes refresh tokens and sets `tokens_valid_after`, inside the caller's transaction. Used by suspension, password reset, and logout-all. Change-password revokes other sessions but keeps the current device's family. Teacher revocation does not revoke sessions.
- **No account lockout** in v1. Throttling keys: IP plus submitted email on sensitive endpoints.
- **First Admin:** created by an environment-based seed script (email marked verified, runs only if no Admin exists). Later Admins via `PUT /admin/users/:id/admin-role`. Registration can never choose a role.

---

## 12. Authorization Architecture

| Level | Question | Mechanism |
|---|---|---|
| 0. Authentication | Who, and may they exist? | Global JWT guard, secure by default; `@Public()` and optional-auth variant |
| 1. Platform role | Active Teacher or Admin? | `@Roles()` over `ACTIVE` role rows → `TEACHER_NOT_APPROVED` / `FORBIDDEN` |
| 2. Course relationship | What is this user to this course? | `CourseAccessService` + `@CourseRole()` |
| 3. Resource state | Is the action valid right now? | Service layer, inside the transaction |

Guards answer "who", pipes answer "is the shape right", services answer "is this allowed right now".

### Course relationships

`CourseAccessService` (in `common`, reads `Course`, `CourseTeacher`, `Enrollment`, `Invitation`, imports no domain module) returns one of:

`OWNER`, `ASSISTANT`, `STUDENT_ACTIVE`, `STUDENT_PENDING`, `STUDENT_LEFT`, `REMOVED`, `REJECTED`, `INVITEE`, `NONE`

combined with course status, enrollment policy, and `locked_by_admin_at`.

### Visibility and access rules

- **404** when the caller may not know the course exists; **403** when they can see it but lack the role.
- `DRAFT`: teachers only. `ARCHIVED`: teachers and students with `ACTIVE` or `LEFT` enrollment. `INVITATION_ONLY`: invitees, students, teachers, Admins; others get 404. A `REMOVED` student keeps no access merely because they were enrolled before.
- Public catalog lists only `PUBLISHED` courses with `OPEN` or `APPROVAL_REQUIRED`; visitors see syllabus titles (published lessons only), never content.
- **Lesson content:** teachers see all statuses; `ACTIVE` students see `PUBLISHED` lessons only (also on archived courses); `LEFT`, pending, and others get no content. Non-published lessons are 404 for students.
- **Admin-locked courses:** anonymous, never-enrolled, rejected, invitee, removed → 404; `ACTIVE`/`LEFT`/`PENDING` students → 403 `COURSE_ADMIN_LOCKED`; Owner/Assistants keep management visibility; Admins use `/admin`. Enrollment state and progress are unchanged and the channel stays read-only.

### Roles and permissions

- Platform roles: `STUDENT`, `TEACHER` (needs Admin approval), `ADMIN`; cumulative.
- Course roles: fixed `OWNER` (exactly one) and `ASSISTANT`. No fine-grained permissions, no policy library.
- Owner: settings, policy, tags, publish/archive/delete, assistants, ownership transfer, remove/reinstate students. Assistant: content, approve/reject requests, view students and progress, invite; cannot remove students, change settings, manage teachers, or archive/delete.
- A user cannot be a course teacher and an `ACTIVE`/`PENDING` student of the same course.
- **Admins act only through `/admin/*`** and are ordinary users elsewhere.

### Status-code test and check order

| Status | Meaning |
|---|---|
| 400 | Request wrong regardless of data |
| 403 | Caller not entitled; retrying helps only if standing changes |
| 404 | Caller may not know the thing exists, or id is not part of the URL's course |
| 409 | Caller entitled, but current data conflicts |
| 413 / 415 | File too large / type not allowed |

Check order (first failure wins): `429 → 401 → 403 ACCOUNT_SUSPENDED → guards (404 visibility, 403 lock gate, 403 role) → 400 input shape → service state checks (409)`. `COURSE_ADMIN_LOCKED` is 403 when a student is shut out, 409 when a teacher mutation is refused (and takes precedence over `COURSE_ARCHIVED`).

---

## 13. REST API Architecture

### Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1`, no versioning system |
| Resources | Plural, kebab-case, course-scoped routes under `/courses/:courseId/...` |
| IDs | UUIDs validated by a pipe (malformed → 400) |
| State changes | Action endpoints (`POST …/publish`), not generic status patches |
| Pagination | Offset (`page`, `pageSize`, max 50) for catalog/admin lists; cursor for messages (`seq`), notifications, audit log |
| Filters/sorting | Whitelisted query parameters only |
| Errors | `{ statusCode, code, message, errors? }` with stable machine-readable `code` from a single registry |
| `/me` routes | `/me`, `/me/enrollments`, `/me/teaching/courses`, `/me/invitations`, `/me/blocks`, `/me/notifications`, `/me/conversations`, `/me/presence` |
| Responses | Allowlist response DTOs; email only in `/me` and Admin endpoints |
| Docs | Swagger/OpenAPI generated from DTOs, listing error codes per endpoint |

### Endpoint groups

| Group | Endpoints (abbreviated) |
|---|---|
| Auth | `/auth/` register, verify-email, resend-verification, login, google, refresh, logout, logout-all, forgot-password, reset-password, change-password, google/link; `DELETE /auth/google` |
| Me / Users | `GET/PATCH /me`; `GET/POST /me/teacher-application`; `GET /users?q=` (login required, ≥2 chars, ≤20 results, no pagination, safe fields only); `GET /users/:id`; `POST /users/:id/report`; `/me/blocks`; `/me/notifications` (list, unread-count, `PUT …/read`, `read-all`); `GET /me/presence` |
| Catalog | `GET /categories`, `GET /tags` |
| Courses | `GET /courses`, `/:id`, `/:id/syllabus`, `/:id/teachers`, `/:id/channel`; `POST /courses`; `PATCH`; `PUT …/tags`; `POST …/publish`, `archive`, `restore`; `DELETE` (no unpublish-to-draft endpoint) |
| Course team | `POST …/assistants`; `DELETE …/assistants/:userId`; `POST …/assistants/me/leave`; `POST …/ownership-transfer` |
| Content | `GET …/outline`; sections (create, patch, `reorder`, delete); lessons (create, patch, `move`, `reorder`, get, `publish`, `unpublish`, `archive`, delete); blocks (create, patch, delete, `reorder`, `GET …/download`) |
| Files | `POST /files` (multipart through the API server), `DELETE /files/:id` |
| Enrollment (student) | `POST …/enrollments`; `GET …/enrollments/me`; `POST …/enrollments/me/leave`; `PUT …/enrollments/me/last-visited`; `PUT …/lessons/:id/completion` (idempotent, no un-complete) |
| Enrollment (teacher) | `GET …/students`, `…/students/:userId/progress`; `POST …/students/:userId/` approve, reject, remove, reinstate |
| Invitations | `POST/GET …/invitations`; `POST …/invitations/:id/revoke`; `GET /me/invitations`; `POST /me/invitations/:id/accept` and `decline` |
| Chat | `POST /conversations/direct`, `/groups`; `GET/PATCH /conversations/:id`; members (list, add, remove, role); `leave`; `PATCH …/membership`; messages (history, send, edit, delete); `PUT …/read`; `POST …/messages/:id/report` |
| Admin | users (list, get, suspend, unsuspend, revoke-teacher, admin-role); teacher-applications; courses (list, get, outline, lesson review, `lock`, `unlock`, `restore`, ownership-transfer, student remove/reinstate); categories and tags (CRUD, merge); reports (list, get, `context`, dismiss, action); `audit-logs`; `stats` |
| Infra | `GET /health`, Swagger |

### REST versus WebSocket responsibilities

| Operation | REST | Socket |
|---|---|---|
| Create DM/group, member changes, rename, leave | ✓ commands | server → client events only |
| Load history, catch up after reconnect | ✓ (`seq` cursors) | – |
| Send a message | ✓ fallback | ✓ primary (`message:send` with acknowledgement); both call `MessagesService.send` |
| Edit / delete a message | ✓ command | server → client events |
| Mark read | ✓ (debounced by client) | – (`conversation:read` event to own devices) |
| Receive new messages, notifications | – | ✓ server → client |
| Presence, typing | `GET /me/presence` for initial state | ✓ |

### Rate-limit classes

**Strict** (login, registration, forgot-password, resend-verification), **Tight** (user search, DM/group creation, uploads, reports, teacher application, invitations), **Per-conversation burst** (message send, typing), **Default**. A global throttler runs before authentication.

---

## 14. WebSocket / Socket.IO Architecture

One Socket.IO connection per client. Every socket joins a personal room `user:{id}`. **There are no per-conversation rooms in v1.**

Client ──auth{token}──► Handshake (Origin check + same checks as HTTP guard)
│
▼
personal room user:{id}
│
message:send ─► ChatGateway (thin) ─► MessagesService.send ─► commit
│ │
│ read CURRENT members from DB
▼ ▼
ack {ok,…} emit to each member’s user:{id}




### Events

| Direction | Events |
|---|---|
| Client → server | `message:send` (ack `{ok, message}` or `{ok:false, code}` using REST error codes), `typing:start`, `typing:stop`, `presence:subscribe` |
| Server → client | `message:new`, `message:edited`, `message:deleted`, `conversation:updated`, `conversation:added`, `conversation:removed`, `conversation:read` (own devices), `presence:update`, `typing`, `notification:new`, `session:revoked` |

Payloads are built by the same mappers as REST and never contain data the recipient couldn't get via REST. Membership-change events go directly to the affected user.

### Lifecycle rules

1. **Handshake:** token in the auth payload (never the URL), Origin check, then signature, user exists, not suspended, `tokens_valid_after`.
2. **Per event:** re-check the user is active, validate the DTO, call the same service REST uses. Gateways never touch Prisma and hold no business rules.
3. **Delivery:** commit → read current members (suspended skipped) → emit per member. Recipients are always computed from the database.
4. **Presence:** in memory, multi-socket; online while any socket is connected; ~5 s offline debounce; shared only between DM and group peers (never in course channels); blocked pairs excluded; `last_seen_at` written on last disconnect and never exposed.
5. **Typing:** DMs and groups only, in memory, client-throttled, server rate-limited, ~5 s expiry, membership checked per event.
6. **Recovery by pull:** clients detect `seq` gaps and call `GET …/messages?after=`; they reload `/me/conversations` and notifications on reconnect and refresh the access token before reconnecting. No server-side buffering, no Socket.IO connection state recovery.
7. **Suspension / logout-everywhere:** after commit, emit `session:revoked`, then disconnect all of the user's sockets. Known limit: a single-device logout does not close that device's open socket.
8. **Ordering:** clients sort by `seq`; order is a display rule, not a delivery guarantee.

### Placement

| Piece | Location |
|---|---|
| Socket server, handshake, personal room, registry, `emitToUser(s)`, `disconnectUser` | `infrastructure/realtime` (imports no domain) |
| `ChatGateway`, `PresenceService`, recipient computation | Chat module |
| Notification push | Notifications module |
| `session.revoked` handling | Realtime listens to the event; emitted by Auth after commit |

---

## 15. Transaction and Concurrency Architecture

### Strategy

READ COMMITTED plus four explicit tools:

| Tool | Use |
|---|---|
| 1. Unique constraint | "At most one of X" (channel, DM pair, `(sender_id, client_id)`, one Owner) |
| 2. Conditional update | State change from a known state; check row count |
| 3. Row lock | Rules spanning rows/tables (`FOR SHARE` = S, `FOR NO KEY UPDATE` = X) |
| 4. Advisory lock | Rules about a set (`ADMIN-SET` for last-Admin protection) |

### Transaction rules

- The **entry service owns the transaction** and passes `tx` explicitly to cross-module methods (no ambient transaction).
- **Read state after acquiring the lock**, never before.
- **No hashing, token verification, S3, or mail inside a transaction.**
- Keep transactions short with an explicit timeout.
- A database error aborts the whole transaction: **unique violations are handled outside** the failed transaction (rollback, then re-query and return the existing row).
- `runInTransaction`: bounded retry on deadlock/serialization errors (`40P01`, `40001`). `lockRow(tx, table, id, mode)`: parameterized, restricted to a **whitelisted table enum**.
- Single-statement reads for progress summaries.

### Course row as shared/exclusive mutex

| Mode | Taken by |
|---|---|
| **Course-S** | Enroll, approve, accept invitation, reinstate, mark lesson complete, create invitation |
| **Course-X** | Publish, archive, restore, Admin lock/unlock/restore, delete course, add/remove Assistant, ownership transfer, lesson publish/unpublish/archive, section reorder/append, channel reconcile |

`NO KEY UPDATE` is used for X so ordinary FK inserts (for example an Enrollment referencing the course) are not blocked.

### Global lock order


0. ADMIN-SET advisory lock (operations that can shrink the Admin set)
1. User rows (ascending id)
2. Course row
3. Conversation row(s) (ascending id)
4. Child rows Section (asc id) → Lesson → Enrollment → ConversationMember
5. Moderation: Message before Report (asc id)



### Teacher eligibility

Anything making a user an Owner/Assistant (create course, add Assistant, transfer ownership) takes **User-S** on that user, then checks "active Teacher". Revocation and suspension take **User-X**, then check "owns any course". The two exclude each other.

### Transaction catalog (summary)

| Operation | Locks and key steps |
|---|---|
| Register / Google first sign-in | Hash/verify outside; insert `User` + `STUDENT` role; unique violation → rollback, re-lookup |
| Refresh rotation | Conditional `used_at`; lost race → 409; reuse → commit family revocation, then throw 401 |
| Email-token consume | Conditional update; 0 rows → `TOKEN_INVALID` |
| Publish (first) | C-X; checks; set status; create channel and Owner/Assistant members; audit |
| Enroll / approve / accept invitation / reinstate | C-S, Enrollment row; transition; channel membership upsert; `recheckEnrollment`; audit where applicable |
| Mark lesson complete | C-S, Enrollment `FOR SHARE`; insert-or-ignore; conditional `completed_at` update |
| Lesson publish/unpublish/archive | C-X, Lesson; conditional status change; `recheckCourse` on unpublish/archive |
| Add Assistant / ownership transfer | User-S (target), C-X; re-read Owner after lock; **demote old Owner first, then promote** |
| Revoke teacher / suspend | User-X, C-X per assisted course; ownership check; remove Assistant rows; `revokeAllSessions`; audit |
| Grant/revoke Admin | `ADMIN-SET`; count after lock |
| Send message | Conversation row via `last_seq + 1`, own member row `FOR SHARE`; insert; duplicate `clientId` rolls back (no `seq` gap), caller reloads the original |
| Add group member / leave | Conversation-X; count after lock (cap 50); last-admin promotion (smallest `joined_at`, ties by `user_id`) |
| Resolve report | Message-X, then sibling Reports ascending; delete message; close siblings; audit |
| Delete never-published course | C-X; lessons, then sections, then course |
| Leave / remove student | Enrollment row; conditional transition; end channel membership (allowed in any course status) |

**The Enrollment row is the per-student mutex:** every transition is a conditional update, and it is always the first student-specific row touched, before channel membership.

### Completion architecture

Completion is a permanent `Enrollment.completed_at` snapshot plus a live percentage computed on read. Automatic only; requires at least one published lesson; evaluated for `ACTIVE` enrollments. Triggers: student marks a lesson, teacher unpublishes/archives a lesson, enrollment becomes `ACTIVE` (approve, accept, reinstate, return). Serialization (Course-S vs Course-X) prevents a stuck completion; a conditional update (`WHERE completed_at IS NULL`) gives one winner; `courseCompleted` in the API comes from that update's row count.

### Accepted races

A message sent at the instant of a block or archive; a content edit beside an archive or Admin lock; a publish racing the unpublish of the last published lesson (completion already guards zero published lessons); tag merge vs tag assignment (FK error → 409, retry); a report snapshot vs a concurrent edit; two tabs opening the same invitation.

---

## 16. File and Storage Architecture

Client ──multipart──► POST /files (NestJS) ──► validate size + real file type
│
├─► StorageDriver (S3 / MinIO) bytes
└─► FileAsset row metadata only



- Files are uploaded **through the API server** (direct-to-S3 presigned upload is deferred).
- The database stores metadata and a server-generated `storage_key` only, never bytes. Original names are display-only and never part of the key.
- Validation: size per `kind`, **real file type** (not the client `Content-Type`), executables rejected. Errors: 413 `FILE_TOO_LARGE`, 415 `FILE_TYPE_NOT_ALLOWED`.
- Kinds: `AVATAR`, `COURSE_COVER`, `LESSON_ATTACHMENT`. Cover and attachment uploads require an `ACTIVE` Teacher.
- **No polymorphic owner columns:** owners point to the file (`User.avatar_file_id`, `Course.cover_file_id`, `ContentBlock.file_id`), all `RESTRICT`.
- **Access:** avatars and covers are public URLs; attachments are served only via short-lived signed URLs from `GET …/blocks/:blockId/download` (JSON `{ url, expiresAt }`), with access re-checked on every request.
- **Ordering:** upload = storage then metadata (best-effort cleanup on failure); delete = database row first, storage second.
- **Orphan cleanup job:** deletes files older than 24 h and unreferenced across the three referencing tables; the FK `RESTRICT` makes it lose cleanly against a concurrent attach.
- `StorageDriver` is an interface inside the Files module only, so no other module knows whether storage is S3 or MinIO.
- Videos are external only (YouTube/Vimeo): the server parses the URL, stores provider plus external id, and builds the embed URL itself.

---

## 17. Event / After-Commit Architecture

### Principles

- Consistency-critical effects (channel membership sync, completion rechecks, audit rows, session revocation) are direct calls **inside the transaction**.
- Side effects (notifications, pushes, disconnects) are **typed events emitted only after commit**, never inside the transaction, never after rollback.
- Event contracts (names and payloads) live in `infrastructure/events`; producers and listeners import only the contract.

### Flow

Entry service: runInTransaction ─► writes + audit ─► COMMIT
│
▼
emit event (typed contract)
┌────────────┬───────────────┬──────────┐
▼ ▼ ▼ ▼
Notifications Chat listener Realtime (others)
bulk insert computes disconnects
+ push members, emits on session.revoked



### Notification catalog (12 types)

`TEACHER_APPLICATION_RECEIVED` (all active Admins), `TEACHER_APPLICATION_APPROVED`, `TEACHER_APPLICATION_REJECTED`, `TEACHER_ROLE_REVOKED`, `ENROLLMENT_REQUESTED` (Owner and Assistants), `ENROLLMENT_APPROVED` (also used for reinstatement), `ENROLLMENT_REJECTED`, `REMOVED_FROM_COURSE`, `INVITATION_RECEIVED`, `LESSON_PUBLISHED` (first publish only, active students), `OWNERSHIP_TRANSFERRED`, `COURSE_ADMIN_LOCKED` (Owner and Assistants, reason in `data`).

Chat messages are never notification rows; unread uses read positions. Notification = type + optional `course_id`/`actor_id` + JSON display snapshot. Fan-out is chunked bulk insert (~500). Read notifications are deleted after ~90 days.

### Lost-effect policy

| Effect | If lost | Repair |
|---|---|---|
| `message:new` push | Not seen live | `seq` gap detection and catch-up |
| `conversation:added/removed` | Stale list | Reload on reconnect; REST returns 404 for a removed member |
| `notification:new` push | No live badge | Row is saved; list reloads |
| Notification row not written | User not informed | Not repaired (every event has a visible state elsewhere) |
| `session:revoked` / disconnect | Socket lingers | Per-event re-check rejects the next event; tokens already revoked |
| Verification/reset email | Not received | Resend |

### Safety-net jobs (nightly, single instance, log when they repair)

Channel reconcile (Chat), full completion recheck (Progress). Cleanup jobs: expired tokens (Auth), orphan files (Files), notification retention (Notifications). Scheduled with `@nestjs/schedule`; safe only because v1 runs one instance. Not exposed as Admin endpoints.

### Channel membership sync

Course-channel membership (Owner, Assistants, `ACTIVE` students) is stored in `ConversationMember` and changes **in the same transaction** as the triggering change (enrollment transitions, Assistant add/remove, first publish). `CourseChannelService` operations are idempotent and a no-op when the course has no channel. The course channel is created once, on first publish, one per course, and is read-only while the course is archived or locked (message delete remains allowed).

---

## 18. Security Architecture

| Area | Measures |
|---|---|
| Passwords | Argon2id, 10–128 chars, common-password check, throttle before hashing, dummy hash for unknown emails |
| Tokens | Short JWT in memory; opaque refresh token in `HttpOnly` cookie; SHA-256-hashed storage; rotation, family reuse detection, ~10 s grace window; `tokens_valid_after` closes the access-token window after revoke-all |
| Enumeration | Registration, resend, forgot-password always 202; login errors indistinguishable; `INVITATION_ONLY`/locked courses return 404 to outsiders |
| Mass assignment | Global `ValidationPipe` (whitelist, forbid unknown, transform); every DTO field decorated; registration can never choose a role |
| Output | Allowlist response DTOs; email only in `/me` and Admin endpoints; never `password_hash`, `token_hash`, deleted-message text, snapshots |
| Transport | HTTPS, `Secure` cookies, Helmet, CORS restricted to the frontend origin with credentials, trusted-proxy config, `Origin` checks on refresh, logout, and socket handshake |
| CSRF | Refresh cookie is `SameSite=Lax` and scoped to `/api/v1/auth`; all tokens consumed by POST; Origin check as defense in depth |
| XSS | Tokens never in `localStorage`; Markdown stored as text and rendered safely by the frontend; videos embedded from server-built URLs for YouTube/Vimeo only |
| Rate limiting | Four classes; per-IP and per-email keys on sensitive endpoints; no account lockout |
| Suspension | Guard check on every request, refresh tokens revoked in the same transaction, sockets disconnected after commit |
| Abuse controls | Blocks (chat only; Admins exempt), reports with evidence snapshot, Admin moderation; user search limited and safe-fields-only (slow scraping is an accepted risk) |
| Privacy | Admins see only the reported message and about 10 messages either side (separately audited `context` endpoint); `last_seen_at` stored, never exposed; presence limited to DM/group peers |
| Audit | Immutable `AuditLog` (trigger rejects UPDATE/DELETE), written in the same transaction as the action; audited: privileged and relationship-changing actions only |
| Files | Real type check, generated keys, private attachments with short-lived signed URLs re-checked per request |
| Secrets/config | Validated environment variables at startup; JWT secret ≥ 32 random bytes; logs redact tokens, passwords, and message bodies |

**Accepted limitations:** a stolen access token could link a Google account (≤15 min); narrow pre-verification registration race; single-device logout leaves that device's socket open; deleted-message text persists in the database and backups; slow user-directory scraping; suspended users still count toward group caps.

---

## 19. Testing Architecture

All integration tests run against **real PostgreSQL**; mocked Prisma does not count. Constraints that live in the database are tested by trying to break them.

| Layer | What it covers | Introduced |
|---|---|---|
| Constraint tests | CHECKs, partial indexes, composite FKs, trigger, FK delete actions, index existence; migration replay and drift | M5, M7 |
| Service integration tests | Business rules and transactions per module | M9–M12 |
| HTTP tests | Guards, DTOs, exception filter, status codes | M6 onward |
| Concurrency tests | Parallel real transactions: lock modes, conditional updates, unique races, deadlock-free ordering | M2, each module, repeated in M13 |
| Socket tests | Handshake, delivery, presence, typing, suspension | M8, M10c |
| Conformance suites | Permission matrix, error registry, check order, mass assignment, leak scan | M13 |
| Dependency-cruiser rule tests | Deliberately violating fixtures per rule | M3 |

**Test harness (shared):** database lifecycle from migrations with isolation and a real connection pool (larger than 1), factories using direct inserts, a test-only access-token minter signing with the real secret and algorithm, a parallel-transaction helper, a direct-SQL helper for constraint tests. After Auth exists, a real-login smoke path complements the minted-token helper.

**Key test families**
- **Constraints:** two OWNERs rejected (demote-first succeeds); cross-course completion and lesson move rejected; message from a never-member rejected; duplicate DM pair, channel, `seq`, `client_id` rejected; audit UPDATE/DELETE rejected; FK actions read from the catalog match the delete-behavior table; SQL limits match the shared constants.
- **Concurrency:** same-`clientId` sends (one message, no `seq` gap); add Assistant vs enroll (exactly one wins); revoke teacher vs ownership transfer (never a revoked Owner); two Admins demoting each other (one Admin always remains); completion vs lesson archive (`completed_at` is set); sibling report resolution (no deadlock); Owner restore vs Admin lock (course ends locked); leave/return (membership matches enrollment); invitation accept vs revoke (one wins); group cap under parallel adds; refresh reuse commits family revocation before the 401.
- **Auth:** identical responses for unknown email, wrong password, Google-only account; refresh rotation, grace window, 90-day cap; reset invalidates old access tokens; Google link rules.
- **Access:** table-driven test of relationship × course status × policy × lock against the visibility rules, including 404 vs 403.
- **Realtime:** removed member stops receiving `message:new` immediately; suspended user's sockets disconnected; REST and socket send return the same errors; forged typing ignored; presence debounce and block filtering.

**Review checklist** (applied per milestone): lock order; state read after lock; no hashing/S3/mail in transactions; events after commit; unique violations outside the failed transaction; `visibleLessonWhere` for lesson reads; no Prisma in gateways/controllers; cross-module writes through the owner (single Progress exception); every DTO field decorated; progress reads as one statement.

---

## 20. Infrastructure / Development Environment

### Development environment

| Component | Tool |
|---|---|
| PostgreSQL | Docker Compose (same major version as deployment) |
| Object storage | MinIO (S3-compatible) |
| Mail | Mailpit |
| Tests | Real-database integration runner, pool larger than 1 |
| CI | Runs tests and dependency-cruiser; fails on violations and on `forwardRef` |

### Infrastructure modules

| Piece | Responsibility |
|---|---|
| `database` | Global `PrismaService`, `Tx` type, `runInTransaction`, `lockRow`, error classifiers (unique, FK, CHECK, deadlock) |
| `config` | Validated environment variables; the app refuses to boot with missing secrets |
| `audit` | `AuditWriter.record(tx, entry)`, validated against the audit-action constants; sole writer of `AuditLog` |
| `mail` | `MailService` for verification, reset, and "already registered" emails; imported only by Auth; send failures logged, never thrown into the caller; sent without awaiting (no job queue in v1) |
| `events` | Typed event names and payloads (no logic) |
| `realtime` | Socket.IO server, handshake auth, personal rooms, registry, `emitToUser(s)`, `disconnectUser` |
| `common` | `JwtAuthGuard`, `RolesGuard`, `CourseRoleGuard`, decorators (`@Public()`, `@Roles()`, `@CourseRole()`, `@CurrentUser()`), `CourseAccessService`, `TokenVerifier`, exception filter, pipes, shared constants |

### Cross-cutting configuration

Global `ValidationPipe` (whitelist, forbid unknown, transform); global exception filter (maps unique/FK violations to 409, CHECK violations to a logged 500 because they indicate a service bug); global JWT guard with `@Public()`; global throttler; Helmet; CORS (frontend origin, credentials); structured logging with request ids; Swagger; `/health`; `/api/v1` prefix.

### Single sources of truth in code

| File | Contents |
|---|---|
| Limits | Titles, bodies, tag cap, group cap (50), file sizes; read by DTOs and compared with SQL by a test |
| Error codes | Every code with its status (including the two-status `COURSE_ADMIN_LOCKED`) |
| Permission matrix | Platform-level and course-level matrices as data |
| Notification types | The 12 types with recipients and triggers |
| Audit actions | Constant list; separate from notification names |
| Rate-limit classes | Strict, Tight, Per-conversation burst, Default |
| Event contracts | Typed events including `message.created`, `membership.ended`, `session.revoked`, `socket.connected/disconnected` |
| Lock-table whitelist | Tables `lockRow` may lock |

### Deployment assumptions

Single backend instance behind a reverse proxy with trusted-proxy configuration, same-site with the frontend, `Secure` cookies, private attachment bucket, public avatar/cover access, database backups with a tested restore. Presence, throttler counters, and the socket registry live in process memory; scheduled jobs are safe only on one instance.

### Known future-scaling items (not part of v1)

Shared store for presence, throttling, and the Socket.IO adapter; advisory lock for jobs on several instances; per-request user cache; job queue and outbox for after-commit effects; room-per-conversation delivery for very large channels. See the future-improvements list in `decision.log.md`.