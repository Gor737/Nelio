# M2 — Spike B report: PostgreSQL lock modes and concurrency

> **Status:** all 13 roadmap claims confirmed, none failed · 70/70 spike tests pass on three consecutive full runs · **Date:** 2026-10-25 · **Branch:** `spike/m2-spike-b`
> **Stack under test:** PostgreSQL **18.6** (Compose), `pg` 8.23.1, Prisma / `@prisma/adapter-pg` **7.10.1** (Phase 8 only), Node 22.23.2, TypeScript 6.0.3. Default `deadlock_timeout` = 1 s, isolation `read committed`.
> **Where:** `spikes/m2-spike-b/` (local-only, untracked; own `package.json`; disposable database `nelio_spike_b`, guarded so no helper can touch another database). Nothing under `apps/backend` was touched.
> **Legend:** **Verified** = observed by a test here (evidence in `spikes/m2-spike-b/tests` and `evidence/*.tap`). **Docs** = from PostgreSQL documentation. **Not verified** = not tested.

## Verdict

Every claim of Decisions 159, 160 and 161 that the roadmap lists for M2 held. **No failed claim, so Decisions 159/160 are not amended and no Change Protocol entry is needed before M3.** The spike produced refinements for M6 (section 4) and two hazards worth a rule (an unsafe single-statement role swap; `SET LOCAL` cannot take parameters). Decision 165 was not touched and nothing in this milestone depends on it (the spike schema uses `gen_random_uuid()`).

## 1. Roadmap claims

| # | Claim | Status | Evidence | Decisions |
|---|---|---|---|---|
| 1 | Two `FOR SHARE` holders coexist (Course-S ∥ Course-S) | **Confirmed** | `pg_blocking_pids` empty for both, 17 ms (Phase 1 smoke, Phase 2) | 160 |
| 2 | `FOR NO KEY UPDATE` conflicts with share holders both ways | **Confirmed** | Full 4×4 matrix, 16 ordered pairs, measured by `pg_blocking_pids`: 10 conflicts / 6 free, symmetric, identical to PostgreSQL 18 docs Table 13.3; blocked statements stay pending while the holder is open and resume 2–5 ms after commit **or** rollback; repeatable over 3 passes (`FFFCFFCCFCCCCCCC`) | 160 |
| 3 | Child-table INSERT (Enrollment → Course) is not blocked by `FOR NO KEY UPDATE` | **Confirmed** | INSERT done in 4 ms, no blocker, commits while the holder is still open; the natural Course-X statement (`UPDATE course SET note`) also takes NO KEY UPDATE and does not block; 8 parallel inserts all free. **The FK check takes `FOR KEY SHARE`** (a `FOR UPDATE NOWAIT` probe fails `55P03`, a `NO KEY UPDATE NOWAIT` probe succeeds). `FOR UPDATE` blocks every insert by pid | 160 |
| 4 | `UPDATE conversation SET last_seq = last_seq + 1` does not block inserting a `ConversationMember` | **Confirmed** | Member insert finished with no blocker while the UPDATE was open; a second `last_seq` UPDATE waits and then returns 2 | 161 |
| 5 | After a lock wait the next statement sees the other transaction's committed data (Rule 1) | **Confirmed** | Read before the lock: `v1` (stale); the locking read returns `v2`; the next statement sees `v2` — for both `FOR NO KEY UPDATE` and `FOR SHARE` | 159 |
| 6 | A unique violation aborts the rest of the transaction | **Confirmed** | `23505` then `25P02` for the next statement; `COMMIT` of the aborted transaction reports `ROLLBACK` and drops earlier writes (also Spike A E3) | 159 |
| 7 | Parallel conditional updates: exactly one reports 1 row | **Confirmed** | Waiting updater re-checks its predicate: 0 rows after the winner commits, 1 row if the winner rolls back; 50 rounds × 10 parallel updates with competing targets: exactly 1 winner every round and the stored state is the winner's | 161 |
| 8 | Deliberate deadlock detected; the error code is the one the retry helper handles | **Confirmed** | Opposite-order locks: exactly one transaction gets `40P01 deadlock detected` after ~990 ms (`deadlock_timeout` 1 s), the other completes. Retry set is `{40P01, 40001}`; a prototype retry loop over a **real** deadlock retries the victim exactly once and both transactions finish (also through Prisma, error shape in 4) | 159 |
| 9 | An advisory lock serializes "count Admins, then demote" | **Confirmed** | Without a lock two Admins demoting each other leave **0** active Admins (the bug is real); lock-then-count: the second waits by pid, recounts 1, refuses; counting **before** the lock still ends with 0; 25 rounds × 3 Admins: always ≥ 1 remains | 160 |
| 10 | One-Owner partial unique index fails on promote-first and passes on demote-first | **Confirmed** | Promote-first → `23505` on `course_teacher_one_owner`; demote-first → exactly one Owner. Concurrent transfers: without locks the loser gets `23505` (never two Owners); with C-X + re-read after the lock it fails cleanly with no database error; 15 rounds × 3 candidates: 1 transferred, 2 refused, 0 DB errors | 160, 161 |
| 11 | A duplicate `client_id` insert rolls back the `last_seq` increment (no `seq` gap) | **Confirmed** | 8 parallel sends of one `client_id`: 1 message, 7 reload the original, `last_seq` 1; 8 distinct sends from 4 senders: `seq` 1..8 contiguous; mixed load: exactly 4 messages; a non-member send rolls the increment back; same `client_id` from two senders is not a duplicate. 10 rounds each. **Anti-pattern verified:** catching the violation with a `SAVEPOINT` around only the INSERT leaves `last_seq` 2 with one message (a gap) | 161 |
| 12 | `INSERT … ON CONFLICT DO NOTHING` under concurrency (tags, completions, blocks) | **Confirmed** | `course_tag`, `lesson_completion`, `block`: 20 rounds × 8 parallel inserts, 0 errors, exactly one row inserted per round; against an **uncommitted** first insert it waits (0 rows after commit, 1 row after rollback), a plain INSERT gets `23505`; FK (`23503`) and CHECK (`23514`) violations still raise | 161 |
| 13 | Finish designs (on paper) of `runInTransaction` and `lockRow` | **Done** | Section 3; prototypes validated against real PostgreSQL through Prisma (Phase 8) | 159 |

