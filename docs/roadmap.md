# Nelio Implementation Roadmap

> **Decision range:** 1–167 (all Decided) · **Next decision number:** 168 · **Unresolved deployment decision:** production hosting provider (not selected; see M14)
> **Status:** Design complete (Phases 1–10 closed). Implementation starts at M0.

---

## 1. Project Overview

**Nelio** is a web-based Learning Management System (graduation project) built as a **modular monolith** by one developer.

**Roles:** Student, Teacher (requires Admin approval), Admin. A user can hold several platform roles; every user gets `STUDENT` at registration.

**Core features (v1):** courses with sections, lessons and ordered content blocks (text, external video, file attachments); enrollment policies (open, approval, invitation); per-lesson progress with permanent course completion; Slack-like chat (DMs, groups, course channels) with unread counts, presence and typing; in-app notifications; blocking, reporting and Admin moderation; Google login; audit log.

**Out of scope for v1 (decision 89 and future list):** payments, quizzes/assignments, ratings/reviews, certificates, email notifications, invitations by email, account deletion, session list, hosted video, rich-text editor.

### Core Stack

| Area | Choice |
|---|---|
| Runtime / framework | Node.js, NestJS (modular monolith, single instance) |
| ORM / database | Prisma (multi-file schema), PostgreSQL (source of truth) |
| API | REST under `/api/v1`, Swagger/OpenAPI |
| Real-time | Socket.IO (one connection per client, personal rooms) |
| Auth | JWT access token (HS256, 15 min) + opaque refresh token (HttpOnly cookie), Argon2id, Google ID token |
| Validation | `class-validator` + `class-transformer` |
| Storage | S3-compatible object storage behind `StorageDriver` (MinIO locally) |
| Mail | Verification and reset emails only (Mailpit locally) |
| Tooling | dependency-cruiser, `@nestjs/schedule` |
| Frontend | Next.js (independent of backend design) |

---

## 2. Architecture and Development Principles

- [ ] PostgreSQL is the source of truth; the database enforces whatever it can.
- [ ] REST for commands and history; sockets for live delivery (decision 154).
- [ ] Dependencies point downward only (Layers 0–3); no `forwardRef`; modules import each other only via `index.ts` (decisions 98, 113, 114).
- [ ] Reads may cross modules via Prisma; writes go only through the owning module's service. Sole exception: Progress writes `Enrollment.completed_at` (decision 96).
- [ ] Services use Prisma directly; no repository layer; complex SQL in `*.queries.ts` (decision 99).
- [ ] Explicit `tx` parameter; the entry service owns the transaction; events are emitted only after commit (decision 100).
- [ ] READ COMMITTED + four tools: unique constraints, conditional updates, row locks, advisory locks (decision 159).
- [ ] Global lock order: advisory → User → Course → Conversation → child rows (Message before Report) (decision 160).
- [ ] Request DTOs per endpoint; allowlist response DTOs with mappers; no Prisma models in responses (decision 105).
- [ ] Events are a courtesy; everything is recoverable by pull (decisions 75, 157, 162).

### Module Layers

| Layer | Modules |
|---|---|
| 0 | Files, Catalog, Progress, Notifications, Moderation |
| 1 | Users (→ Files), Chat (→ Moderation), Content (→ Progress, Files) |
| 2 | Auth (→ Users), Courses (→ Catalog, Files, Chat), Enrollments (→ Progress, Chat) |
| 3 | Admin (orchestration only, owns no tables) |
| Infra | database, config, audit, mail, events, realtime, common (never import a domain) |

### Schema Groups (build order)

| Group | Tables |
|---|---|
| G1 | `User`, `UserRole`, `RefreshToken`, `AuthIdentity`, `EmailToken`, `FileAsset`, `AuditLog`, `Block` |
| G2 | `Category`, `Tag`, `Course`, `CourseTeacher`, `CourseTag`, `Notification` |
| G3 | `Section`, `Lesson`, `ContentBlock` |
| G4 | `Enrollment`, `Invitation`, `LessonCompletion` |
| G5 | `Conversation`, `DirectConversation`, `ConversationMember`, `Message`, `Report` |

---

## 3. Definition of Done (every milestone)

- [ ] Integration tests pass against **real PostgreSQL** (mocked Prisma does not count).
- [ ] Dependency-cruiser check is green (from M3 onward).
- [ ] Every error comes from the error-code registry.
- [ ] Every response goes through an allowlist DTO.
- [ ] Swagger lists the endpoints and their error codes.
- [ ] Review checklist applied:
  - [ ] Locks taken in global order
  - [ ] State read after the lock, never before
  - [ ] No hashing, token verification, S3 or mail inside a transaction
  - [ ] Events emitted after commit
  - [ ] Unique violations handled outside the failed transaction
  - [ ] Lesson reads use `visibleLessonWhere` (decision 103)
  - [ ] No Prisma calls in gateways or controllers
  - [ ] Cross-module writes go through the owner's service (single Progress exception)
  - [ ] Every request DTO field has a validator decorator
  - [ ] Progress reads are one SQL statement
  - [ ] The module's HTTP tests assert with `test/support/log-capture.ts` that request bodies, passwords, tokens, cookies and message bodies do not appear in logs (Decision 167)

---

## 4. Change Protocol

Decisions 1–167 are fixed. If a spike or implementation step shows a decision is wrong or impossible:

1. [ ] **Stop** work on the affected item.
2. [ ] **Write the conflict down** (what the decision says, what was found, evidence).
3. [ ] **Raise it as a new numbered proposal** (166 and up) with options, trade-offs and a recommendation.
4. [ ] **Wait for approval** before changing anything.
5. [ ] Record the outcome in the decision log; update affected milestones.

Never deviate silently. Schema changes after M7 are new migrations under this protocol.

---

## 5. Milestone Map

Each milestone requires the one before it.

