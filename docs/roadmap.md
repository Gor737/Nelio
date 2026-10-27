# Nelio Implementation Roadmap

> **Decision range:** 1–168 (all Decided) · **Next decision number:** 169 · **Unresolved deployment decision:** production hosting provider (not selected; see M14)
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
  - [ ] Every new route is secure by default: a public route carries `@Public()` and a route without it needs a token; the OpenAPI document shows the security and the error responses of each operation
  - [ ] Every WebSocket gateway binds `@UseFilters(AllExceptionsFilter)` (Nest does not apply the global filter to gateways)
  - [ ] Every request-DTO string that has a `TEXT_LIMITS` entry is validated with the shared code-point length helper, never with `.length` / `@Length` on UTF-16 units (a 1-character emoji has `.length` 2 but one PostgreSQL character)
  - [ ] Cross-module writes go through the owner's service (single Progress exception)
  - [ ] Every request DTO field has a validator decorator
  - [ ] Progress reads are one SQL statement
  - [ ] Every raw-SQL `UPDATE` on a table that has `updated_at` sets `updated_at = now()` explicitly (Prisma maintains it only for its own updates; no trigger)
  - [ ] The module's HTTP tests assert with `test/support/log-capture.ts` that request bodies, passwords, tokens, cookies and message bodies do not appear in logs (Decision 167)

---

## 4. Change Protocol

Decisions 1–168 are fixed. If a spike or implementation step shows a decision is wrong or impossible:

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

**Verify:** `ValidationPipe` on Socket.IO gateways (done in M8); throttler behind a proxy (done: `TRUST_PROXY=1` limits each `X-Forwarded-For` client separately, `TRUST_PROXY=0` ignores the header).

**Status (2026-10-25):** implemented in `apps/backend/src/{app.setup.ts,app.module.ts,main.ts,openapi-export.ts}`, `src/common/{filters,pipes,guards,decorators,global-providers.ts}` and `src/infrastructure/{config,database,audit,events,health,logging}`. After the owner's review the same day (Decisions 166 and 167) it was revised: exhausted deadlock retries and database timeouts → 503 `SERVICE_UNAVAILABLE` (no `Retry-After`); JSON-body 413/415 → 400 `VALIDATION_FAILED`; the rate-limit store is bounded (`COUNT_LIMITS.RATE_LIMIT_MAX_KEYS`) and unit-tested with a fake clock; logging moved to `infrastructure/logging`; `GET /health` is unprefixed; `start`, `start:dev` and `start:debug` load the root `.env` with `--env-file-if-exists=../../.env`.
- Tests: `test/infrastructure/config.spec.ts`, `test/infrastructure/logging.spec.ts`, `test/common/rate-limit.store.spec.ts`, `test/app.e2e-spec.ts` (no database), `test/integration/database.integration-spec.ts` (real deadlock) and `test/integration/app.integration-spec.ts` (whole `AppModule` + health). `npm run openapi:export` writes `apps/backend/openapi.json`.
- Recorded choices where the documents are silent: `docs/proposed-defaults.md` section 10 (approved 2026-10-25).
- **Gaps found in M6 and closed in M8:** the `user` and `conversation` rate-limit keys (Per-conversation burst now limits; the "KNOWN GAP" test was replaced) and `ValidationPipe` on Socket.IO gateways. M10c still has to apply the burst class to the real chat routes and events.
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

**Status (2026-10-26):** implemented in `apps/backend/prisma/schema/` (`catalog`, `courses`, `notifications`, `content`, `enrollments`, `progress`, `chat`, `moderation`) and seven migrations in `apps/backend/prisma/migrations/`: G1 (M5), `g2_catalog_courses_notifications`, `g3_content`, `g4_learning`, `g5_chat_reports`, `g1_text_limits` (SQL CHECKs for the five G1 columns whose limits were approved in M4 but had no CHECK) and `g5_report_snapshot_text` (the report snapshot became `text` with a 1-2000 CHECK, Decision 77). All 25 entities exist. Each migration was created with `--create-only`, its generated SQL was read (no unintended `DROP`), the hand-written part was appended, and it was applied to the development database `nelio`; `prisma migrate diff` reports no drift against the migration history (shadow replay) or the live database.
- Tests (`apps/backend/test/integration/`): `g2`…`g5-constraints` (41, 26, 24, 48 tests) and `schema-suite` (38: exact inventory of tables, enums, CHECKs, partial indexes and other indexes; FK actions vs Decision 91; SQL limits vs `TEXT_LIMITS`; replay + drift across all seven migrations). The replay/drift tests moved from the G1 spec into `schema-suite`. Mutation checks on every group (loosening a CHECK, dropping a partial `WHERE`, changing an FK action, a unique index, or a constant) make 4-6 tests fail each.
- Recorded choices where the documents are silent: `docs/proposed-defaults.md` section 11 (**approved by the owner on 2026-10-26** after review, with one revision): conversation shape and untitled channels, `client_id` as `uuid`, `updated_at` rule (with the raw-SQL review rule), no default for `enrollment_policy` (required by the API), `search_vector` over title + summary + description, `video_external_id` 1-64, the `content_blocks (lesson_id, position)` index, the report snapshot as `text` (revised from `jsonb`), G1 limit CHECKs. Follow-up items placed in the roadmap: Definition of Done (raw-SQL `updated_at`), M9c (snapshot), M10b (lesson deletion rule, video id validation), M11b (`enrollmentPolicy` required).
- Not enforced by the database on purpose (service layer, architecture section 9): a DM has exactly two members and a pair row; the sender is an active member; the lesson is published and the enrollment active at completion; `last_visited_lesson_id` belongs to the same course; teacher/student exclusion; no return to `DRAFT` once enrollments exist.

