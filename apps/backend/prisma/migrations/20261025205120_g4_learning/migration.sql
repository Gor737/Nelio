-- CreateEnum
CREATE TYPE "enrollment_status" AS ENUM ('PENDING', 'ACTIVE', 'LEFT', 'REJECTED', 'REMOVED');

-- CreateEnum
CREATE TYPE "invitation_status" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED');

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "course_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "enrollment_status" NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "first_activated_at" TIMESTAMPTZ(6),
    "left_at" TIMESTAMPTZ(6),
    "last_visited_lesson_id" UUID,
    "last_visited_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "course_id" UUID NOT NULL,
    "invited_user_id" UUID NOT NULL,
    "invited_by" UUID NOT NULL,
    "status" "invitation_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "responded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_completions" (
    "enrollment_id" UUID NOT NULL,
    "lesson_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_completions_pkey" PRIMARY KEY ("enrollment_id","lesson_id")
);

-- CreateIndex
CREATE INDEX "enrollments_course_id_status_idx" ON "enrollments"("course_id", "status");

-- CreateIndex
CREATE INDEX "enrollments_user_id_status_idx" ON "enrollments"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_course_id_user_id_key" ON "enrollments"("course_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_id_course_id_key" ON "enrollments"("id", "course_id");

-- CreateIndex
CREATE INDEX "invitations_invited_user_id_idx" ON "invitations"("invited_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_course_id_invited_user_id_key" ON "invitations"("course_id", "invited_user_id");

-- CreateIndex
CREATE INDEX "lesson_completions_lesson_id_course_id_idx" ON "lesson_completions"("lesson_id", "course_id");

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_last_visited_lesson_id_fkey" FOREIGN KEY ("last_visited_lesson_id") REFERENCES "lessons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_completions" ADD CONSTRAINT "lesson_completions_enrollment_id_course_id_fkey" FOREIGN KEY ("enrollment_id", "course_id") REFERENCES "enrollments"("id", "course_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_completions" ADD CONSTRAINT "lesson_completions_lesson_id_course_id_fkey" FOREIGN KEY ("lesson_id", "course_id") REFERENCES "lessons"("id", "course_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written part (Decision 102): objects Prisma cannot express. Prisma ignores them in `migrate diff`. =====
-- Every object here has a test in test/integration/g4-constraints.integration-spec.ts that tries to break it.

-- CHECK: the decided_by / decided_at pair is set together (architecture section 9).
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_decided_pair" CHECK (("decided_by" IS NULL) = ("decided_at" IS NULL));

-- CHECK: a completed enrollment has been active at some point (completion is a permanent snapshot, Decision 12).
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_completed_needs_first_activated"
  CHECK ("completed_at" IS NULL OR "first_activated_at" IS NOT NULL);

-- Partial index: active enrollments that are not yet completed, per course (completion rechecks, nightly sweep).
CREATE INDEX "enrollments_active_incomplete_idx" ON "enrollments" ("course_id") WHERE "status" = 'ACTIVE' AND "completed_at" IS NULL;

-- Partial index (child side of the SET NULL foreign key): only enrollments that remember a lesson. Deleting a lesson finds
-- them through this index instead of scanning the table.
CREATE INDEX "enrollments_last_visited_lesson_id_idx" ON "enrollments" ("last_visited_lesson_id") WHERE "last_visited_lesson_id" IS NOT NULL;