| # | Milestone | Requires | Size |
|---|---|---|---|
| M0 | Minimal workspace | — | S |
| M1 | Spike A: Prisma, manual SQL, errors, transactions | M0 | M |
| M2 | Spike B: PostgreSQL lock-mode and concurrency tests | M1 | M |
| M3 | Dependency-cruiser and module skeleton | M2 | S |
| M4 | Shared source-of-truth files | M3 | M |
| M5 | Schema group 1 and test harness | M4 | L |
| M6 | Infrastructure core | M5 | L |
| M7 | Schema groups 2–5 and full constraint suite | M6 | XL |
| M8 | Guards, access service, Realtime and Mail infrastructure | M7 | L |
| M9 | Layer 0 modules | M8 | XL |
| M10 | Layer 1 modules | M9 | XL |
| M11 | Layer 2 modules | M10 | XL |
| M12 | Layer 3 (Admin) and seed | M11 | L |
| M13 | Scheduling, conformance and hardening | M12 | L |
| M14 | Release readiness | M13 | M |

---

## M0 — Minimal workspace

**Requires:** nothing · **Unblocks:** M1

- [ ] NestJS project, strict TypeScript, Prisma (current versions at start time)
- [ ] Docker Compose: PostgreSQL 18+ (Decision 165; Compose and CI use `postgres:18.6`), Mailpit (MinIO is added in M9a with the Files module)
- [ ] Integration test runner using a real database; connection pool larger than 1 for concurrency tests
- [ ] CI running the tests

**Exit:** `docker compose up`, then one trivial test connects to PostgreSQL and passes.

---

## M1 — Spike A: Prisma, manual SQL, errors, transactions

**Requires:** M0 · **Unblocks:** M2
Work in a throwaway branch/repo; produce a one-page **Spike A report**.

- [x] Current Prisma setup: generator, driver adapter requirement, multi-file schema (decision 101)
- [x] UUID v7: database-generated or application-generated (and which library) — *Spike A recommended database-generated `uuidv7()` on PostgreSQL 18+; accepted as Decision 165 (2026-10-25)*
- [x] `--create-only` migration with hand-added partial unique index, CHECK, generated `tsvector` column and trigger; generate the next migration and check what Prisma drops or alters. *Spike A finding:* GIN indexes and generated columns must be declared in the Prisma schema (`type: Gin`, `ops: raw(...)`, `dbgenerated(...)` with the exact text from `prisma db pull --print`), otherwise Prisma plans `DROP INDEX`, `DROP COLUMN` or an invalid `ALTER COLUMN ... DROP DEFAULT`; CHECK constraints, triggers and partial indexes stay hand-written SQL and are left alone by Prisma (declaring a partial index in the schema is a preview feature and is not used)
- [x] Verify `pg_trgm` creation during shadow-database replay (the migration must `CREATE EXTENSION` itself), migration-history replay on an empty database, and schema-drift checks (`prisma migrate diff ... --exit-code`) against both the migration history and the live database
- [x] Composite FKs (`Lesson→Section`, `Message→ConversationMember`, `LessonCompletion→Enrollment/Lesson`) with referential actions and `(id, course_id)` unique targets
- [x] Exact errors received for unique, FK, **CHECK**, deadlock and raw-query failures; reliable access to PostgreSQL error codes
- [x] Interactive transactions: default timeout/wait limits, throw behavior, return-value-commit-then-throw pattern (refresh-reuse)
- [x] Parameterized raw locking: `FOR SHARE`, `FOR NO KEY UPDATE`, advisory transaction locks; whitelisted-table helper on paper
- [x] Type mapping: `timestamptz`, `bigint` in JSON, enums, `jsonb`
- [x] Raw `tsvector` search and `pg_trgm` similarity queries with parameters

**Exit:** report lists every assumption as confirmed, contradicted or different than expected, naming affected decisions. Any contradiction goes through the Change Protocol before M2.

**Exit status (2026-10-24):**
- [x] Report lists every assumption as confirmed, contradicted or different, naming affected decisions (`docs/spikes/m1-spike-a-report.md`, committed in `f97fe8a`).
- [x] The one contradiction (C3: Prisma drops GIN indexes and generated columns that are not declared in the schema) went through the Change Protocol by owner direction, as operational migration rules (M5 above, `architecture.md` section 10) and not as a numbered decision.
- Not an Exit requirement: Decision 165 was Proposed at the time of this status; it was approved by the owner on 2026-10-25 and M5 schema work proceeds on it.

---

## M2 — Spike B: PostgreSQL lock-mode and concurrency tests

**Requires:** M1 · **Unblocks:** M3
Use real parallel connections and a helper that holds a transaction open while another runs.

- [x] Two `FOR SHARE` holders coexist (Course-S ∥ Course-S)
- [x] `FOR NO KEY UPDATE` conflicts with share holders both ways (Course-X vs Course-S)
- [x] Child-table `INSERT` (Enrollment → Course) is **not** blocked by `FOR NO KEY UPDATE`
- [x] `UPDATE conversation SET last_seq = last_seq + 1` does not block inserting a `ConversationMember`
- [x] After a lock wait, the next statement sees the other transaction's committed data (Rule 1)
- [x] A unique violation aborts the rest of the transaction
- [x] Parallel conditional updates: exactly one reports 1 row
- [x] Deliberate deadlock detected; error code is the one the retry helper handles
- [x] Advisory transaction lock serializes two "count Admins, then demote" transactions
- [x] One-Owner partial unique index fails on promote-first, passes on demote-first
- [x] Duplicate `client_id` insert rolls back the `last_seq` increment (no `seq` gap)
- [x] `INSERT … ON CONFLICT DO NOTHING` under concurrency (tags, completions, blocks)
- [x] Finish designs (on paper) of `runInTransaction` and `lockRow`

**Exit:** every claim confirmed (Spike B report). Any failed claim amends decisions 159/160 via the Change Protocol **before** M3. Tests proving permanent guarantees move into the real concurrency suite.

**Exit status (2026-10-25):**
- [x] Every claim confirmed: 13 of 13, plus the owner-approved extras (Course DELETE vs Enrollment INSERT, lock order, report resolution); `docs/spikes/m2-spike-b-report.md`, 70/70 spike tests on three consecutive runs.
- [x] No claim failed, so Decisions 159/160 are not amended and no Change Protocol entry is needed before M3.
- Carried forward, not part of M2: the permanent-guarantee tests listed in report section 5 move into the real concurrency suite in M5, M7 and M13; the `runInTransaction` and `lockRow` designs (report section 3) are built in M6.

---

## M3 — Dependency-cruiser and module skeleton

**Requires:** M2 · **Unblocks:** M4 (decision 104)