**Exit:** full constraint suite green. Schema frozen except via new migration under the Change Protocol.

---

## M8 — Guards, access service, Realtime and Mail infrastructure

**Requires:** M7 · **Unblocks:** M9

- [x] `TokenVerifier` in `common` (HS256 pinned, rejects `alg: none`)
- [x] `JwtAuthGuard` per decision 152 (verify → load user+roles in one query → suspended check → `tokens_valid_after` whole-second check → attach active roles only); `@Public()` and optional-auth variant (invalid token = 401)
- [x] `RolesGuard` (`TEACHER_NOT_APPROVED` vs `FORBIDDEN`) and `CourseRoleGuard`
- [x] `CourseAccessService` returning `OWNER`, `ASSISTANT`, `STUDENT_ACTIVE/PENDING/LEFT`, `REMOVED`, `REJECTED`, `INVITEE`, `NONE` + course status/policy/lock → 404 vs 403
- [x] Realtime: Socket.IO server, handshake (token in auth payload, Origin check, shared user-loading logic), personal room, registry, `emitToUser(s)`, `disconnectUser`, `socket.connected/disconnected` events, `session.revoked` listener
- [x] **Rate-limit keys that need the user (open gap from M6, Decision 167):** the Per-conversation burst class gets its `user` + `conversation` keys (REST and Socket.IO), replacing the "KNOWN GAP" test in `test/app.e2e-spec.ts`
- [x] Mail: `MailService`, three templates (verify, reset, "already registered"), Mailpit in dev; send failures logged, never thrown into the caller

**Tests:**
- [x] Guard: tampered, expired, wrong-algorithm tokens; unknown/suspended user; `iat` before `tokens_valid_after` (equal second accepted); pending/revoked Teacher on Teacher route; optional-auth invalid token → 401
- [x] **Table-driven access test:** relationship × course status × policy × lock against decisions 119, 121, 136 (404 vs 403 outcomes)
- [x] Check order: throttle → 401 → `ACCOUNT_SUSPENDED` → guards → input shape
- [x] **The JWT guard runs after the rate limiter:** a flood of requests with invalid tokens is answered 429, not 401 (global guard order, `src/common/global-providers.ts`)
- [x] **Per-conversation burst actually limits:** the 31st request in 10 seconds by one user in one conversation is answered 429 (do not mark the M6 gap fixed before this passes)
- [x] Realtime: handshake rejects invalid/stale token, suspended user, wrong Origin; two sockets per user; `disconnectUser` closes all; `ValidationPipe` behavior on gateway payloads
- [x] Mail failure doesn't break the request

**Status (2026-10-26):** implemented in `apps/backend/src/common/{guards,access,decorators}` (`TokenVerifier`, `Authenticator`, `JwtAuthGuard`, `RolesGuard`, `CourseRoleGuard`, `UserRateLimitGuard`, `RateLimiter`, `CourseAccessService`, `@Public/@OptionalAuth/@Roles/@CourseRole/@CurrentUser`, `AuthCoreModule`), `src/infrastructure/realtime` (Socket.IO gateway, handshake, registry, `RealtimeService`, configured adapter) and `src/infrastructure/mail` (`MailService`, templates, nodemailer transport), with the SMTP settings in the validated configuration. The global guards are registered in the order of the check list (`GLOBAL_PROVIDERS`). The OpenAPI document now derives each operation's security and its 400/401/403/429/500/503 responses from the guard decorators.
- Tests: `test/common/token-verifier.spec.ts` (41), `course-access.spec.ts` (the 108-case grid), `rate-limiter.spec.ts`; `test/infrastructure/mail.spec.ts`; `test/app.e2e-spec.ts` (57: check order, guard order, Per-conversation burst, mail failure, OpenAPI security); `test/integration/auth-guards`, `course-access`, `realtime` (27, real Socket.IO client) and `mail-smtp` (real SMTP against Mailpit; skips itself when Mailpit is not running). Mutation checks on 14 security-relevant lines (algorithm pinning, expiry, suspension, `tokens_valid_after`, visibility rules, guard order, user-keyed limits, the Origin check, `disconnectUser`, mail errors) were all caught by tests.
- **The M6 gaps are closed:** Per-conversation burst now limits (the "KNOWN GAP" test was replaced by tests that the 31st request is 429, and that REST and Socket.IO share one budget); `ValidationPipe` is verified on gateway payloads; the JWT guard runs after the rate limiter (test fails if the order changes).
- Recorded choices where the documents are silent: `docs/proposed-defaults.md` section 12 (**approved by the owner on 2026-10-26** (its email token lifetime item was resolved in M11a)). In particular the user-keyed 429 comes after 401 (it cannot come before), and two readings of Decisions 119/121 in the visibility grid.
- Found while testing: Nest does not apply the global exception filter to gateways (each gateway must bind it); connecting to SMTP by the name `localhost` stalls the first connection by about 5 s, so the development default is `127.0.0.1`.

---

## M9 — Layer 0 modules

**Requires:** M8 · **Unblocks:** M10. All five must be complete before M10; none may import another domain.

