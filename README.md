<div align="center">

# Nelio

**A web-based Learning Management System — modular-monolith backend built with NestJS and PostgreSQL**

[![CI](https://github.com/Gor737/Nelio/actions/workflows/ci.yml/badge.svg)](https://github.com/Gor737/Nelio/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-22-5FA04E?logo=nodedotjs&logoColor=white)
![NestJS](https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4-010101?logo=socketdotio&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)

</div>

---

## 📖 About

**Nelio** is a Learning Management System (graduation project) built by one developer. Students enroll in courses, work through lessons and track their progress; Teachers build and run courses; Admins moderate the platform. Users can talk in a Slack-like chat with direct messages, groups and an automatic channel for every published course.

This repository currently contains the **backend** (`apps/backend`): a REST + WebSocket API with its database schema, tests and design documentation. The Next.js frontend described in the architecture is not part of this repository yet.

## ✨ Features

| Area | What it does |
|---|---|
| 👥 **Roles** | Student, Teacher (needs Admin approval) and Admin; a user can hold several roles |
| 🔐 **Authentication** | Email/password (Argon2id) and Google sign-in; short-lived JWT access tokens and rotating refresh tokens in an `HttpOnly` cookie with reuse detection; email verification and password reset |
| 📚 **Courses** | Course → Section → Lesson → ordered content blocks (Markdown text, external video, file attachments); draft / published / archived lifecycle; catalog with full-text search, categories and tags |
| 🎟️ **Enrollment** | Per-course policy: open, approval required or invitation only; invitations, approvals, removals and reinstatements |
| 📈 **Progress** | Per-lesson completion and a permanent course-completion record |
| 💬 **Chat** | Direct messages, groups and one channel per published course over Socket.IO, with message history by sequence number, read positions and presence |
| 🔔 **Notifications** | In-app notifications for enrollment, invitations, role decisions, ownership transfer and course takedown |
| 🛡️ **Moderation** | User blocking, message and user reports with an evidence snapshot, an Admin report queue with an audited context view |
| 🧰 **Admin** | Users and Teacher applications, suspension, course lock/unlock/restore, ownership transfer, categories and tag merge, audit-log viewer, statistics |
| ⚙️ **Operations** | Immutable audit log, nightly cleanup and consistency jobs, rate limiting, structured JSON logging, health endpoint |

Out of scope for v1 (documented decisions): payments, quizzes and grading, ratings, certificates, email notifications, hosted video, rich-text editor.

## 🧱 Technology Stack

| Area | Technology |
|---|---|
| Runtime / framework | Node.js 22, NestJS 12, TypeScript 6 |
| Database | PostgreSQL 18, Prisma 7 (multi-file schema, hand-written SQL for constraints and indexes) |
| API | REST under `/api/v1`, OpenAPI / Swagger |
| Real-time | Socket.IO |
| Security | Argon2id, JWT (HS256), Helmet, CORS, `class-validator` whitelist validation, per-endpoint rate limiting |
| Storage / mail | S3-compatible object storage (AWS SDK v3) behind a `StorageDriver`; Nodemailer (Mailpit locally) |
| Scheduling | `@nestjs/schedule` |
| Quality | Jest, Supertest, oxlint, Prettier, dependency-cruiser (architecture rules), GitHub Actions |
| Local infrastructure | Docker Compose (PostgreSQL 18.6, Mailpit) |

## 🏗️ Architecture

Nelio is a **modular monolith** running as a single instance. PostgreSQL is the source of truth; the database enforces what it can (constraints, foreign keys, a trigger on the audit log). Sockets are a delivery channel only, never the authority.

```text
Browser (Next.js, planned)
   │  HTTPS, same-site
   ▼
Reverse proxy ──▶ NestJS modular monolith (1 instance)
                   ├─ REST /api/v1   guards → pipes → services → exception filter
                   ├─ Socket.IO      personal rooms, one connection per client
                   └─ Scheduled jobs cleanups · channel reconcile · completion recheck
                        │            │              │
                        ▼            ▼              ▼
                   PostgreSQL   S3-compatible   SMTP
```

**Module layers** — dependencies point downward only, and dependency-cruiser fails the build if a rule is broken:

| Layer | Modules |
|---|---|
| 3 | `admin` |
| 2 | `auth` · `courses` · `enrollments` |
| 1 | `users` · `content` · `chat` |
| 0 | `files` · `catalog` · `progress` · `moderation` · `notifications` |
| Infrastructure | `config` · `database` · `audit` · `mail` · `events` · `realtime` · `logging` · `health` |

**Repository structure**

```text
Nelio/
├── apps/
│   └── backend/
│       ├── prisma/          schema (one file per domain) and SQL migrations
│       ├── scripts/         database, smoke-test and restore-rehearsal helpers
│       ├── src/
│       │   ├── modules/     12 domain modules
│       │   ├── infrastructure/
│       │   └── common/      guards, decorators, filters, pipes, shared constants
│       ├── test/            unit, e2e, integration and conformance suites
│       └── openapi.json     generated API contract
├── docs/                    architecture, decisions, roadmap, release notes
├── docker-compose.yml       PostgreSQL 18.6 and Mailpit
├── .env.example             environment template (no secrets)
└── .github/workflows/       CI
```

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) **22 or newer**
- [Docker](https://www.docker.com/) with Docker Compose

### Setup

```bash
# 1. Configuration (repository root)
cp .env.example .env
#    edit .env: set a POSTGRES_PASSWORD and a JWT_SECRET (at least 32 bytes):
#    openssl rand -base64 48

# 2. Database and mail catcher (repository root)
docker compose up -d
docker compose ps                      # wait until both services are "healthy"

# 3. Backend (apps/backend)
cd apps/backend
npm ci
npm run prisma:generate                # generates the Prisma Client (not committed)
npm run db:migrate:deploy              # applies the SQL migrations to the local database
npm run start                          # http://localhost:3000
```

For automatic reload while developing use `npm run start:dev` instead of `npm run start`. The backend reads `../../.env` automatically; real environment variables take precedence over it.

### Verify

```bash
curl http://localhost:3000/health      # {"status":"ok","database":"up"}
```

Then open **<http://localhost:3000/api/docs>** (Swagger UI). Sent mail can be inspected in Mailpit at <http://localhost:8025>.

## 🔧 Environment Variables

Copy `.env.example` and fill in the values; **never commit `.env`**. In production no `.env` file is read and the required variables must be set in the environment.

| Variable | Required | Purpose |
|---|---|---|
| `POSTGRES_USER` · `POSTGRES_PASSWORD` · `POSTGRES_DB` | local | Database credentials used by Docker Compose; the backend builds its connection string from them outside production |
| `DATABASE_URL` | production | PostgreSQL connection URL (optional locally) |
| `JWT_SECRET` | **always** | Signing secret, at least 32 random bytes; the app refuses to start without it |
| `FRONTEND_ORIGIN` | production | Exact origin allowed by CORS |
| `PORT` · `LOG_LEVEL` · `TRUST_PROXY` · `SWAGGER_ENABLED` | optional | Port, log level, number of reverse proxies, Swagger switch (off by default in production) |
| `SMTP_HOST` · `SMTP_PORT` · `SMTP_SECURE` · `SMTP_USER` · `SMTP_PASSWORD` · `MAIL_FROM` | production | Outgoing mail; defaults point to Mailpit locally |
| `S3_ENDPOINT` · `S3_REGION` · `S3_BUCKET` · `S3_ACCESS_KEY_ID` · `S3_SECRET_ACCESS_KEY` · `S3_FORCE_PATH_STYLE` · `S3_PUBLIC_BASE_URL` | for file uploads | S3-compatible object storage. Docker Compose does not include a storage service; without credentials the app still starts and file endpoints answer `503` |
| `GOOGLE_CLIENT_ID` | optional | Enables Google sign-in |
| `SEED_ADMIN_EMAIL` · `SEED_ADMIN_PASSWORD` · `SEED_ADMIN_NAME` | first run | Used only by `npm run seed:admin` to create the first Admin |

## 🗄️ Database & Docker

`docker-compose.yml` starts two services:

| Service | Image | Host port | Purpose |
|---|---|---|---|
| `postgres` | `postgres:18.6` | `5433` | Application database (data kept in the `postgres_data` volume) |
| `mailpit` | `axllent/mailpit:v1.32.0` | `1025` (SMTP), `8025` (web UI) | Local mail inbox |

Migrations are plain SQL under `apps/backend/prisma/migrations`. The test suites build and use a separate `nelio_test` database; the local application database is never reset by the tests.

> ⚠️ `docker compose down -v` deletes the database volume and all its data.

## 📡 API Documentation

- **Swagger UI:** <http://localhost:3000/api/docs> (disabled by default in production)
- **OpenAPI JSON:** <http://localhost:3000/api/docs-json>
- **Committed contract:** [`apps/backend/openapi.json`](apps/backend/openapi.json) — 137 operations, regenerated with `npm run openapi:export`; CI fails if it is out of date
- **Base path:** `/api/v1`; the health probe is `GET /health` (no prefix)
- **Errors:** every error is `{ statusCode, code, message, errors? }` — clients branch on `code`
- **Authentication:** `Authorization: Bearer <access token>`; the refresh token travels only in an `HttpOnly` cookie scoped to `/api/v1/auth`
- **Real-time:** Socket.IO on the same server; the handshake takes the access token in its auth payload

## 🛠️ Useful Commands

Run from `apps/backend` unless noted.

| Command | Description |
|---|---|
| `npm run start` / `npm run start:dev` | Start the backend / start with watch mode |
| `npm run build` · `npm run start:prod` | Compile to `dist/` / run the compiled app (reads no `.env`) |
| `npm run db:migrate:deploy` | Apply SQL migrations |
| `npm run db:drift` | Check that migrations and the Prisma schema agree |
| `npm run prisma:generate` · `npm run prisma:validate` | Generate / validate the Prisma schema |
| `npm run seed:admin` | Create the first Admin from `SEED_ADMIN_*` (after `npm run build`) |
| `npm run openapi:export` | Regenerate `openapi.json` |
| `npm run lint` · `npm run format` | oxlint / Prettier |
| `npm run check:architecture` | Verify the module layering rules |
| `npm test` · `npm run test:e2e` · `npm run test:integration` | Unit / e2e / integration tests (integration needs the Docker database) |
| `npm run test:concurrency -- 5` | Repeat the race-condition suites |
| `npm run smoke:prod` | Start the compiled app with a production environment and check it |
| `npm run db:restore-rehearsal` | Back up and restore into a scratch database, then compare |
| `docker compose up -d` · `docker compose stop` (repo root) | Start / stop the local services |

## ✅ Quality

| Layer | Command | Tests (last full run) |
|---|---|---|
| Unit | `npm test` | 554 |
| End-to-end | `npm run test:e2e` | 57 |
| Integration, concurrency and conformance (real PostgreSQL) | `npm run test:integration` | 986 |

The conformance suites generate their cases from the application's own metadata: the permission matrix for every endpoint, one reproducer per error code, the check order of guards, mass-assignment protection, a response leak scan, OpenAPI completeness and `EXPLAIN` checks of the hot queries.

[GitHub Actions](.github/workflows/ci.yml) runs on every pull request and every push to `main`: dependency audit, Prisma validation, lint, type-check, architecture rules, all test layers, OpenAPI drift, migration drift, the build, a production smoke test and a repeated concurrency run.

## 📑 Documentation

| Document | Content |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Final v1 architecture |
| [`docs/decision.log.md`](docs/decision.log.md) | Every design decision with its reasoning |
| [`docs/roadmap.md`](docs/roadmap.md) | Implementation milestones and their status |
| [`docs/proposed-defaults.md`](docs/proposed-defaults.md) | Defaults and choices made where the design was silent |
| [`docs/release.md`](docs/release.md) | Release readiness, deployment sequence, runbook, notes for the frontend |
| [`docs/spikes/`](docs/spikes) | Reports of the two early technical spikes (Prisma, PostgreSQL lock modes) |

## 📌 Project Status

The backend milestones **M0–M14** are implemented, reviewed and merged into `main`; the CI run on the merge passed.

Still open (tracked in [`docs/release.md`](docs/release.md)):

- Production hosting provider is not selected; Railway is the candidate for a **staging** environment and its compatibility has not been validated yet.
- Transactional email for hosted environments needs an HTTPS email provider (not chosen).
- Handling of private Vimeo links and a local object-storage service for Docker Compose are unresolved.
- The Next.js frontend is planned and not started in this repository.

## 📄 License

The backend package declares `"license": "UNLICENSED"` (`apps/backend/package.json`) and the repository has no `LICENSE` file, so all rights are reserved by the author.