- [x] Folder structure per decision 115: `infrastructure/{database,config,audit,mail,events,realtime}`, `common/…`, 12 module folders each with module file, empty `index.ts`, `controllers/ services/ dto/ mappers/ queries/`
- [x] Rule: no cycles anywhere
- [x] Rule: domain → domain downward only (Layers 0–3), only via the other module's `index.ts`
- [x] Rule: domain → infrastructure/common from an explicit per-module allow-list (`mail` only Auth; `realtime` only Chat and Notifications; `audit` only modules writing audited actions)
- [x] Rule: infrastructure and `common` never import a domain module
- [x] Rule: gateways and controllers never import the database service
- [x] CI text search failing on `forwardRef`
- [ ] CI runs the checker and fails the build on violations *(step `npm run check:architecture` added to `.github/workflows/ci.yml` and the same command is green/red locally; confirmed on the first GitHub run, which needs a push)*

**Rule tests:**
- [x] Deliberately violating fixture per rule; checker fails on each
- [x] Fixture importing another module's internal file (not `index.ts`) fails

**Exit:** green on the empty skeleton, red on each fixture.

**Exit status (2026-10-25):**
- [x] Green on the empty skeleton (44 modules, 65 dependencies) and red on a fixture for each of the 13 rules; `allowed-imports` fixture (every import the architecture allows) is green, so the rules are not stricter than the architecture. `apps/backend/.dependency-cruiser.cjs`, `apps/backend/test/architecture/`.
- Recorded choices where the documents are silent: each module's `index.ts` exports its Nest module class (the only public API for now, needed for `AppModule` wiring) instead of being empty; the `audit` allow-list is `users, courses, enrollments, chat, moderation, admin` (derived from M10-M12 audited actions; extend only with a documented audited action); layering is "any lower layer", not the exact edges of the architecture diagram; `app.controller`/`app.service` (scaffold) stay until the health endpoint replaces them in M6; the scaffold e2e config was made ESM-compatible so `npm run test:e2e` runs and is now a CI step.
- Open: the CI item above, until the first GitHub run.

---

## M4 — Shared source-of-truth files

**Requires:** M3 · **Unblocks:** M5 (decision 137)

- [x] **Limits** (titles, bodies, tags, group cap, file sizes) read by DTOs; later compared with SQL
- [x] **Error codes** with statuses per decision 140 and Phase 7 codes (incl. `COURSE_ADMIN_LOCKED` 403/409, `INVITATION_REQUIRED` 403, `FILE_TOO_LARGE` 413, `FILE_TYPE_NOT_ALLOWED` 415, `INVALID_STATE_TRANSITION`, `COURSE_ALREADY_LOCKED`, `COURSE_NOT_LOCKED`)
- [x] **Permission matrix** as data (incl. Admin-applies-for-Teacher correction)
- [x] **Notification types** (12) with recipients and triggers
- [x] **Audit actions** (incl. `COURSE_ADMIN_UNLOCKED`); separate list from notification names
- [x] **Rate-limit classes:** Strict, Tight, Per-conversation burst, Default
- [x] **Event contracts** (`message.created`, `membership.ended`, `session.revoked`, `socket.connected/disconnected`, notification events)
- [x] **Lock-table whitelist** for `lockRow`

**Tests:**
- [x] Error codes unique, each with one status (or the two-status exception)
- [x] Exactly 12 notification types
- [x] Audit actions unique
- [x] Permission matrix entries reference real roles and relationship values

**Status (2026-10-25):** implemented in `apps/backend/src/common/constants/` (limits, error codes, permission matrix, notification types, audit actions, rate-limit classes, lock tables) and `apps/backend/src/infrastructure/events/event-contracts.ts`; 25 tests in `apps/backend/test/constants/`, including a test that keeps the audit-writer list equal to the dependency-cruiser allow-list and one that fails if a documented status changes.
- Values the documents do **not** state were proposed by the implementer and **approved by the owner on 2026-10-25 as initial implementation defaults** (they are not requirements of the original documents). Each is marked `approved-default` or `approved-derived` in code (versus `documented` for values the documents state) and recorded with its rationale and where it lands (SQL CHECK, DTO, service, config) in `docs/proposed-defaults.md`; a test keeps that file complete.
- The CHECK-versus-limit comparison is part of M5/M7 (there is no SQL yet).

---

## M5 — Schema group 1 and test harness

**Requires:** M4 · **Unblocks:** M6

**Migration rules (operational, from Spike A; apply to M5 and to every later schema milestone, M7 included; not a numbered decision):**
- Review the generated SQL of every `--create-only` migration before applying; look for unintended `DROP INDEX`, `DROP COLUMN` and `ALTER COLUMN ... DROP DEFAULT`.
- Declare GIN indexes and generated columns in the Prisma schema; keep CHECK constraints, triggers and partial indexes as hand-written SQL (Prisma does not natively express them).
- Replay all migrations against a clean shadow database, and check for unintended schema drift against the migration history and the live database.
- Create `pg_trgm` inside a migration (`CREATE EXTENSION IF NOT EXISTS pg_trgm`) before any `gin_trgm_ops` index; the shadow database starts empty.
- Put PostgreSQL enum `ALTER TYPE ... ADD VALUE` in a separate migration from any migration that uses the new value.

**Schema (`--create-only`, hand-written SQL appended, decision 102):**
- [x] Enums, `pg_trgm` extension, G1 tables with later-added columns: `User.email_verified_at`, `User.tokens_valid_after`, `UserRole.application_message`/`decision_note`, `RefreshToken.used_at`/`family_started_at`
- [x] `User ↔ FileAsset` circular reference created in one migration
- [x] CHECKs: `UserRole` decided pair; `RefreshToken.expires_at <= family_started_at + 90 days`; `FileAsset.size_bytes > 0`; `Block` self-block
- [x] Trigram index on `User.full_name`; **`AuditLog` immutability trigger**
- [x] Indexes: `RefreshToken(token_hash)` unique, `(user_id)`, `(family_id)`; `EmailToken(user_id, type)`; G1 unique keys; audit indexes; `Block(blocked_id)`; `UserRole(role, status)`; avatar partial FK index (decision 163)