### Shared prerequisite (first, before any DTO)
- [x] **Code-point length helper (approved 2026-10-26):** a shared validator/decorator in `common` that counts a string's length in Unicode code points (`[...value].length` semantics, so an emoji or other astral character counts as 1, like PostgreSQL's `char_length`) and takes its bounds from `TEXT_LIMITS`; used for every request-DTO string that has a limit. It exists to stop the mismatch between PostgreSQL character limits and JavaScript `.length` (UTF-16 units), where a single emoji could pass a 2-character DTO check and then hit the database CHECK as a 500. Tests: bounds on both sides with ASCII, Armenian, emoji (astral) and combining characters; a DTO accepted by the helper is never rejected by the matching SQL CHECK (property-style check against the real database for every limited column)

### M9a — Files
- [ ] Add MinIO to Docker Compose and its `MINIO_ROOT_*` variables to `.env.example` — **OPEN, deliberately not implemented** (owner decision 2026-10-26: the official `minio/minio` images can no longer be pulled; do not use a community mirror or the frozen Bitnami image as the default; first select and verify a specific S3-compatible development image/provider with acceptable provenance, then add the Compose service). The `S3_*` variables are documented in `.env.example`; the Files code is generic S3 and does not depend on the choice. Nothing else in the roadmap waits for it before M14 (production object storage and hosting are chosen there)
- [x] `StorageDriver` interface + S3/MinIO implementation (Files module only)
- [x] `POST /files` (multipart, limits per `kind`, real file-type check, generated storage keys); `DELETE /files/:id` (own, unattached)
- [x] `FILE_TOO_LARGE` (413) and `FILE_TYPE_NOT_ALLOWED` (415) are produced on upload routes only (the global filter maps a JSON-body 413/415 to 400, Decision 167); test both on `POST /files`
- [x] Signed URLs for attachments; public URLs for avatars/covers
- [x] Orphan cleanup job (older than 24 h, unreferenced across all referencing tables)
- [x] Order: delete DB row then storage object; upload storage then metadata
- [x] Tests: 413/415 codes; lying extension rejected; hostile filename can't affect key; non-Teachers can't upload covers/attachments; `FILE_IN_USE`; cleanup skips referenced/recent files and loses cleanly to a concurrent attach

### M9b — Catalog
- [x] `GET /categories`, `GET /tags` (autocomplete, max 20); `setCourseTags(tx, …)` with normalization, tag cap, length limits
- [x] Tests: normalization; cap; concurrent identical new tags don't fail

### M9c — Moderation
- [x] `BlockService` (`isBlockedEitherWay`, `assertCanAdd`); block endpoints; `CANNOT_BLOCK_SELF`, `CANNOT_BLOCK_ADMIN`
- [x] Report creation (message and user), snapshot taken in the same statement: `message_snapshot` is the message body as **text** (1-2000 characters, `reports_message_snapshot_length`), required for message reports and absent for user reports (Decision 77, owner decision 2026-10-26)
- [x] Tests: idempotent block; no "who blocked me" exposure; snapshot survives later edit; non-members 404; self-report 400; duplicate open report 409; reported message can't be hard-deleted

### M9d — Progress
- [x] `CompletionService` (`markComplete`, `recheckEnrollment(tx)`, `recheckCourse(tx)`, nightly all-courses recheck); `ProgressQueries` (single statement); `PUT …/lessons/:lessonId/completion`
- [x] Locks: Course-S, then the Enrollment row `FOR NO KEY UPDATE` (**Decision 168**, approved 2026-10-26: `FOR SHARE` deadlocks and can miss a completion when one student marks twice at once)
- [x] Tests: idempotent/parallel marking; requires `ACTIVE` enrollment and published same-course lesson; ≥1 published lesson guard; `completed_at` permanent and separate from `percent`; `courseCompleted` from conditional-update row count; **Bug 1 scenario**; removed-student race; progress summary is one query; recheck only completes `ACTIVE` incomplete enrollments

### M9e — Notifications
- [x] Event listener, chunked bulk insert (~500), cursor list, unread count, idempotent read, read-all, Realtime push, 90-day read-notification retention job; exports nothing
- [x] Tests: each of 12 types produces right row/recipients/`data`; foreign notification read → 404; no notifications for chat messages; push failure never fails anything; unread count uses partial index; retention deletes only old read rows

**Exit:** all five green; dependency checker shows no cross-domain imports among them.

**Status (2026-10-26):** implemented and verified, **one item open (the MinIO Compose service)**. Code: `common/decorators/text-length.decorator.ts` (+ `common/dto/page-query.dto.ts`), and the five modules under `src/modules/{files,catalog,moderation,progress,notifications}`. The cron schedules for the three safety-net jobs (orphan files, completion recheck, notification retention) are M13; in M9 they are callable, tested service methods.
- Tests: `test/common/text-length.spec.ts` (30), `test/integration/text-limits-consistency` (8, real database, 18 columns x 7 alphabets); Files `file-utils.spec.ts` (48), `files.integration-spec.ts` (43), `files-s3.integration-spec.ts` (12, real S3-compatible store, skips itself without one); Catalog `tag-normalizer.spec.ts` (36), `catalog.integration-spec.ts` (23); Moderation `moderation.integration-spec.ts` (33); Progress `progress.integration-spec.ts` (23); Notifications `notifications.integration-spec.ts` (35, with a real Socket.IO client). Mutation checks: Catalog (insert order), Progress (5: Course-S lock, Enrollment lock mode, ACTIVE filter, published-lesson guard, conditional update) and Notifications (9) were all caught.
- Found while testing and **approved as Decision 168 (2026-10-26)**: the transaction catalog's `FOR SHARE` on the Enrollment row was not safe for two marks by the same student (lock-upgrade deadlock, and a missed completion); the Enrollment row is now locked `FOR NO KEY UPDATE`, `architecture.md` is updated, and the concurrency regression tests stay.
- Recorded choices where the documents are silent: `docs/proposed-defaults.md` section 13 (**still PROPOSED: none of its individual proposals is approved yet**, except the Enrollment lock mode, which is Decision 168).
- Open: selecting and verifying an S3-compatible development image/provider with acceptable provenance (above); the three scheduled jobs (M13); the first CI run on GitHub; `npm audit` advisories (M14); email token lifetime (M11a); `PER_CONVERSATION_BURST` on real chat (M10c).

