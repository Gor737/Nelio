# M1 — Spike A report: Prisma, manual SQL, errors, transactions

> **Status:** experiments complete, 69/69 spike tests pass · **Date:** 2026-10-24 · **Branch:** `spike/m1-prisma-spike-a` (not committed)
> **Stack under test (installed, not "latest"):** Prisma / `@prisma/client` / `@prisma/adapter-pg` **7.10.1**, `pg` 8.23.1, `uuid` 14.0.3, PostgreSQL **18.6** (Compose), Node 22.23.2, TypeScript 6.0.3, `tsx` 4.23.15.
> **Where:** `spikes/m1-spike-a/` (own `package.json`, own disposable databases `nelio_spike_a`, `nelio_spike_a_shadow`, `nelio_spike_a_replay`). Nothing under `apps/backend` was touched.
> **Legend:** **Verified** = observed in a test or CLI run here (evidence in `spikes/m1-spike-a/tests` and `evidence/`). **Docs** = taken from documentation only. **Not verified** = not tested.

## Verdict

No numbered decision is overturned, but **one roadmap assumption is contradicted (C3)** and one more is different in a way that needs recording (B4). Per the M1 Exit, a contradiction goes through the Change Protocol **before M2**. Current handling (owner direction): the PostgreSQL 18 minimum is recorded as **Decision 165, Proposed / awaiting owner approval**; the Prisma/migration findings (former "166") are handled as operational rules in `roadmap.md` M5 and in the M1 checklist, without a separate numbered decision. Section 3 below is the original proposal text and is kept for history. Other rows marked "Different" are findings that need no decision change. The most important surprises: (1) Prisma **drops** hand-written GIN indexes and generated columns unless they are declared in the schema, and a generated `tsvector` declared as `Unsupported` makes Prisma emit an `ALTER ... DROP DEFAULT` that PostgreSQL rejects; (2) the SQLSTATE lives in `error.meta.driverAdapterError.cause.originalCode`, while Prisma's own `code` is inconsistent (P2039 for CHECK, P2034 vs P2010 for deadlocks); (3) PostgreSQL 18's native `uuidv7()` makes PG 18 a hidden minimum.

## 1. Assumption table