**Test harness (deliverable):**
- [x] Database lifecycle (build from migrations, test isolation, real pool)
- [x] Factories (direct inserts) for users and roles (later courses, enrollments)
- [x] Test-only access-token minter using the real secret/algorithm
- [x] Parallel-transaction helper (from M2)
- [x] Direct-SQL helper for constraint tests
- [x] Short README

**Constraint tests:**
- [x] Duplicate email rejected; duplicate `(user_id, role)` rejected
- [x] `decided_by` without `decided_at` rejected
- [x] `RefreshToken` beyond the 90-day cap rejected
- [x] `AuditLog` UPDATE and DELETE rejected by trigger
- [x] Self-block and duplicate block rejected
- [x] `size_bytes = 0` rejected
- [x] Migration replay on a fresh DB; drift detection reports nothing unexpected

**Status (2026-10-25):** implemented in `apps/backend/prisma/` (6 schema files, migration `20261025115804_g1_users_auth_files_audit_blocks`, `database-url.mjs`), `apps/backend/prisma.config.ts` and `apps/backend/test/` (harness in `support/`, 28 constraint tests in `integration/`, 5 token-minter tests; `test/README.md`). The migration was applied to the development database `nelio`; `prisma migrate diff` reports no drift against the migration history (shadow replay) or the live database, for both `nelio` and the test database. Mutation checks (changing the 90-day cap, the trigger event, the size CHECK) make 4 tests fail.
- Recorded choices where the documents are silent: tables are plural snake_case (`users`, `user_roles`, `refresh_tokens`, `auth_identities`, `email_tokens`, `file_assets`, `audit_logs`, `blocks`); `updated_at` exists only on `users` and `user_roles` (rows of the other G1 tables change through dedicated timestamps or never); `updated_at` is set by Prisma (`@updatedAt`), not by a trigger; foreign keys keep Prisma's default `ON UPDATE CASCADE` (ids never change); `audit_logs.target_id` is a non-null UUID; the generated Prisma client lives in the gitignored `src/generated/prisma` and is created by `npm run prisma:generate` (CI runs it).
- The `audit_logs` trigger guards UPDATE and DELETE as the architecture states; TRUNCATE is not guarded (the test harness relies on it).
- Not part of M5: SQL CHECK limits for titles, tags, categories, group titles and message bodies belong to the tables of G2-G5 (M7).

---

## M6 — Infrastructure core

**Requires:** M5 · **Unblocks:** M7

- [x] **Config:** validated env vars; app refuses to start without secrets; JWT secret ≥ 32 random bytes
- [x] **Database:** `PrismaService`, `Tx` type, `runInTransaction` (explicit timeout, bounded retry on deadlock/serialization), `lockRow` over whitelist, error classifiers
- [x] **Exception filter:** `{ statusCode, code, message, errors? }`; DB-error mapping; CHECK violation → 500 with loud log
- [x] **Global `ValidationPipe`:** whitelist, `forbidNonWhitelisted`, transform
- [x] **Logging:** request IDs, structured, redacting tokens/passwords/message bodies
- [x] **Security/routing:** Helmet, CORS restricted to frontend origin with credentials, trusted-proxy setting, `/api/v1` prefix
- [x] **Throttler:** four classes; per-IP and per-email keys on sensitive endpoints; runs before hashing
- [x] Swagger and health endpoint
- [x] `AuditWriter.record(tx, entry)` validating against M4 constants
- [x] Emit-after-commit event helper

**Tests:**
- [x] `runInTransaction` retries after forced deadlock and gives up after the limit
- [x] Unique/FK/CHECK violations map to correct statuses and codes
- [x] Unknown field → 400 `VALIDATION_FAILED`; malformed UUID → 400
- [x] Throttle returns 429 before any other check
- [x] Audit row disappears on rollback; invalid action rejected
- [x] Logs contain no password/token/message body
- [x] Event emitted in a transaction is delivered only after commit, never after rollback
- [x] Health responds

**Verify:** `ValidationPipe` on Socket.IO gateways (tested in M8, still open); throttler behind a proxy (done: `TRUST_PROXY=1` limits each `X-Forwarded-For` client separately, `TRUST_PROXY=0` ignores the header).

**Status (2026-10-25):** implemented in `apps/backend/src/{app.setup.ts,app.module.ts,main.ts,openapi-export.ts}`, `src/common/{filters,pipes,guards,decorators,global-providers.ts}` and `src/infrastructure/{config,database,audit,events,health,logging}`. After the owner's review the same day (Decisions 166 and 167) it was revised: exhausted deadlock retries and database timeouts → 503 `SERVICE_UNAVAILABLE` (no `Retry-After`); JSON-body 413/415 → 400 `VALIDATION_FAILED`; the rate-limit store is bounded (`COUNT_LIMITS.RATE_LIMIT_MAX_KEYS`) and unit-tested with a fake clock; logging moved to `infrastructure/logging`; `GET /health` is unprefixed; `start`, `start:dev` and `start:debug` load the root `.env` with `--env-file-if-exists=../../.env`.
- Tests: `test/infrastructure/config.spec.ts`, `test/infrastructure/logging.spec.ts`, `test/common/rate-limit.store.spec.ts`, `test/app.e2e-spec.ts` (no database), `test/integration/database.integration-spec.ts` (real deadlock) and `test/integration/app.integration-spec.ts` (whole `AppModule` + health). `npm run openapi:export` writes `apps/backend/openapi.json`.
- Recorded choices where the documents are silent: `docs/proposed-defaults.md` section 10 (approved 2026-10-25).
- **Open, tracked gaps (not fixed):** (1) the `user` and `conversation` rate-limit keys do not exist before authentication, so **Per-conversation burst does not limit yet** (`test/app.e2e-spec.ts` pins this with a test named "KNOWN GAP"; M8/M10 below); (2) `ValidationPipe` on Socket.IO gateways is verified in M8.
- Prisma client generator sets `importFileExtension = "js"` so the generated imports compile under `nodenext` and Jest.
- The real `.env` needs a `JWT_SECRET` before `npm start` works (see `.env.example`); integration tests do not need it.

---

## M7 — Schema groups 2–5 and full constraint suite

**Requires:** M6 · **Unblocks:** M8. Complete each group with its tests before the next. Follow the migration rules listed under M5.