---

## M10 — Layer 1 modules

**Requires:** M9 · **Unblocks:** M11. Users first; then Content and Chat (either order); Chat steps in order.

### M10a — Users
- [x] `/me` (get, patch); user search (login required, ≥2 chars, ≤20, no pagination, safe fields, suspended excluded, trigram index); `/users/:id`; teacher application endpoints
- [x] Primitives for Admin/Auth: `createWithStudentRole(tx)`, `setTokensValidAfter(tx)`, application decisions, revocation/suspension
- [x] Tests: email only in `/me`; mass assignment (`role`) rejected; apply/re-apply after `REJECTED`/`REVOKED` (decided pair nulled, old message to audit); `APPLICATION_PENDING`, `ALREADY_TEACHER` (incl. Admin with ACTIVE Teacher); user + STUDENT role atomic; search excludes suspended and hides email

### M10b — Content
- [x] Sections, lessons, blocks CRUD; shared full-list reorder helper (ID-list validation, parent lock, `ORDER_MISMATCH`); lesson lifecycle and `move`; `visibleLessonWhere`
- [x] Outline vs public syllabus; student vs teacher lesson DTOs; signed download URLs re-checked each request
- [x] Video URL parser (YouTube/Vimeo only; provider + id stored; embed URL built server-side); Markdown stored as text with length limit (no server-side sanitization: the frontend renders it safely, see the frontend contract notes)
- [x] Lesson status changes call `recheckCourse` inside Course-X
- [x] **Permanent lesson deletion rule (approved 2026-10-26):** a lesson may be hard-deleted only if it was never published (`first_published_at IS NULL`) **and** has no completions; "not currently published" is not enough (an `ARCHIVED` lesson that was published once is not deletable). Test both conditions, plus an `ARCHIVED` lesson that was never published (deletable)
- [x] **Provider-specific video id validation (approved 2026-10-26, not implemented before M10b):** the id is checked against the provider's own pattern (YouTube and Vimeo) in the Content module, in addition to the SQL length check (1-64); the embed URL is built server-side from provider + id only. Tests: hostile ids (quotes, slashes, `javascript:`, whitespace, over-long) rejected for both providers
- [x] Tests: stale reorder → 409; parallel appends don't collide; publish needs ≥1 block; lesson with completion can't be deleted; archive before delete; cross-course move 404; students get 404 for non-published lessons everywhere (incl. download); `COURSE_ARCHIVED`/`COURSE_ADMIN_LOCKED` precedence on every mutation; unsupported video hosts rejected; `FILE` block checks kind/uploader/uniqueness; Bug 1 at HTTP level

### M10c — Chat (three steps, in order)

**Step 1 — Conversations and membership (REST)**
- [x] Get-or-create DM (empty DMs hidden); groups (creator `ADMIN`, cap 50); add/remove/promote/leave; last-admin promotion; rename; mute; `GET /courses/:id/channel`; members list
- [x] Tests: simultaneous first DMs → one conversation; 10 parallel adds never pass 50; two admins adding concurrently; blocked → neutral `MEMBERS_UNAVAILABLE`; `CANNOT_MESSAGE_USER` same either side; last-admin leave promotes oldest member (ties by user id); returning member's row reused; non-members 404

**Step 2 — Messages and `CourseChannelService`**
- [x] Send, history (`before`/`after` `seq` cursors), edit, soft delete (author or course Owner/Assistant), mark read (`GREATEST`), unread counts, read-only for archived courses, `CLIENT_ID_REUSED`, moderator-deletion audit
- [x] Message send and typing are limited per user and conversation on both transports (Per-conversation burst, see M8)
- [x] `CourseChannelService`: `createForCourse`, idempotent `addMember`/`endMembership` (no-op without channel), `syncCourse`
- [x] Tests: parallel same-`clientId` sends → one message, no `seq` gap; contiguous `seq` under parallel sends; former member can't send/read; archived: send 409, delete allowed; deleted message returns no body but row keeps it; edit-after-delete 409; mark-read never backwards and rejects above `last_seq`; unread excludes own/deleted; `syncCourse` repairs damage and leaves correct state untouched

**Step 3 — Real-time layer**
- [x] `ChatGateway` binds `@UseFilters(AllExceptionsFilter)`, re-checks the user on every event with `RealtimeService.requireActiveUser`, and applies the Per-conversation burst class through the shared `RateLimiter` (REST routes with `@RateLimit('PER_CONVERSATION_BURST', { conversationParam: 'id' })`)
- [x] `ChatGateway` (`message:send` with ack, `typing:start/stop`, `presence:subscribe`); `PresenceService` (multi-socket, ~5 s debounce, DM/group peers only, block-filtered, `last_seen_at` on last disconnect); `GET /me/presence`
- [x] Post-commit recipient computation and emits: `message:new/edited/deleted`, `conversation:added/removed/updated/read`, `presence:update`, `typing`
- [x] Tests: removed member stops receiving `message:new` immediately; socket and REST return same errors; same `clientId` twice → one message, one event; forged typing ignored; presence with two sockets and debounce; blocked pairs hidden; `last_seen_at` exposed by no endpoint; `after=` returns exactly missed messages; gateway never imports DB service