| # | Assumption / question | Status | Evidence | Decisions |
|---|---|---|---|---|
| A1 | `prisma-client` generator with required `output`, ESM, no Rust engine | **Confirmed** | `generate` → `generated/prisma`; query-compiler runtime, no engine binary (`a-setup`). Docs: `prisma-client` is the default, `prisma-client-js` deprecated | 99 |
| A2 | Driver adapter is required | **Confirmed** | `new PrismaClient({})` → *"PrismaClient requires a driver adapter to connect to your database, but none was provided."* `@prisma/adapter-pg` works | 99, 101 |
| A3 | Multi-file schema, one file per domain | **Confirmed (7.10.1)** | `prisma.config.ts` → `schema: 'prisma/schema'` (a directory); 5 files, relations across files; `validate`, `generate`, `migrate` all load it. The datasource URL lives in `prisma.config.ts`, not in the schema | 101 |
| A4 | Current docs describe the version we use | **Different** | The docs site now documents **Prisma 8** (`contract` glob, `// use prisma-8` marker); npm `latest` is `8.0.0-rc.27`. Pin 7.10.1 and read 7.x docs | 101 |
| B1 | UUID v7 can be database-generated | **Confirmed** | `DEFAULT uuidv7()` (native in PG 18, `pg_catalog`, no extension): version 7, timestamp ≈ now, 300 sequential + 500 bulk inserts sorted in creation order. Docs: *time-ordered*; PG docs do **not** promise monotonicity | 65 |
| B2 | Application-generated alternatives | **Confirmed** | Prisma `@default(uuid(7))` and `uuid` v14 `v7()` both give version 7, sorted over 300/5000 ids. `uuid(7)` leaves **no DB default**, so raw/seed inserts fail (23502) | 65 |
| B3 | Which one to use | **Recommendation** | DB default `uuidv7()` for all keys (works for Prisma, raw SQL, seeds, migrations); `uuid` package only where an id is needed before the INSERT | 65 |
| B4 | Cost of B3 | **Different** | Requires **PostgreSQL ≥ 18**; no decision records the PG major version (M0 says "deployment major version") | 65 |
| C1 | `--create-only` + hand-appended SQL (partial unique index, CHECK, generated `tsvector`, trigger) | **Confirmed** | `migrate dev --create-only --name init`, SQL appended, `migrate dev` applied it (shadow DB replay OK). Each object has a test that tries to break it (`c-handwritten`): 23505, 23514, 428C9, trigger overrides client value | 102 |
| C2 | Next migration leaves partial unique index, CHECK, trigger alone | **Confirmed** | `evidence/C1-…sql`: none of the three appears in the generated diff | 102 |
| C3 | Next migration leaves **GIN indexes and generated columns** alone | **Contradicted** | `evidence/C1-…sql`: `DROP INDEX app_user_name_trgm_idx`, `DROP INDEX course_search_idx`, `DROP COLUMN name_norm` | 102 |
| C4 | Generated `tsvector` can be declared `Unsupported("tsvector")?` | **Different (hazard)** | Prisma reads the expression as a default and plans `ALTER COLUMN search_vector DROP DEFAULT`, which PostgreSQL rejects (`42601`, "is a generated column") | 102 |
| C5 | Fix for C3/C4 | **Confirmed** | Declare them: `@@index([…], type: Gin)`, `ops: raw("gin_trgm_ops")`, `@default(dbgenerated("<exact text from `db pull --print`>"))`. Then `migrate diff --exit-code` = 0 live and from migrations; a later real migration (`ADD COLUMN`) contains only that statement (`evidence/C2-…sql`) | 102 |
| C6 | Partial unique index can be declared in the schema | **Different** | Needs preview feature `partialIndexes` (validation error P1012). Left undeclared; C2 shows Prisma ignores it | 102 |
| C7 | Shadow database with `pg_trgm` | **Confirmed, with a rule** | The shadow DB is empty: the migration must itself `CREATE EXTENSION IF NOT EXISTS pg_trgm`. Without it, replay fails: P3006/P3018, `42704 operator class "gin_trgm_ops" does not exist` | 102 |
| C8 | Replay from scratch + drift gate | **Confirmed** | `migrate deploy` on an empty DB applies the migration; `migrate status` up to date; `npm run drift` and `drift:live` exit 0 | 102 |
| C9 | `migrate dev` usable non-interactively | **Different** | `--create-only --name x` works with no TTY. Plain `migrate dev` (no `--name`, pending migration) did not return within 120 s without a TTY and was stopped; cause not isolated, a prompt is the likely reason. Always pass `--create-only --name` | 102 |
| C10 | Typed client sees generated columns | **Different (benign)** | `nameNorm`/`searchVector` are absent from create types and results: writing → `PrismaClientValidationError`; reading needs raw SQL (and `search_vector::text`) | 102 |
| D1 | Composite FKs against `(id, course_id)` unique targets | **Confirmed** | Lesson→Section, LessonCompletion→Enrollment/Lesson, Message→ConversationMember. Cross-course lesson, cross-course completion, non-member sender: all `23503` (P2003 via Prisma); Prisma `include` across composite relations works | 101, architecture 356 |
| D2 | RESTRICT surfaces like other FK errors | **Different** | Deleting a parent with children gives **`23001 restrict_violation`**, not 23503. Prisma: model query → `P2003`, raw → `P2010`; `cause.kind = "RestrictViolation"` | 99, 161 |
| D3 | Course deletion order | **Confirmed** | One `DELETE course` with a completion fails (`23001`); lessons→sections→course in one transaction works (Architecture 238, 673) | 88, 161 |
| E1 | Exact errors (SQLSTATE · Prisma code · `cause.kind`) | **Verified** | unique `23505` · P2002 · UniqueConstraintViolation; FK `23503` · P2003 · ForeignKeyConstraintViolation; **CHECK `23514` · P2039 · `postgres`**; not-null `23502` · P2010 (raw); syntax `42601`, missing table `42P01`, bad cast `22P02` · P2010; deadlock `40P01` · **P2034** (model queries) or **P2010** (raw) · TransactionWriteConflict; serialization `40001` · P2034; NOWAIT `55P03` · P2010 | 159 |
| E2 | Reliable SQLSTATE access | **Confirmed** | `error.meta.driverAdapterError.cause.originalCode` is present for every database error above; Prisma's top-level `code` is not stable enough to branch on | 159 |
| E3 | Unique violations must be handled outside the failed transaction | **Confirmed** | After a 23505 inside `$transaction`, the next statement fails `25P02` | 159 |
| F1 | Interactive transaction defaults | **Confirmed** | `timeout` **5000 ms**, `maxWait` **2000 ms** (P2028 after 2002 ms with a 1-connection pool). Client-wide `transactionOptions` and per-call options both work, per-call wins | 159 |
| F2 | What a timeout does | **Different** | The callback is **not cancelled**: a 6 s statement ran to completion (6.1 s), then commit failed with P2028 and the row was rolled back. Use `statement_timeout`/`lock_timeout` for real bounds | 159 |
| F3 | Throw ⇒ rollback; return-then-throw | **Confirmed** | Throwing inside loses the family revocation; returning `{kind:'reuse'}` commits it and the caller then throws (Architecture 661). 8 concurrent rotations: exactly 1 wins the conditional `used_at` update | 145, 159 |
| F4 | Default isolation | **Confirmed** | `read committed` | 159 |
| G1 | Parameterized `FOR SHARE` / `FOR NO KEY UPDATE` | **Confirmed** | Values bind as parameters; a table name cannot (`42601`); `Prisma.raw` of a whitelisted name works; hostile id stays a value (22P02) | 159, 160 |
| G2 | Lock-mode behavior | **Confirmed** | NO KEY UPDATE holder: `FOR SHARE NOWAIT` → 55P03, but an FK insert (enrollment) proceeds in 5 ms; `FOR UPDATE` holder blocks it (55P03 with `lock_timeout`); SHARE+SHARE coexist, NO KEY UPDATE vs SHARE conflicts. Full matrix is Spike B (M2) | 160 |
| G3 | Advisory transaction locks | **Confirmed** | `pg_advisory_xact_lock(hashtextextended($1,0))` via **`$executeRaw`** (void result breaks `$queryRaw`); second taker waited 503 ms, try-lock `false` while held, free after commit, different keys independent | 160 |
| H1 | `timestamptz` | **Confirmed** | JS `Date` = UTC instant; offset input normalized; JSON gives ISO `…Z`; microseconds truncated to ms; independent of session time zone | 65 |
| H2 | `bigint` | **Confirmed, with trap** | Returned as JS `BigInt`, exact above 2^53; **`JSON.stringify` throws** ("Do not know how to serialize a BigInt"); raw `count(*)` is a BigInt (`::int` gives number); a JS number is accepted on input | 161 (`seq`) |
| H3 | `jsonb` | **Confirmed, with traps** | Keys reordered/whitespace normalized; integers > 2^53 stored exactly but read back lossy; `Date` → ISO string; **BigInt inside Json is silently stored as a string**; JSON null needs `Prisma.JsonNull`; path filters work | 65 |
| H4 | Enums | **Confirmed** | String unions; invalid value `22P02`; `ALTER TYPE … ADD VALUE` then use in the same transaction fails `55P04` — split into separate migrations | 65 |
| I1 | Parameterized `tsvector` search | **Confirmed** | `websearch_to_tsquery('simple', $1)` never throws on hostile input; `to_tsquery` with free text throws `42601`; `:*` prefix works with a sanitized token; Armenian text matches (DB locale `en_US.utf8`, non-C); a raw `tsvector` column cannot be deserialized (cast to text) | `simple` config (search decision) |
| I2 | `pg_trgm` similarity | **Confirmed** | `similarity()` and `%` parameterized; typo tolerant; Armenian names work; `ILIKE` with user text must escape `% _ \`; planner uses the GIN trigram and tsvector indexes (seq scans disabled for the 5-row table) | user-name search decision |

## 2. Whitelisted `lockRow` helper — on paper only (not implemented)

```ts
const LOCKABLE = { course: 'course', user: 'app_user', conversation: 'conversation', enrollment: 'enrollment' } as const; // closed list, one entry per table the catalog (Decision 161) locks
const MODES = { SHARE: Prisma.raw('FOR SHARE'), NO_KEY_UPDATE: Prisma.raw('FOR NO KEY UPDATE') } as const;
lockRow(tx, table: keyof typeof LOCKABLE, id: string, mode: keyof typeof MODES)
  // tx.$queryRaw`SELECT id FROM ${Prisma.raw(LOCKABLE[table])} WHERE id = ${id}::uuid ${MODES[mode]}`
