-- CreateEnum
CREATE TYPE "course_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "enrollment_policy" AS ENUM ('OPEN', 'APPROVAL_REQUIRED', 'INVITATION_ONLY');

-- CreateEnum
CREATE TYPE "course_teacher_role" AS ENUM ('OWNER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('TEACHER_APPLICATION_RECEIVED', 'TEACHER_APPLICATION_APPROVED', 'TEACHER_APPLICATION_REJECTED', 'TEACHER_ROLE_REVOKED', 'ENROLLMENT_REQUESTED', 'ENROLLMENT_APPROVED', 'ENROLLMENT_REJECTED', 'REMOVED_FROM_COURSE', 'INVITATION_RECEIVED', 'LESSON_PUBLISHED', 'OWNERSHIP_TRANSFERRED', 'COURSE_ADMIN_LOCKED');

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_tags" (
    "course_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_tags_pkey" PRIMARY KEY ("course_id","tag_id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "description" TEXT,
    "cover_file_id" UUID,
    "category_id" UUID,
    "status" "course_status" NOT NULL DEFAULT 'DRAFT',
    "enrollment_policy" "enrollment_policy" NOT NULL,
    "first_published_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "locked_by_admin_at" TIMESTAMPTZ(6),
    "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((((COALESCE(title, ''::text) || ' '::text) || COALESCE(summary, ''::text)) || ' '::text) || COALESCE(description, ''::text)))) STORED, -- hand-edited: Prisma generates a plain column (Decision 102)
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_teachers" (
    "course_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "course_teacher_role" NOT NULL,
    "added_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_teachers_pkey" PRIMARY KEY ("course_id","user_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "type" "notification_type" NOT NULL,
    "course_id" UUID,
    "actor_id" UUID,
    "data" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tags_slug_key" ON "tags"("slug");

-- CreateIndex
CREATE INDEX "course_tags_tag_id_idx" ON "course_tags"("tag_id");

-- CreateIndex
CREATE INDEX "courses_status_first_published_at_idx" ON "courses"("status", "first_published_at" DESC);

-- CreateIndex
CREATE INDEX "courses_category_id_idx" ON "courses"("category_id");

-- CreateIndex
CREATE INDEX "courses_search_vector_idx" ON "courses" USING GIN ("search_vector");

-- CreateIndex
CREATE INDEX "course_teachers_user_id_idx" ON "course_teachers"("user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_course_id_idx" ON "notifications"("course_id");

-- AddForeignKey
ALTER TABLE "course_tags" ADD CONSTRAINT "course_tags_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_tags" ADD CONSTRAINT "course_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_cover_file_id_fkey" FOREIGN KEY ("cover_file_id") REFERENCES "file_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_teachers" ADD CONSTRAINT "course_teachers_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_teachers" ADD CONSTRAINT "course_teachers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_teachers" ADD CONSTRAINT "course_teachers_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===== Hand-written part (Decision 102): objects Prisma cannot express. Prisma ignores them in `migrate diff`. =====
-- Every object here has a test in test/integration/g2-constraints.integration-spec.ts that tries to break it.
-- Length limits repeat TEXT_LIMITS (src/common/constants/limits.ts); a test compares the numbers below with the constants.

-- CHECK: a published course has a category and a summary (architecture section 9).
ALTER TABLE "courses" ADD CONSTRAINT "courses_published_needs_category_summary"
  CHECK ("status" <> 'PUBLISHED' OR ("category_id" IS NOT NULL AND "summary" IS NOT NULL));

-- CHECK: a course that left DRAFT has been published at some point.
ALTER TABLE "courses" ADD CONSTRAINT "courses_non_draft_has_first_published_at"
  CHECK ("status" = 'DRAFT' OR "first_published_at" IS NOT NULL);

-- CHECK: only an ARCHIVED course can be locked by an Admin (Decision 141).
ALTER TABLE "courses" ADD CONSTRAINT "courses_admin_lock_needs_archived"
  CHECK ("locked_by_admin_at" IS NULL OR "status" = 'ARCHIVED');

-- CHECKs: text lengths in characters (TEXT_LIMITS).
ALTER TABLE "courses" ADD CONSTRAINT "courses_title_length" CHECK (char_length("title") BETWEEN 3 AND 120);
ALTER TABLE "courses" ADD CONSTRAINT "courses_summary_length" CHECK ("summary" IS NULL OR char_length("summary") BETWEEN 10 AND 300);
ALTER TABLE "courses" ADD CONSTRAINT "courses_description_length" CHECK ("description" IS NULL OR char_length("description") <= 5000);
ALTER TABLE "categories" ADD CONSTRAINT "categories_name_length" CHECK (char_length("name") BETWEEN 2 AND 60);
ALTER TABLE "tags" ADD CONSTRAINT "tags_name_length" CHECK (char_length("name") BETWEEN 2 AND 30);

-- Partial unique index: exactly one OWNER per course. Ownership transfer demotes the old Owner first (separate statements).
CREATE UNIQUE INDEX "course_teachers_one_owner" ON "course_teachers" ("course_id") WHERE "role" = 'OWNER';

-- Partial index (Decision 163): the child side of courses.cover_file_id -> file_assets, only for courses with a cover.
CREATE INDEX "courses_cover_file_id_idx" ON "courses" ("cover_file_id") WHERE "cover_file_id" IS NOT NULL;

-- Partial index: unread notifications per user (badge count and the unread list).
CREATE INDEX "notifications_user_unread_idx" ON "notifications" ("user_id") WHERE "read_at" IS NULL;