**Exit:** all three modules green (`CourseChannelService` exercised via factories).

**Status (2026-10-26):** implemented and verified (all three modules green; dependency checker shows no import between Users, Content and Chat). Code: `src/modules/{users,content,chat}`, plus in `common` `@CurrentCourseAccess()` and `assertCourseMutable`, and in `infrastructure/events` four conversation event names.
- Tests: Users `users.integration-spec.ts` (30); Content `content.integration-spec.ts` (45) and `test/modules/content/video-url.spec.ts` (76, unit); Chat `chat-conversations.integration-spec.ts` (28), `chat-messages.integration-spec.ts` (30) and `chat-realtime.integration-spec.ts` (23, real Socket.IO clients). Mutation checks (about 80 mutations of locks, state checks, visibility, idempotency, block rules, delivery filters, typing and presence) are all caught by the tests.
- Found while testing: background delivery after a test ended deadlocked with the next test's `TRUNCATE`; `ChatDeliveryService.idle()` (also awaited at shutdown) fixes it and the chat specs wait on it after every test.
- Recorded choices where the documents are silent: `docs/proposed-defaults.md` section 14 (reviewed by the owner on 2026-10-26: `TEACHER_REAPPLIED`, the four conversation events, `409 RESOURCE_CONFLICT` for a full group, deleting the last block of a published lesson, unsanitized Markdown storage and the caller in their own search are **APPROVED**; the private Vimeo hash is **UNRESOLVED**; the rest is still proposed).
- Safety-net jobs are callable methods only (`CourseChannelService.reconcileAll`); their schedules are M13, as is wiring `CourseChannelService` into publish, enrollment and team transitions (M11).
- Open: the same items as M9 (MinIO development store, the first CI run, `npm audit`), and the **private Vimeo hash** (the parser accepts `vimeo.com/<id>/<hash>` and drops the hash; the owner kept this unresolved, so private Vimeo videos are unsupported until it is decided).

---

## M11 — Layer 2 modules

**Requires:** M10 · **Unblocks:** M12. Order: Auth → Courses → Enrollments.

### M11a — Auth (in this order)
- [x] **Reconcile the email-token lifetimes first (open since M8, owner decision 2026-10-26):** architecture section 11 says verification 24 h and reset 1 h, but `TIME_LIMITS.EMAIL_TOKEN_TTL_MS` is one value (1 h). Decide the requirement, then make the constant(s), the architecture text, the token expiry and the `validForHours` passed to `MailService` agree, with a test that the email and the stored `expires_at` state the same lifetime
1. [x] `TokenIssuer`, refresh families, `revokeAllSessions(tx, userId)` (revokes tokens + `UsersService.setTokensValidAfter` in the same transaction)
2. [x] Register, verify, resend, forgot, reset (always-202, account-state table, newest-token cooldown, single-use conditional update)
3. [x] Login, refresh, logout, logout-all, change-password (cookie `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`; Origin check on refresh/logout)
4. [x] Google sign-in, link, unlink (ID-token verification **before** any transaction, then the four rules)
5. [x] Expired-token cleanup job

**Verify:** current OWASP Argon2id parameters; `google-auth-library` verification API; `Secure` cookie behavior on `localhost`.

**Tests:**
- [x] `register` with `role: ADMIN` → 400
- [x] Unknown email / wrong password / Google-only account → identical status and body (dummy hash)
- [x] Refresh rotates; reuse in grace window → 409 no revocation; reuse after window revokes whole family and revocation persists after the 401
- [x] Two parallel refreshes → one new token
- [x] Refresh after 90 days from `family_started_at` fails
- [x] Reset invalidates old access tokens and all sessions; change-password keeps current device family
- [x] Email tokens single-use, expire; verification never logs in
- [x] Unverified re-registration replaces password; verified case changes nothing
- [x] Google link to unverified account clears password and verifies; unverified Google email rejected; last login method can't be unlinked; two simultaneous first sign-ins → one user
- [x] Login throttled before hashing
- [x] Add one real-login smoke path (register → verify → login → authenticated call)

### M11b — Courses
- [x] **`enrollmentPolicy` is required on course create (approved 2026-10-26):** no database default and no silent API default; a missing or unknown value is 400 `VALIDATION_FAILED`; the OpenAPI schema lists it as required (a test reads the generated document); the frontend create-course form must send it explicitly
- [x] Create (User-S on self), patch (Owner only), tags, publish/archive/restore/delete, viewer block, public catalog with full-text search and filters, syllabus, teachers list, `GET /me/teaching/courses`, assistants, ownership transfer, `ownsCourses`, lifecycle audit rows
- [x] First publish creates channel via `CourseChannelService`; add/remove Assistant call `addMember`/`endMembership`
- [x] Tests: Course-X on every lifecycle/team operation; publish needs category, summary, ≥1 published lesson; channel created once (even for concurrent publishes); no return to draft; delete only when never published (FK backstops give loud 409); one Owner always, demote-first, previous Owner becomes Assistant; transfer to non-Teacher/student refused; Assistants can't change settings; `INVITATION_ONLY` absent from search but visible to invitee; Armenian/Russian/English search under `simple`; team operations work in any course status; every lifecycle transition audited

