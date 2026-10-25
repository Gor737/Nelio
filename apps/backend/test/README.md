# Test harness (M5)

Real-PostgreSQL tests for constraints, locks and (later) services. No mocks of the database.

## Layout

| Path | What |
|---|---|
| `integration/*.integration-spec.ts` | Tests that run against a real database built from the migrations. Config: `jest-integration.json`. |
| `support/test-database.mjs` | Builds `nelio_test` from `prisma/migrations/*/migration.sql` (drop, create, apply in order). Used by Jest `globalSetup`. |
| `support/database.ts` | `createPool()` (default 10 connections, so concurrency tests work), `resetData()` (truncate every table between tests). |
| `support/factories.ts` | Direct-`INSERT` factories: `createUser`, `createUserWithRoles`, `createAdmin`, `createTeacher`, `createFile`, `createRefreshToken`, `createAuditEntry`. Later milestones add courses, enrollments, conversations. |
| `support/token-minter.ts` | `mintAccessToken(userId)`: a real HS256 access token (subject only, 15 minutes) signed with `JWT_SECRET` (or a fixed 32-byte test secret). `verifyAccessToken` for tests. Never import it from `src/`. |
| `support/parallel-tx.ts` | Parallel-transaction helper from Spike B: hold a transaction open, start a statement without awaiting it, detect "blocked by" with `pg_blocking_pids`, cancel on release. |
| `support/sql.ts` | Direct-SQL helper for constraint tests: `sqlError(promise)` returns `{ sqlstate, constraint, message }` and fails if the statement succeeded. |
| `support/schema-fingerprint.ts` | A text description of a schema, to prove that replaying the migrations gives the same schema. |
| `architecture/` | dependency-cruiser rule tests (M3). `constants/` shared-constant tests (M4). |

## How a run works

1. `globalSetup` connects to the server's `postgres` database with the same credentials as the application and recreates `nelio_test`, then applies every migration file in order. It also makes sure `nelio_test_shadow` exists (Prisma needs a shadow database for the drift check).
2. Each test file creates its own pool and calls `resetData(pool)` in `beforeEach`; tests run in band (`--runInBand`), so one database is enough.
3. Credentials come from `DATABASE_URL` (CI) or `POSTGRES_USER`/`POSTGRES_PASSWORD` (local `.env`, the same variables as `docker-compose.yml`, host `localhost`, port `5433`). The npm script loads `../../.env` when it exists; CI has no `.env`.

## Safety rules (do not weaken)

- The only databases the harness may drop or recreate are exactly `nelio_test` and `nelio_test_shadow` (`assertTestDatabaseName`). Every destructive helper also checks `current_database()` first. The application database (`nelio`) is never touched by tests.
- A test must release what it opens: `afterEach(() => expect(await releaseAll()).toBe(0))`.
- Detect blocking with `pg_blocking_pids` (`awaitBlockedBy`), never with sleeps.

## Writing a constraint test

Every hand-written object (CHECK, partial index, trigger, generated column) gets a test that **tries to break it**, with the exact `sqlstate` and `constraint` name: `expect(await sqlError(statement)).toMatchObject({ sqlstate: '23514', constraint: 'blocks_no_self_block' })`. Boundary values are tested on both sides (the 90-day refresh-token cap accepts day 90 and rejects day 90 plus one second).

## Logs must stay clean (Decision 167)

Every HTTP test suite of a new module includes at least one request that carries a password, a bearer token, a cookie and a message body, wrapped in `captureLogs()` from `support/log-capture.ts`, followed by `expectNoneLogged(logs, [...those values])`. The helper fails when a value appears in the output and also when nothing was captured (a vacuous check). See `test/app.e2e-spec.ts`.

## Migration rules (roadmap M5)

Create with `npm run db:migrate:create -- --name <name>`, read the generated SQL (no unintended `DROP`), append hand-written SQL, put `CREATE EXTENSION` before anything that needs it, keep enum `ADD VALUE` in its own migration, then run `npm run db:migrate:deploy`, `npm run db:drift` and `npm run db:drift:live` (both must print "This is an empty migration"). One-time per server: `npm run db:prepare` creates `<database>_shadow`.

## Commands

```
npm run test                 # unit tests (no database)
npm run test:integration     # builds nelio_test from the migrations, runs the real-PostgreSQL tests
npm run test:e2e             # boots the Nest application
```

## Known limits

- `TRUNCATE` is not blocked by the `audit_logs` trigger (it guards UPDATE and DELETE, as the architecture states); the harness relies on that to isolate tests.
- Emails are lowercased by the service, not by the database; a test pins that the database accepts both `Case@x` and `case@x`.