### G2 — Category, Tag, Course, CourseTeacher, CourseTag, Notification
- [x] Course CHECKs: published needs category + summary; non-draft needs `first_published_at`; `locked_by_admin_at IS NULL OR status = 'ARCHIVED'`
- [x] Generated `search_vector` (`simple` configuration) + GIN index
- [x] One-OWNER partial unique index
- [x] Indexes: `Course(status, first_published_at DESC)`, `category_id`, `cover_file_id` partial; `CourseTeacher(user_id)`; `CourseTag(tag_id)`; `Notification(user_id, created_at DESC)`, unread partial, `course_id`
- [x] Tests: two OWNERs rejected (demote-first succeeds); publish without category rejected; lock on non-archived rejected; category in use can't be deleted; search vector updates on title change

### G3 — Section, Lesson, ContentBlock
- [x] Unique `(id, course_id)` targets; composite FK `Lesson→Section`
- [x] CHECKs: lesson published ⇒ `first_published_at`; block columns match `type`
- [x] Indexes: published-lessons-per-course partial; `Section(course_id, position)`; `Lesson(section_id, position)`; `ContentBlock.file_id` unique + child index
- [x] Tests: cross-course lesson move rejected; section with lessons can't be deleted; `VIDEO` without provider rejected; `TEXT` with file rejected; one file on two blocks rejected

### G4 — Enrollment, Invitation, LessonCompletion
- [x] `Enrollment` unique `(course_id, user_id)` and `(id, course_id)`; decided-pair CHECK; `completed_at ⇒ first_activated_at` CHECK
- [x] Indexes: active-and-incomplete partial; `(course_id, status)`, `(user_id, status)`; `last_visited_lesson_id` partial; `Invitation (course_id, invited_user_id)` unique and `(invited_user_id)`; `LessonCompletion (lesson_id, course_id)`
- [x] `LessonCompletion` composite PK and two composite FKs sharing `course_id`
- [x] Tests: cross-course completion rejected; duplicate enrollment rejected; deleting a completed lesson rejected; deleting a course with enrollment/invitation rejected; lesson delete nulls `last_visited_lesson_id`

### G5 — Conversation, DirectConversation, ConversationMember, Message, Report
- [x] Conversation type/`course_id`/title CHECK; unique `course_id`; `DirectConversation` `a < b` CHECK + unique pair
- [x] `ConversationMember` active-members partial index
- [x] `Message`: unique `(conversation_id, seq)` and `(sender_id, client_id)`; body-length and deleted-pair CHECKs; composite FK to `ConversationMember`
- [x] `Report`: exactly-one-target CHECK; two open-report partial unique indexes; `(status, created_at)`, `(message_id)`, `(target_user_id)`
- [x] Order inside G5: `ConversationMember` → `Message` → `Report`
- [x] Tests: second channel for a course rejected; DM `(B,A)` rejected; message from never-member rejected; duplicate `seq` rejected; two-target report rejected; duplicate open report rejected (new one after resolution accepted); deleting a reported message rejected; deleting a course with a channel rejected

### Whole-suite checks
- [x] Replay + drift test across all migrations
- [x] SQL limits match M4 constants
- [x] FK actions read from the DB catalog match the decision 91 delete-behavior table
- [x] Every partial index and constraint from the Phase 10 index/constraint list exists

**Status (2026-10-26):** implemented in `apps/backend/prisma/schema/` (`catalog`, `courses`, `notifications`, `content`, `enrollments`, `progress`, `chat`, `moderation`) and six migrations in `apps/backend/prisma/migrations/`: G1 (M5), `g2_catalog_courses_notifications`, `g3_content`, `g4_learning`, `g5_chat_reports`, and `g1_text_limits` (SQL CHECKs for the five G1 columns whose limits were approved in M4 but had no CHECK). All 25 entities exist. Each migration was created with `--create-only`, its generated SQL was read (no unintended `DROP`), the hand-written part was appended, and it was applied to the development database `nelio`; `prisma migrate diff` reports no drift against the migration history (shadow replay) or the live database.
- Tests (`apps/backend/test/integration/`): `g2`…`g5-constraints` (41, 26, 24, 43 tests) and `schema-suite` (37: exact inventory of tables, enums, CHECKs, partial indexes and other indexes; FK actions vs Decision 91; SQL limits vs `TEXT_LIMITS`; replay + drift across all six migrations). The replay/drift tests moved from the G1 spec into `schema-suite`. Mutation checks on every group (loosening a CHECK, dropping a partial `WHERE`, changing an FK action, a unique index, or a constant) make 4-6 tests fail each.
- Recorded choices where the documents are silent: `docs/proposed-defaults.md` section 11 (**pending owner review**): conversation shape and untitled channels, `client_id` as `uuid`, `updated_at` rule, no default for `enrollment_policy`, `search_vector` over title + summary + description, `video_external_id` 1-64, the `content_blocks (lesson_id, position)` index, snapshot `jsonb`, G1 limit CHECKs.
- Not enforced by the database on purpose (service layer, architecture section 9): a DM has exactly two members and a pair row; the sender is an active member; the lesson is published and the enrollment active at completion; `last_visited_lesson_id` belongs to the same course; teacher/student exclusion; no return to `DRAFT` once enrollments exist.

**Exit:** full constraint suite green. Schema frozen except via new migration under the Change Protocol.

---

## M8 — Guards, access service, Realtime and Mail infrastructure

**Requires:** M7 · **Unblocks:** M9

- [ ] `TokenVerifier` in `common` (HS256 pinned, rejects `alg: none`)
- [ ] `JwtAuthGuard` per decision 152 (verify → load user+roles in one query → suspended check → `tokens_valid_after` whole-second check → attach active roles only); `@Public()` and optional-auth variant (invalid token = 401)
- [ ] `RolesGuard` (`TEACHER_NOT_APPROVED` vs `FORBIDDEN`) and `CourseRoleGuard`
- [ ] `CourseAccessService` returning `OWNER`, `ASSISTANT`, `STUDENT_ACTIVE/PENDING/LEFT`, `REMOVED`, `REJECTED`, `INVITEE`, `NONE` + course status/policy/lock → 404 vs 403
- [ ] Realtime: Socket.IO server, handshake (token in auth payload, Origin check, shared user-loading logic), personal room, registry, `emitToUser(s)`, `disconnectUser`, `socket.connected/disconnected` events, `session.revoked` listener
- [ ] **Rate-limit keys that need the user (open gap from M6, Decision 167):** the Per-conversation burst class gets its `user` + `conversation` keys (REST and Socket.IO), replacing the "KNOWN GAP" test in `test/app.e2e-spec.ts`
- [ ] Mail: `MailService`, three templates (verify, reset, "already registered"), Mailpit in dev; send failures logged, never thrown into the caller