### M11c — Enrollments
- [x] Single table-driven allowed-transition function (decisions 70, 123)
- [x] Enroll/request/return, leave, last-visited, teacher queue (approve, reject, remove, reinstate), invitations (create-or-reset, `INVITATION_PENDING`, revoke by inviter or Owner, accept, decline), student lists and "my courses" via `ProgressQueries`, notification events after commit, audit rows
- [x] Every entry into `ACTIVE`: Course-S → Enrollment row → channel membership upsert → `recheckEnrollment` in one transaction
- [x] Tests: exhaustive status × action table; **add Assistant vs enroll** exactly one wins (both orders and parallel); leave-then-return keeps membership matching; accept vs revoke exactly one wins; accept when `ACTIVE` → `ALREADY_ENROLLED` and rollback; double-click harmless; approve/reinstate blocked on archived/locked, leave and Owner removal allowed; returning student rechecked for completion; invitation expiry derived (no job); removal keeps completions, reinstatement restores them; lists never include email

**Exit:** cross-module races pass; a full learning journey works through real HTTP with real login.

**Status (2026-10-26):** implemented and verified: Auth, Courses and Enrollments are green, and a full learning journey works through real HTTP with real login (`journey.integration-spec.ts`). Code: `src/modules/{auth,courses,enrollments}`; in `common` the email-token lifetime helper `constants/email-tokens.ts`; two new dependencies (`argon2`, `google-auth-library`, exact pins).
- **Email-token lifetime resolved first:** verification 24 h and reset 1 h (the architecture text); one function produces the stored `expires_at` and the `validForHours` in the email; unit and integration tests prove they agree.
- Tests: Auth `auth.integration-spec.ts` (50), `password-policy.spec.ts` (21), `email-tokens.spec.ts` (4); Courses `courses.integration-spec.ts` (35); Enrollments `enrollments.integration-spec.ts` (31) and `transitions.spec.ts` (10, all 126 status x action x policy cases); `journey.integration-spec.ts` (1). Mutation checks on the security- and concurrency-relevant lines (token rotation and reuse, single use and expiry, session revocation, cookie flags, Origin check, Google rules, Course-X on every lifecycle and team operation, the Owner re-check, catalog filters, the transition table, Course-S, the teacher exclusion, invitation conditions) are listed in the final report of the milestone. 16 mutation patterns did not match the source after formatting and were **not rerun** (course lifecycle lock, restoring a locked course, deleting a published course, summary loss, team checks, transfer to self, parallel enrollment insert retry, joining a locked course, silent pending-invitation reset, Auth unlink); their behaviour is covered by tests.
- **Verified for M11a:** OWASP Argon2id profile (19 MiB, 2 iterations, 1 lane), `OAuth2Client.verifyIdToken` of `google-auth-library`, and the `Secure` cookie on `localhost` (browsers treat localhost as secure for it in Chrome and Firefox; not tried in a browser here).
- Recorded choices where the documents are silent: `docs/proposed-defaults.md` section 15 (**PROPOSED, not yet reviewed**; its three existing-code mappings were approved on 2026-10-27, the rest is still proposed).
- Callable only, schedule in M13: `AuthCleanupService.run`. Admin (M12) reuses `SessionsService.revokeAllSessions`, `CourseTeamService.*InTx` / `ownsCourses` and `EnrollmentsService.remove` / `reinstate`.
- Open: MinIO development store, the first CI run, `npm audit` (M14), the private Vimeo hash (M10b), `PER_CONVERSATION_BURST` is done (M10c).

---

## M12 — Layer 3 (Admin) and seed

**Requires:** M11 · **Unblocks:** M13. Admin owns no tables and no business rules (decision 47).

- [x] Users, applications, revoke-teacher, suspend/unsuspend, admin-role (under `ADMIN-SET` advisory lock)
- [x] Courses: list, get, outline, lesson review (read-only, no audit), `lock`, `unlock`, `restore`, ownership transfer, student remove/reinstate
- [x] Catalog management incl. tag merge
- [x] Reports: queue, detail, separately audited `context`, dismiss, action (can delete message, closes sibling reports)
- [x] Audit-log viewer, stats
- [x] First-Admin seed script (env-based, email verified, only if no Admin exists)

**Tests:**
- [x] Two Admins demoting/suspending each other → at least one active Admin remains; `CANNOT_SUSPEND_SELF` is 400
- [x] Revoke teacher vs ownership transfer: never a revoked Owner, either order
- [x] Suspension atomic (status, Assistant rows removed and not restored on unsuspend, `revokeAllSessions`, audit); next request 403, refresh fails, sockets get `session:revoked` and disconnect
- [x] **Bug 2 scenario:** sibling-report resolution has no deadlock; second gets `REPORT_ALREADY_RESOLVED`
- [x] Owner restore vs Admin lock → course ends locked; `unlock` leaves `ARCHIVED`; `restore` publishes; both `COURSE_NOT_LOCKED` when unlocked
- [x] Lock on already-archived course; locked-course visibility re-verified end-to-end
- [x] `context` writes `REPORT_CONTEXT_VIEWED` each time (~10 messages each side); other report endpoints don't
- [x] Tag merge skips courses already holding the target tag
- [x] Every `/admin/*` endpoint returns 403 to non-Admins
- [x] Seed script idempotent