**Additional scenarios (owner-approved extras).**
- **S14, Course `DELETE` vs Enrollment `INSERT`:** the INSERT waits behind an open `DELETE`; after the DELETE commits the FK check fails `23503`, after rollback it succeeds. An open INSERT makes the `DELETE` wait; after the INSERT commits the DELETE fails **`23001 restrict_violation`** (`enrollment_course_id_fkey`), after rollback it succeeds. `Enrollment → Course` and `→ User` are `ON DELETE RESTRICT` in the catalog. RESTRICT baseline without concurrency: `23001`.
- **Lock order (Decision 160):** the reverse of User → Course deadlocks (`40P01`); locking rows of one kind in descending id order deadlocks; the global order with ascending ids ran 50 rounds × 4 parallel transactions with 0 errors.
- **Decision 161 "Bug 2":** resolving a report with the own Report locked before the Message deadlocks (`40P01`); Message first, then sibling Reports ascending ran 50 rounds × 4 resolvers with 0 deadlocks, exactly one resolution and `REPORT_ALREADY_RESOLVED` for the rest.

## 2. Lessons from Spike A that were applied
Errors are classified by SQLSTATE only (`error.code` for `pg`, `meta.driverAdapterError.cause.originalCode` for Prisma); void functions use `$executeRaw`; tables are never bound parameters; blocking is detected with `pg_blocking_pids`, never with sleeps; the default `timeout` of Prisma does not cancel statements, so Phase 8 verified `statement_timeout` instead; tests run serially against a disposable database.

## 3. Final designs for M6

**`runInTransaction(prisma, fn, options)`** (prototype: `spikes/m2-spike-b/lib/run-in-transaction.ts`)
- Interactive Prisma transaction; the **whole callback** is retried on SQLSTATE `40P01` and `40001` (nothing else), at most 3 attempts, jittered backoff (20 ms × attempt). Non-retryable errors surface immediately. The callback must be re-runnable: no mail, hashing, token verification or network inside it (Decision 159).
- First statement: `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)` — transaction-local, **parameterizable**, no leakage to the next user of the pooled connection. Proposed defaults: `statement_timeout` 8 s, `lock_timeout` 5 s, Prisma `timeout` 10 s (greater than both), `maxWait` 5 s. `SET LOCAL … = $1` is a syntax error (`42601`); a literal `SET LOCAL` via `$executeRawUnsafe` works but needs a validated integer.
- A deadlock victim's locks are held until `ROLLBACK`; Prisma rolls back on throw, so the survivor continues only after the victim's transaction ends. Hence retry must start a **new** transaction, never reuse the failed one.
- Returns the value (and logs attempts). After-commit effects are emitted by the caller **after** `runInTransaction` returns, which preserves return-value-commit-then-throw (Spike A F3).