**Tests:**
- [ ] Guard: tampered, expired, wrong-algorithm tokens; unknown/suspended user; `iat` before `tokens_valid_after` (equal second accepted); pending/revoked Teacher on Teacher route; optional-auth invalid token → 401
- [ ] **Table-driven access test:** relationship × course status × policy × lock against decisions 119, 121, 136 (404 vs 403 outcomes)
- [ ] Check order: throttle → 401 → `ACCOUNT_SUSPENDED` → guards → input shape
- [ ] **The JWT guard runs after the rate limiter:** a flood of requests with invalid tokens is answered 429, not 401 (global guard order, `src/common/global-providers.ts`)
- [ ] **Per-conversation burst actually limits:** the 31st request in 10 seconds by one user in one conversation is answered 429 (do not mark the M6 gap fixed before this passes)
- [ ] Realtime: handshake rejects invalid/stale token, suspended user, wrong Origin; two sockets per user; `disconnectUser` closes all; `ValidationPipe` behavior on gateway payloads
- [ ] Mail failure doesn't break the request

---

## M9 — Layer 0 modules

**Requires:** M8 · **Unblocks:** M10. All five must be complete before M10; none may import another domain.

### M9a — Files
- [ ] Add MinIO to Docker Compose and its `MINIO_ROOT_*` variables to `.env.example`
- [ ] `StorageDriver` interface + S3/MinIO implementation (Files module only)
- [ ] `POST /files` (multipart, limits per `kind`, real file-type check, generated storage keys); `DELETE /files/:id` (own, unattached)
- [ ] `FILE_TOO_LARGE` (413) and `FILE_TYPE_NOT_ALLOWED` (415) are produced on upload routes only (the global filter maps a JSON-body 413/415 to 400, Decision 167); test both on `POST /files`
- [ ] Signed URLs for attachments; public URLs for avatars/covers
- [ ] Orphan cleanup job (older than 24 h, unreferenced across all referencing tables)
- [ ] Order: delete DB row then storage object; upload storage then metadata
- [ ] Tests: 413/415 codes; lying extension rejected; hostile filename can't affect key; non-Teachers can't upload covers/attachments; `FILE_IN_USE`; cleanup skips referenced/recent files and loses cleanly to a concurrent attach

### M9b — Catalog
- [ ] `GET /categories`, `GET /tags` (autocomplete, max 20); `setCourseTags(tx, …)` with normalization, tag cap, length limits
- [ ] Tests: normalization; cap; concurrent identical new tags don't fail

### M9c — Moderation
- [ ] `BlockService` (`isBlockedEitherWay`, `assertCanAdd`); block endpoints; `CANNOT_BLOCK_SELF`, `CANNOT_BLOCK_ADMIN`
- [ ] Report creation (message and user), snapshot taken in the same statement
- [ ] Tests: idempotent block; no "who blocked me" exposure; snapshot survives later edit; non-members 404; self-report 400; duplicate open report 409; reported message can't be hard-deleted

### M9d — Progress
- [ ] `CompletionService` (`markComplete`, `recheckEnrollment(tx)`, `recheckCourse(tx)`, nightly all-courses recheck); `ProgressQueries` (single statement); `PUT …/lessons/:lessonId/completion`
- [ ] Locks: Course-S, then Enrollment row `FOR SHARE`
- [ ] Tests: idempotent/parallel marking; requires `ACTIVE` enrollment and published same-course lesson; ≥1 published lesson guard; `completed_at` permanent and separate from `percent`; `courseCompleted` from conditional-update row count; **Bug 1 scenario**; removed-student race; progress summary is one query; recheck only completes `ACTIVE` incomplete enrollments

### M9e — Notifications
- [ ] Event listener, chunked bulk insert (~500), cursor list, unread count, idempotent read, read-all, Realtime push, 90-day read-notification retention job; exports nothing
- [ ] Tests: each of 12 types produces right row/recipients/`data`; foreign notification read → 404; no notifications for chat messages; push failure never fails anything; unread count uses partial index; retention deletes only old read rows

**Exit:** all five green; dependency checker shows no cross-domain imports among them.

---

## M10 — Layer 1 modules

**Requires:** M9 · **Unblocks:** M11. Users first; then Content and Chat (either order); Chat steps in order.

### M10a — Users
- [ ] `/me` (get, patch); user search (login required, ≥2 chars, ≤20, no pagination, safe fields, suspended excluded, trigram index); `/users/:id`; teacher application endpoints
- [ ] Primitives for Admin/Auth: `createWithStudentRole(tx)`, `setTokensValidAfter(tx)`, application decisions, revocation/suspension
- [ ] Tests: email only in `/me`; mass assignment (`role`) rejected; apply/re-apply after `REJECTED`/`REVOKED` (decided pair nulled, old message to audit); `APPLICATION_PENDING`, `ALREADY_TEACHER` (incl. Admin with ACTIVE Teacher); user + STUDENT role atomic; search excludes suspended and hides email

### M10b — Content
- [ ] Sections, lessons, blocks CRUD; shared full-list reorder helper (ID-list validation, parent lock, `ORDER_MISMATCH`); lesson lifecycle and `move`; `visibleLessonWhere`
- [ ] Outline vs public syllabus; student vs teacher lesson DTOs; signed download URLs re-checked each request
- [ ] Video URL parser (YouTube/Vimeo only; provider + id stored; embed URL built server-side); Markdown stored as text with length limit
- [ ] Lesson status changes call `recheckCourse` inside Course-X
- [ ] Tests: stale reorder → 409; parallel appends don't collide; publish needs ≥1 block; lesson with completion can't be deleted; archive before delete; cross-course move 404; students get 404 for non-published lessons everywhere (incl. download); `COURSE_ARCHIVED`/`COURSE_ADMIN_LOCKED` precedence on every mutation; unsupported video hosts rejected; `FILE` block checks kind/uploader/uniqueness; Bug 1 at HTTP level