**Status (2026-10-27):** implemented and verified. Admin (`src/modules/admin`, 33 endpoints under `/admin/*`, all `@Roles('ADMIN')`) owns no table: each action is one transaction that calls the owner's primitive in the global lock order. The primitives were added to their owners: Users (`grantAdminRole`, `revokeAdminRole`, `isActiveAdmin`, `countOtherActiveAdmins`, `countActiveAdmins`), Courses (`CourseAdminService`: list, get, outline, lesson review, `lock`/`unlock`/`restore`; `CourseTeamService.removeAssistantRowsOfInTx`), Catalog (`CatalogAdminService`: categories, tag list, merge), Moderation (`ReportQueueService`: queue, detail, `context`, `closeInTx`), Chat (`MessagesService.deleteAsModeratorInTx`). Seed: `npm run seed:admin` (`FirstAdminSeeder`).
- Tests: `admin-users` (27), `admin-courses` (20), `admin-reports` (17), `admin-suspension-socket` (1, a real socket client). Every roadmap test above is covered; the sibling-report test also proves the lock order (a request waiting at the Message holds no Report lock). Mutation checks (about 55 on the lock, protection, audit and privacy lines): all caught except the survivors below, which are defense in depth behind another guard: the actor re-check after `ADMIN-SET` and the last-Admin check in `suspend` (the actor is itself an active Admin, so the count is never zero without a parallel request that the lock already orders), the Course-X read lock on `lock` (the conditional `UPDATE` takes the same row lock), the course lock in `removeAssistantRowsOfInTx` (the User-X lock already stops new teams), ascending order in the tag-merge and report locks (single statements; the Message lock already orders resolutions), the category in-use and slug-clash checks (the foreign key and the unique index answer the same 409), and the `ADMIN-SET` lock in the seed (the unique email index).
- Recorded choices where the documents are silent: `docs/proposed-defaults.md` section 16 (**APPROVED by the owner on 2026-10-27**; the eight mutation survivors above are kept as recorded).
- Open: the private Vimeo hash (M10b), the MinIO development store, the first CI run, `npm audit` (M14); scheduling of the cleanup services (M13).

---

## M13 — Scheduling, conformance and hardening

**Requires:** M12 · **Unblocks:** M14

- [x] Wire `@nestjs/schedule`: cleanup jobs (Auth tokens, Files orphans, Notification retention) and nightly sweepers (Chat channel reconcile, Progress full recheck); document single-instance assumption (decision 162)
- [x] Drift tests: break channel membership and a completion, run sweeper, assert repair **and** log entry; second run changes nothing

**Conformance suites (generated from M4 files):**
- [x] Permission matrix: every endpoint × role/relationship → exact outcome and status
- [x] Error registry: every code reachable by a test; status matches registry
- [x] Check order (`429 → 401 → 403 ACCOUNT_SUSPENDED → guards → 400 → 409`) on sample endpoints
- [x] Mass assignment: every request DTO rejects unknown fields
- [x] Leak scan: no `email` outside `/me` and Admin, no `password_hash`, `token_hash`, `message_snapshot` or deleted-message body in responses
- [x] Full Phase 9 concurrency suite, looped to expose flakiness
- [x] `EXPLAIN` checks: unread notifications, history by `seq`, active members, completion recheck, file-reference check
- [x] Final dependency-cruiser run, migration replay/drift check, Swagger completeness

**Security pass:**
- [x] Cookie flags, CORS, Helmet
- [x] Origin checks on refresh, logout and socket handshake
- [x] Log redaction
- [x] Correct rate-limit class on every endpoint

**Status (2026-10-27):** implemented and verified. `@nestjs/schedule` 12.0.2 (exact pin) is imported once in `AppModule`; five jobs, each in its own module and run through `runGuarded` (no overlap, failures logged by name): Auth cleanup 03:10, file cleanup 03:20, notification retention 03:30, channel reconcile 03:40, completion recheck 03:50 UTC (`common/constants/job-schedule.ts`). The single-instance assumption is documented there and in the architecture. Both sweepers log when they repair; a second run changes nothing and logs nothing.
- **Conformance suites** (`test/conformance/`, generated from the route metadata and the M4 constants): `permission-matrix` (every route classified; every course route x 9 relationships x 5 course states, every role route x 4 role combinations, against an independent oracle), `error-registry` (a reproducer for each of the 37 codes in a `Record<ErrorCode, ...>`), `check-order`, `mass-assignment` (every body and query DTO of every route), `leak-scan` (every GET route as 7 kinds of caller), `openapi` (routes and operations are the same set; schemas, security, errors, static leak scan), `explain` (five hot queries on tens of thousands of rows), `security` (Helmet, CORS, cookie, Origin on refresh/logout/socket, log redaction, rate-limit class of every route and the real limits).
- **Drift tests**: `jobs.integration-spec.ts` (13): the schedule, breaking channel membership and a completion then running the job (repair and log), a second run (no change, no log), the three cleanups, and a failing job.
- **Concurrency loop**: `npm run test:concurrency [-- N]` runs 16 race-bearing specs (423 tests) N times in a row; 5 runs in a row passed. Migration replay and drift: `prisma migrate diff` from the migrations to the schema is empty; the test database is rebuilt from the migrations on every run. Dependency-cruiser: no violations (235 modules).
- Mutation checks on the job code (12): all caught. Two found gaps that were fixed with tests (a job that bypasses the guard; the AppModule import of the scheduler).
- Recorded choices where the documents are silent: `docs/proposed-defaults.md` section 17 (its four lead items, the new dependency, the two Google endpoints in the STRICT class, the report snapshot exception in Admin responses and the widened enrollment route, were **APPROVED on 2026-10-27**, with the single-instance assumption and the `EXPLAIN` limitation: synthetic tens-of-thousands-row data is a regression guard, not a production-volume benchmark; the rest is still proposed).
- Open: MinIO development store, the first CI run, `npm audit` (M14), the private Vimeo hash (M10b).

