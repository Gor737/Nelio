-- CreateEnum
CREATE TYPE "lesson_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "content_block_type" AS ENUM ('TEXT', 'VIDEO', 'FILE');

-- CreateEnum
CREATE TYPE "video_provider" AS ENUM ('YOUTUBE', 'VIMEO');

-- CreateTable
CREATE TABLE "sections" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "course_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lessons" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "course_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "lesson_status" NOT NULL DEFAULT 'DRAFT',
    "first_published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_blocks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "lesson_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "content_block_type" NOT NULL,
    "text_body" TEXT,
    "video_provider" "video_provider",
    "video_external_id" TEXT,
    "file_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sections_course_id_position_idx" ON "sections"("course_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "sections_id_course_id_key" ON "sections"("id", "course_id");

-- CreateIndex
CREATE INDEX "lessons_section_id_position_idx" ON "lessons"("section_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "lessons_id_course_id_key" ON "lessons"("id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_blocks_file_id_key" ON "content_blocks"("file_id");

-- CreateIndex
CREATE INDEX "content_blocks_lesson_id_position_idx" ON "content_blocks"("lesson_id", "position");

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_section_id_course_id_fkey" FOREIGN KEY ("section_id", "course_id") REFERENCES "sections"("id", "course_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_blocks" ADD CONSTRAINT "content_blocks_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_blocks" ADD CONSTRAINT "content_blocks_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written part (Decision 102): objects Prisma cannot express. Prisma ignores them in `migrate diff`. =====
-- Every object here has a test in test/integration/g3-constraints.integration-spec.ts that tries to break it.
-- Length limits repeat TEXT_LIMITS (src/common/constants/limits.ts); a test compares the numbers below with the constants.

-- CHECK: a published lesson has a first-publication time.
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_published_has_first_published_at"
  CHECK ("status" <> 'PUBLISHED' OR "first_published_at" IS NOT NULL);

-- CHECK: the columns of a content block match its type: TEXT has only text, VIDEO only provider + external id, FILE only a file.
ALTER TABLE "content_blocks" ADD CONSTRAINT "content_blocks_columns_match_type" CHECK (
  ("type" = 'TEXT'  AND "text_body" IS NOT NULL AND "video_provider" IS NULL AND "video_external_id" IS NULL AND "file_id" IS NULL) OR
  ("type" = 'VIDEO' AND "text_body" IS NULL AND "video_provider" IS NOT NULL AND "video_external_id" IS NOT NULL AND "file_id" IS NULL) OR
  ("type" = 'FILE'  AND "text_body" IS NULL AND "video_provider" IS NULL AND "video_external_id" IS NULL AND "file_id" IS NOT NULL)
);

-- CHECKs: text lengths in characters (TEXT_LIMITS). The video id length (1-64) is a proposed default (docs/proposed-defaults.md).
ALTER TABLE "sections" ADD CONSTRAINT "sections_title_length" CHECK (char_length("title") BETWEEN 1 AND 120);
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_title_length" CHECK (char_length("title") BETWEEN 1 AND 150);
ALTER TABLE "content_blocks" ADD CONSTRAINT "content_blocks_text_body_length" CHECK ("text_body" IS NULL OR char_length("text_body") BETWEEN 1 AND 20000);
ALTER TABLE "content_blocks" ADD CONSTRAINT "content_blocks_video_external_id_length" CHECK ("video_external_id" IS NULL OR char_length("video_external_id") BETWEEN 1 AND 64);

-- Partial index: published lessons per course (student outline, progress denominator, completion checks).
CREATE INDEX "lessons_published_course_idx" ON "lessons" ("course_id") WHERE "status" = 'PUBLISHED';