**`lockRow(tx, table, id, mode)`**
- `table` is a key of a closed map (`user → app_user`, `course`, `enrollment`, `conversation`, `message`, `report`; extended only by Decision 161's catalog); `mode` is `SHARE` (S) or `NO_KEY_UPDATE` (X); the id is always a bound `::uuid` parameter. Unknown table or mode throws **before any SQL**, including inherited property names such as `toString` (checked with `Object.hasOwn`). Returns whether the row exists.
- `lockRows` takes ids **ascending**; callers follow the global order advisory → User → Course → Conversation → child rows (Message before Report). `lockAdvisory(tx, 'ADMIN-SET')` uses `$executeRaw` (void result).

**Transaction recipes confirmed by tests (SQL shapes for the owning modules)**
- *Conditional transition (Enrollment):* `UPDATE … SET status = $to WHERE id = $id AND status = $from`; row count 1 wins, 0 means someone else won.
- *Send message:* `UPDATE conversation SET last_seq = last_seq + 1 … RETURNING last_seq`; member row `FOR SHARE`; INSERT; on `23505` for `(sender_id, client_id)` the transaction is rolled back **first**, then the original is re-queried. Never wrap the INSERT in a savepoint.
- *Ownership transfer:* C-X, re-read the Owner **after** the lock, demote in one statement, promote in the **next** one. The index is checked per row: a single-statement `CASE` swap failed 4 times out of 6, so it is not a substitute.
- *Last Admin:* `pg_advisory_xact_lock(hashtextextended('ADMIN-SET', 0))` first, count **after** the lock.
- *Resolve report:* Message `FOR NO KEY UPDATE`, then sibling Reports ascending, then check the own report is still `OPEN`.
- *Idempotent inserts:* `ON CONFLICT DO NOTHING` and read the row count; it does not hide FK/CHECK errors.

## 4. Findings and rules for later milestones
1. Row-lock waits show as `Lock/transactionid` for every cell; detect blocking by `pg_blocking_pids`, not by wait-event name.
2. `COMMIT` on an aborted transaction silently becomes `ROLLBACK` (command tag `ROLLBACK`); services must treat a caught database error inside a transaction as terminal.
3. Test helper: releasing a transaction that still has a blocked statement used to wait the full `lock_timeout` (15 s); it now cancels the statement first (3 ms). The M5 "parallel-transaction helper" must do the same.
4. Deadlock detection costs about `deadlock_timeout` (1 s). Tests that provoke deadlocks must budget for it; lock-order tests that expect none can run in volume.
5. Destructive test helpers must verify `current_database()`; generic table names (`course`, `message`) will exist in the real database from M5.

## 5. Permanent guarantees to carry into the real concurrency suite (Exit: "tests proving permanent guarantees move")
Move into M5/M7/M13 once the real schema exists: matrix subset used by Decision 160 (S∥S free, S/X both ways, X∥X); Enrollment INSERT free under Course-X and blocked under `FOR UPDATE`; RESTRICT `23001` for course delete with enrollments; conditional-transition single winner; `ON CONFLICT DO NOTHING` single row; send-message gap-freedom and idempotency; one-Owner demote-first and concurrent transfer; `ADMIN-SET` last-Admin; report-resolution ordering; global lock-order deadlock-freedom; `runInTransaction` retry on a forced deadlock. The helper (`lib/parallel-tx.ts`) is the base of the M5 parallel-transaction helper.

## 6. Not verified
Behavior on PostgreSQL older than 18 (the semantics used here are long-standing, but unverified); isolation levels other than `read committed` (except Spike A's `40001` case); connection poolers in transaction mode; multi-instance deployments (Decision 162 assumes one); `NOWAIT`/`SKIP LOCKED` variants beyond probes; load beyond ~12 simultaneous connections; production-size data.

## 7. Reproduce
```
docker compose up -d --wait                 # PostgreSQL 18.6 must be running
cd spikes/m2-spike-b && npm install
npm run db:create && npm run db:setup       # database nelio_spike_b only (scripts refuse any other)
npm run generate                            # Prisma client for Phase 8
npm run typecheck && npm test               # 70 tests, ~31 s, serial
```
Credentials: `scripts/env.sh` runs Node with `--env-file` pointing at the main checkout's `.env`; nothing is printed or stored.