---

## M14 — Release readiness

**Requires:** M13

- [ ] **Select the production hosting provider and verify its compatibility (deployment requirement, Decision 165).** The provider is **not selected** and nothing has been verified. From the provider's official documentation confirm: PostgreSQL 18 or later is offered (`uuidv7()` is core in 18, no extension needed); `pg_trgm` is allowed; advisory locks and `set_config(..., true)` behave correctly behind its connection pooler; backups and a tested restore are possible; S3-compatible private/public bucket policies are possible. Do not deploy to production before this is done.
- [x] **Dependency review (deferred from M8, owner decision 2026-10-26):** `npm audit --omit=dev` reported 5 advisories (1 moderate, 4 high) in the scaffold dependencies `@nestjs/core`, `@nestjs/platform-express`, `body-parser`, `multer` and `fast-uri`; none comes from the packages added in M6-M8. Review each advisory against how the application uses it, update to tested versions in a separate change (not mixed with feature work), and re-run the full suite
- [ ] **First CI run on GitHub (open since M3):** the workflow has never run there. Check the PostgreSQL 18.6 service, the `openapi:export` drift step and the full test layers; note that `mail-smtp.integration-spec.ts` skips itself where Mailpit is not running
- [ ] **Revisit the database pool size** (`TRANSACTION_LIMITS.POOL_MAX`, default 10) against the selected provider's connection limits and pooler (approved 2026-10-25)
- [x] Same-site deployment (shared registrable domain or reverse proxy); trusted-proxy config (`TRUST_PROXY` hop count; the rate limiter sees the proxy's IP if it is wrong); `Secure` cookies; validated production environment
- [x] S3 bucket policy: private attachments, public avatars/covers
- [x] Database backups **and a tested restore** (deleted-message text persists in backups, decision 86)
- [x] Runbook: sweeper logs signal a bug; JWT secret rotation logs everyone out; how to create an Admin
- [x] Frontend contract notes: share one in-flight refresh; refresh before socket reconnect; render private pages client-side; sort messages by `seq` and detect gaps; render Markdown safely (the server stores it unsanitized; raw HTML disabled or sanitized, no `javascript:` links); send `clientId` as a UUID from `crypto.randomUUID()` and reuse it on every retry of the same message; send `enrollmentPolicy` explicitly when creating a course; treat 503 `SERVICE_UNAVAILABLE` as "try again later"; 401 vs 403 handling (`INVALID_CURRENT_PASSWORD` is 403 by design)
- [x] OpenAPI document handed to the frontend

**Status (2026-10-27):** release-readiness work that does not depend on a provider or on GitHub is **done and verified**; three items are **OPEN** and need the owner or the outside world.
- **Done:** dependency review (`npm audit` 0 advisories, lockfile-only update in its own commit `fd0ecbf`; CI audit step); production build and start (`npm run smoke:prod`, which found and fixed two start-up logging problems); `.env.example` complete and tested; OpenAPI export consistent (137 operations); migration drift empty; all suites green (unit 554, e2e 57, integration all passed, concurrency loop); runbook, frontend contract notes, known limitations and the deployment sequence in **`docs/release.md`**; the S3 policy specified (applying it needs the provider); the backup and **restore rehearsal tool** run against the test database (25 tables, all row counts equal, `pg_trgm`, `uuidv7()` and the audit trigger intact).
- **OPEN for production: the hosting provider.** Railway is the selected STAGING candidate (2026-10-28; staging only, PostgreSQL 18.6, no PgBouncer, a separate S3-compatible store for public files, an HTTPS email transport still to be chosen, daily/manual volume backups accepted for staging only); no production provider is selected,, so its PostgreSQL 18, `pg_trgm`, pooler, backup/restore and bucket-policy compatibility (Decision 165) is unverified, and the **pool size** (`POOL_MAX` 10) cannot be compared with a provider's limit. `docs/release.md` section 4 is the checklist.
- **OPEN, needs GitHub: the first CI run.** Nothing was pushed. The workflow gained the audit, drift, build, smoke and concurrency steps; each was run locally, none on GitHub.
- **OPEN, needs the provider: a restore on the provider's own backup service**, and applying and testing the bucket policy.
- Recorded choices where the documents are silent: `docs/proposed-defaults.md` section 18 (**PROPOSED, not yet reviewed**).
- Still unresolved by decision: the private Vimeo hash (M10b) and the MinIO development store.

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

- **Decided:** 1–168 (165: PostgreSQL 18+ and database-generated `uuidv7()`; 166: `SERVICE_UNAVAILABLE` 503 in the status policy; 167: M6 infrastructure choices; all approved 2026-10-25; 168: Enrollment row `FOR NO KEY UPDATE` when marking a lesson complete, approved 2026-10-26)
- **Open design questions:** none
- **Unresolved deployment decision:** the production hosting provider is not selected. It blocks nothing before M14; its PostgreSQL 18 compatibility check is a deployment requirement (M14).
- **Initial implementation defaults:** the values in `docs/proposed-defaults.md` were approved by the owner on 2026-10-25 as initial defaults; they are not requirements of the original documents.
- **Next decision number:** **168**