### M10c — Chat (three steps, in order)

**Step 1 — Conversations and membership (REST)**
- [ ] Get-or-create DM (empty DMs hidden); groups (creator `ADMIN`, cap 50); add/remove/promote/leave; last-admin promotion; rename; mute; `GET /courses/:id/channel`; members list
- [ ] Tests: simultaneous first DMs → one conversation; 10 parallel adds never pass 50; two admins adding concurrently; blocked → neutral `MEMBERS_UNAVAILABLE`; `CANNOT_MESSAGE_USER` same either side; last-admin leave promotes oldest member (ties by user id); returning member's row reused; non-members 404

**Step 2 — Messages and `CourseChannelService`**
- [ ] Send, history (`before`/`after` `seq` cursors), edit, soft delete (author or course Owner/Assistant), mark read (`GREATEST`), unread counts, read-only for archived courses, `CLIENT_ID_REUSED`, moderator-deletion audit
- [ ] Message send and typing are limited per user and conversation on both transports (Per-conversation burst, see M8)
- [ ] `CourseChannelService`: `createForCourse`, idempotent `addMember`/`endMembership` (no-op without channel), `syncCourse`
- [ ] Tests: parallel same-`clientId` sends → one message, no `seq` gap; contiguous `seq` under parallel sends; former member can't send/read; archived: send 409, delete allowed; deleted message returns no body but row keeps it; edit-after-delete 409; mark-read never backwards and rejects above `last_seq`; unread excludes own/deleted; `syncCourse` repairs damage and leaves correct state untouched

**Step 3 — Real-time layer**
- [ ] `ChatGateway` (`message:send` with ack, `typing:start/stop`, `presence:subscribe`); `PresenceService` (multi-socket, ~5 s debounce, DM/group peers only, block-filtered, `last_seen_at` on last disconnect); `GET /me/presence`
- [ ] Post-commit recipient computation and emits: `message:new/edited/deleted`, `conversation:added/removed/updated/read`, `presence:update`, `typing`
- [ ] Tests: removed member stops receiving `message:new` immediately; socket and REST return same errors; same `clientId` twice → one message, one event; forged typing ignored; presence with two sockets and debounce; blocked pairs hidden; `last_seen_at` exposed by no endpoint; `after=` returns exactly missed messages; gateway never imports DB service

**Exit:** all three modules green (`CourseChannelService` exercised via factories).

---

## M11 — Layer 2 modules

**Requires:** M10 · **Unblocks:** M12. Order: Auth → Courses → Enrollments.

### M11a — Auth (in this order)
1. [ ] `TokenIssuer`, refresh families, `revokeAllSessions(tx, userId)` (revokes tokens + `UsersService.setTokensValidAfter` in the same transaction)
2. [ ] Register, verify, resend, forgot, reset (always-202, account-state table, newest-token cooldown, single-use conditional update)
3. [ ] Login, refresh, logout, logout-all, change-password (cookie `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`; Origin check on refresh/logout)
4. [ ] Google sign-in, link, unlink (ID-token verification **before** any transaction, then the four rules)
5. [ ] Expired-token cleanup job

**Verify:** current OWASP Argon2id parameters; `google-auth-library` verification API; `Secure` cookie behavior on `localhost`.

**Tests:**
- [ ] `register` with `role: ADMIN` → 400
- [ ] Unknown email / wrong password / Google-only account → identical status and body (dummy hash)
- [ ] Refresh rotates; reuse in grace window → 409 no revocation; reuse after window revokes whole family and revocation persists after the 401
- [ ] Two parallel refreshes → one new token
- [ ] Refresh after 90 days from `family_started_at` fails
- [ ] Reset invalidates old access tokens and all sessions; change-password keeps current device family
- [ ] Email tokens single-use, expire; verification never logs in
- [ ] Unverified re-registration replaces password; verified case changes nothing
- [ ] Google link to unverified account clears password and verifies; unverified Google email rejected; last login method can't be unlinked; two simultaneous first sign-ins → one user
- [ ] Login throttled before hashing
- [ ] Add one real-login smoke path (register → verify → login → authenticated call)

### M11b — Courses
- [ ] Create (User-S on self), patch (Owner only), tags, publish/archive/restore/delete, viewer block, public catalog with full-text search and filters, syllabus, teachers list, `GET /me/teaching/courses`, assistants, ownership transfer, `ownsCourses`, lifecycle audit rows
- [ ] First publish creates channel via `CourseChannelService`; add/remove Assistant call `addMember`/`endMembership`
- [ ] Tests: Course-X on every lifecycle/team operation; publish needs category, summary, ≥1 published lesson; channel created once (even for concurrent publishes); no return to draft; delete only when never published (FK backstops give loud 409); one Owner always, demote-first, previous Owner becomes Assistant; transfer to non-Teacher/student refused; Assistants can't change settings; `INVITATION_ONLY` absent from search but visible to invitee; Armenian/Russian/English search under `simple`; team operations work in any course status; every lifecycle transition audited

### M11c — Enrollments
- [ ] Single table-driven allowed-transition function (decisions 70, 123)
- [ ] Enroll/request/return, leave, last-visited, teacher queue (approve, reject, remove, reinstate), invitations (create-or-reset, `INVITATION_PENDING`, revoke by inviter or Owner, accept, decline), student lists and "my courses" via `ProgressQueries`, notification events after commit, audit rows
- [ ] Every entry into `ACTIVE`: Course-S → Enrollment row → channel membership upsert → `recheckEnrollment` in one transaction
- [ ] Tests: exhaustive status × action table; **add Assistant vs enroll** exactly one wins (both orders and parallel); leave-then-return keeps membership matching; accept vs revoke exactly one wins; accept when `ACTIVE` → `ALREADY_ENROLLED` and rollback; double-click harmless; approve/reinstate blocked on archived/locked, leave and Owner removal allowed; returning student rechecked for completion; invitation expiry derived (no job); removal keeps completions, reinstatement restores them; lists never include email

**Exit:** cross-module races pass; a full learning journey works through real HTTP with real login.

---

## M12 — Layer 3 (Admin) and seed

**Requires:** M11 · **Unblocks:** M13. Admin owns no tables and no business rules (decision 47).