lockAdvisory(tx, key: AdvisoryKey /* enum, e.g. 'ADMIN-SET' */)
  // tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
```
`Prisma.raw` only ever receives values from the closed maps; the id is always a bound parameter; no string argument reaches SQL text. Lock order (Decision 160) is enforced by the caller, not the helper.

## 3. Proposed Change Protocol entries (proposals only, nothing amended)

*Historical text written at the end of the spike. Only item 1 became a decision record (Decision 165, Proposed). Item 2 was never raised as a numbered decision, so the number 166 in this section is a draft label only; Decision 166 does not exist and the number remains available.*

1. **165 — PostgreSQL 18 is the minimum database major version.** Option A (recommended): keep `DEFAULT uuidv7()` everywhere, record "PostgreSQL 18" in Decision 65 and the M0 wording. Option B: any PG, generate ids with `uuid` v7 in the application and lose DB defaults for raw inserts.
2. **166 — Decision 102 addendum (hand-written SQL rules).** (a) Declare GIN indexes and generated columns in the Prisma schema (`type: Gin`, `ops: raw(…)`, `dbgenerated` with the exact text from `db pull --print`); leave partial indexes, CHECKs and triggers undeclared. (b) Every `--create-only` migration is followed by `migrate diff --from-migrations … --to-schema … --exit-code` (and the same against the live DB), enforced in CI. (c) Migrations that use `pg_trgm` create the extension themselves. (d) Enum `ADD VALUE` lives alone in its migration.

## 4. Notes for later milestones (no decision change)

- **M6 error mapper:** branch on `cause.originalCode` only; treat `23503` and `23001` as the same "referenced/in use" class (`FILE_IN_USE`, orphan cleanup); retry set `40P01`, `40001` regardless of Prisma code (P2034 or P2010).
- **M6 `runInTransaction`:** set `statement_timeout`/`lock_timeout` with `SET LOCAL`; Prisma's `timeout` does not cancel work. Handle void results with `$executeRaw`.
- **API/DTO layer:** `BigInt` (`seq`, counts) needs explicit string/number mapping; never put Prisma rows straight into `JSON.stringify`.
- **Deployment:** database encoding UTF-8 with a non-C locale (Armenian tokenization and trigrams depend on it).
- **Spike deviation:** the spike used `CASCADE` on Enrollment→LessonCompletion and Message→Conversation to keep fixtures short; Architecture 231 says `RESTRICT`. The checked mechanics (composite targets, same-course rejection) do not depend on it; the production schema follows the architecture.

## 5. Not verified

`prisma-client-js` generator (docs only: deprecated); upgrade path to Prisma 8; interactive `migrate dev` prompts; behavior under pool exhaustion beyond `maxWait`; `statement_timeout`/`lock_timeout` as `SET LOCAL` inside Prisma transactions; row-lock conflict matrix and lock ordering under load (Spike B, M2); performance and index selectivity on realistic volumes.

## 6. Reproduce

```
docker compose up -d --wait                      # repo root, PostgreSQL 18.6 must be running
cd spikes/m1-spike-a && npm install
npm run db:create                                # nelio_spike_a, nelio_spike_a_shadow (docker exec, no secrets printed)
npm run generate && npm run validate
npm run prisma -- migrate deploy                 # replays prisma/migrations (hand-written SQL included)
npm run drift ; npm run drift:live               # both must print "empty migration", exit 0
npm test                                         # 69 tests, ~22 s, serial
```
Credentials: `scripts/env.sh` runs Node with `--env-file` pointing at the main checkout's `.env` (override with `NELIO_ENV_FILE`); nothing is printed or stored. References: [Prisma PostgreSQL / driver adapters](https://www.prisma.io/docs/orm/overview/databases/postgresql), [Prisma generators](https://www.prisma.io/docs/orm/prisma-schema/overview/generators), [Prisma multi-file schema](https://www.prisma.io/docs/orm/prisma-schema/overview/location) (Prisma 8 wording; 7.10.1 behavior verified by experiment), [PostgreSQL 18 UUID functions](https://www.postgresql.org/docs/18/functions-uuid.html), [PostgreSQL 18 error codes](https://www.postgresql.org/docs/18/errcodes-appendix.html).