- [ ] Users, applications, revoke-teacher, suspend/unsuspend, admin-role (under `ADMIN-SET` advisory lock)
- [ ] Courses: list, get, outline, lesson review (read-only, no audit), `lock`, `unlock`, `restore`, ownership transfer, student remove/reinstate
- [ ] Catalog management incl. tag merge
- [ ] Reports: queue, detail, separately audited `context`, dismiss, action (can delete message, closes sibling reports)
- [ ] Audit-log viewer, stats
- [ ] First-Admin seed script (env-based, email verified, only if no Admin exists)

**Tests:**
- [ ] Two Admins demoting/suspending each other → at least one active Admin remains; `CANNOT_SUSPEND_SELF` is 400
- [ ] Revoke teacher vs ownership transfer: never a revoked Owner, either order
- [ ] Suspension atomic (status, Assistant rows removed and not restored on unsuspend, `revokeAllSessions`, audit); next request 403, refresh fails, sockets get `session:revoked` and disconnect
- [ ] **Bug 2 scenario:** sibling-report resolution has no deadlock; second gets `REPORT_ALREADY_RESOLVED`
- [ ] Owner restore vs Admin lock → course ends locked; `unlock` leaves `ARCHIVED`; `restore` publishes; both `COURSE_NOT_LOCKED` when unlocked
- [ ] Lock on already-archived course; locked-course visibility re-verified end-to-end
- [ ] `context` writes `REPORT_CONTEXT_VIEWED` each time (~10 messages each side); other report endpoints don't
- [ ] Tag merge skips courses already holding the target tag
- [ ] Every `/admin/*` endpoint returns 403 to non-Admins
- [ ] Seed script idempotent

---

## M13 — Scheduling, conformance and hardening

**Requires:** M12 · **Unblocks:** M14

- [ ] Wire `@nestjs/schedule`: cleanup jobs (Auth tokens, Files orphans, Notification retention) and nightly sweepers (Chat channel reconcile, Progress full recheck); document single-instance assumption (decision 162)
- [ ] Drift tests: break channel membership and a completion, run sweeper, assert repair **and** log entry; second run changes nothing

**Conformance suites (generated from M4 files):**
- [ ] Permission matrix: every endpoint × role/relationship → exact outcome and status
- [ ] Error registry: every code reachable by a test; status matches registry
- [ ] Check order (`429 → 401 → 403 ACCOUNT_SUSPENDED → guards → 400 → 409`) on sample endpoints
- [ ] Mass assignment: every request DTO rejects unknown fields
- [ ] Leak scan: no `email` outside `/me` and Admin, no `password_hash`, `token_hash`, `message_snapshot` or deleted-message body in responses
- [ ] Full Phase 9 concurrency suite, looped to expose flakiness
- [ ] `EXPLAIN` checks: unread notifications, history by `seq`, active members, completion recheck, file-reference check
- [ ] Final dependency-cruiser run, migration replay/drift check, Swagger completeness

**Security pass:**
- [ ] Cookie flags, CORS, Helmet
- [ ] Origin checks on refresh, logout and socket handshake
- [ ] Log redaction
- [ ] Correct rate-limit class on every endpoint

---

## M14 — Release readiness

**Requires:** M13

- [ ] **Select the production hosting provider and verify its compatibility (deployment requirement, Decision 165).** The provider is **not selected** and nothing has been verified. From the provider's official documentation confirm: PostgreSQL 18 or later is offered (`uuidv7()` is core in 18, no extension needed); `pg_trgm` is allowed; advisory locks and `set_config(..., true)` behave correctly behind its connection pooler; backups and a tested restore are possible; S3-compatible private/public bucket policies are possible. Do not deploy to production before this is done.
- [ ] **Revisit the database pool size** (`TRANSACTION_LIMITS.POOL_MAX`, default 10) against the selected provider's connection limits and pooler (approved 2026-10-25)
- [ ] Same-site deployment (shared registrable domain or reverse proxy); trusted-proxy config (`TRUST_PROXY` hop count; the rate limiter sees the proxy's IP if it is wrong); `Secure` cookies; validated production environment
- [ ] S3 bucket policy: private attachments, public avatars/covers
- [ ] Database backups **and a tested restore** (deleted-message text persists in backups, decision 86)
- [ ] Runbook: sweeper logs signal a bug; JWT secret rotation logs everyone out; how to create an Admin
- [ ] Frontend contract notes: share one in-flight refresh; refresh before socket reconnect; render private pages client-side; sort messages by `seq` and detect gaps; render Markdown safely; 401 vs 403 handling (`INVALID_CURRENT_PASSWORD` is 403 by design)
- [ ] OpenAPI document handed to the frontend

---

## 6. Test Layers

| Layer | Introduced |
|---|---|
| Constraint tests (try to break the database) | M5, M7 |
| Service integration tests (real PostgreSQL) | M9–M12 |
| HTTP tests (guards, DTOs, filter, statuses) | M6 onward |
| Concurrency tests (parallel real transactions) | M2, each module, repeated in M13 |
| Socket tests | M8, M10c |
| Conformance suites | M13 |
| Dependency-cruiser rule tests | M3 |

## 7. Risks to Watch

- [ ] M1/M2 may overturn assumptions — use the Change Protocol early.
- [ ] Schema is built before services — add a migration rather than bending a service.
- [ ] Lock-order discipline can't be automated — rely on the review checklist and repeated concurrency suite.
- [ ] M11c is the hardest milestone — keep the single transition function and table-driven test.
- [ ] Test factories can hide guard bugs before M11 — covered by M8 access test and the M11 real-login smoke path.

---

## 8. Decision Status

- **Decided:** 1–167 (165: PostgreSQL 18+ and database-generated `uuidv7()`; 166: `SERVICE_UNAVAILABLE` 503 in the status policy; 167: M6 infrastructure choices; all approved 2026-10-25)
- **Open design questions:** none
- **Unresolved deployment decision:** the production hosting provider is not selected. It blocks nothing before M14; its PostgreSQL 18 compatibility check is a deployment requirement (M14).
- **Initial implementation defaults:** the values in `docs/proposed-defaults.md` were approved by the owner on 2026-10-25 as initial defaults; they are not requirements of the original documents.
- **Next decision number:** **168**