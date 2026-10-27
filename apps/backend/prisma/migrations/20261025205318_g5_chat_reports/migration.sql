-- CreateEnum
CREATE TYPE "conversation_type" AS ENUM ('DIRECT', 'GROUP', 'COURSE_CHANNEL');

-- CreateEnum
CREATE TYPE "conversation_member_role" AS ENUM ('MEMBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "report_target_type" AS ENUM ('MESSAGE', 'USER');

-- CreateEnum
CREATE TYPE "report_reason" AS ENUM ('SPAM', 'HARASSMENT', 'INAPPROPRIATE', 'OTHER');

-- CreateEnum
CREATE TYPE "report_status" AS ENUM ('OPEN', 'DISMISSED', 'ACTIONED');

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "type" "conversation_type" NOT NULL,
    "title" TEXT,
    "course_id" UUID,
    "created_by" UUID,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "direct_conversations" (
    "conversation_id" UUID NOT NULL,
    "user_a_id" UUID NOT NULL,
    "user_b_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "direct_conversations_pkey" PRIMARY KEY ("conversation_id")
);

-- CreateTable
CREATE TABLE "conversation_members" (
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "conversation_member_role" NOT NULL DEFAULT 'MEMBER',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(6),
    "last_read_seq" INTEGER NOT NULL DEFAULT 0,
    "is_muted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("conversation_id","user_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "conversation_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "sender_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "client_id" UUID NOT NULL,
    "edited_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reporter_id" UUID NOT NULL,
    "target_type" "report_target_type" NOT NULL,
    "message_id" UUID,
    "target_user_id" UUID,
    "reason" "report_reason" NOT NULL,
    "description" TEXT,
    "message_snapshot" JSONB,
    "status" "report_status" NOT NULL DEFAULT 'OPEN',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_course_id_key" ON "conversations"("course_id");

-- CreateIndex
CREATE UNIQUE INDEX "direct_conversations_user_a_id_user_b_id_key" ON "direct_conversations"("user_a_id", "user_b_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_seq_key" ON "messages"("conversation_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "messages_sender_id_client_id_key" ON "messages"("sender_id", "client_id");

-- CreateIndex
CREATE INDEX "reports_status_created_at_idx" ON "reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "reports_message_id_idx" ON "reports"("message_id");

-- CreateIndex
CREATE INDEX "reports_target_user_id_idx" ON "reports"("target_user_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "direct_conversations" ADD CONSTRAINT "direct_conversations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "direct_conversations" ADD CONSTRAINT "direct_conversations_user_a_id_fkey" FOREIGN KEY ("user_a_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "direct_conversations" ADD CONSTRAINT "direct_conversations_user_b_id_fkey" FOREIGN KEY ("user_b_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_sender_id_fkey" FOREIGN KEY ("conversation_id", "sender_id") REFERENCES "conversation_members"("conversation_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written part (Decision 102): objects Prisma cannot express. Prisma ignores them in `migrate diff`. =====
-- Every object here has a test in test/integration/g5-constraints.integration-spec.ts that tries to break it.
-- Length limits repeat TEXT_LIMITS (src/common/constants/limits.ts); a test compares the numbers below with the constants.

-- CHECK: the shape of a conversation follows its type. DIRECT has no title and no course; GROUP has a title and no course;
-- COURSE_CHANNEL belongs to a course and has no title of its own (it is shown under the course title, which can change).
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_type_shape" CHECK (
  ("type" = 'DIRECT'         AND "title" IS NULL     AND "course_id" IS NULL) OR
  ("type" = 'GROUP'          AND "title" IS NOT NULL AND "course_id" IS NULL) OR
  ("type" = 'COURSE_CHANNEL' AND "title" IS NULL     AND "course_id" IS NOT NULL)
);
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_last_seq_nonneg" CHECK ("last_seq" >= 0);
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_title_length" CHECK ("title" IS NULL OR char_length("title") BETWEEN 1 AND 80);

-- CHECK: a direct conversation stores its pair ordered, so (B, A) and (A, B) are the same row key and the unique index
-- on (user_a_id, user_b_id) allows exactly one DM per pair.
ALTER TABLE "direct_conversations" ADD CONSTRAINT "direct_conversations_ordered_pair" CHECK ("user_a_id" < "user_b_id");

-- CHECKs: message text length (the text of a soft-deleted message is kept, so the limit holds for it too) and the
-- deleted_at / deleted_by pair.
ALTER TABLE "messages" ADD CONSTRAINT "messages_body_length" CHECK (char_length("body") BETWEEN 1 AND 2000);
ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_pair" CHECK (("deleted_at" IS NULL) = ("deleted_by" IS NULL));

-- Partial index: the active memberships of a user (conversation list, recipient computation, presence peers).
CREATE INDEX "conversation_members_active_user_idx" ON "conversation_members" ("user_id") WHERE "left_at" IS NULL;

-- CHECK: exactly one target, matching target_type; a MESSAGE report carries the evidence snapshot, a USER report has none.
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_shape" CHECK (
  ("target_type" = 'MESSAGE' AND "message_id" IS NOT NULL AND "target_user_id" IS NULL AND "message_snapshot" IS NOT NULL) OR
  ("target_type" = 'USER'    AND "target_user_id" IS NOT NULL AND "message_id" IS NULL AND "message_snapshot" IS NULL)
);
ALTER TABLE "reports" ADD CONSTRAINT "reports_reviewed_pair" CHECK (("reviewed_by" IS NULL) = ("reviewed_at" IS NULL));
ALTER TABLE "reports" ADD CONSTRAINT "reports_description_length" CHECK ("description" IS NULL OR char_length("description") BETWEEN 1 AND 1000);
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolution_note_length" CHECK ("resolution_note" IS NULL OR char_length("resolution_note") BETWEEN 1 AND 1000);

-- Partial unique indexes: one OPEN report per reporter and target. After the report is resolved, a new one is accepted.
CREATE UNIQUE INDEX "reports_open_message_unique" ON "reports" ("reporter_id", "message_id") WHERE "status" = 'OPEN' AND "message_id" IS NOT NULL;
CREATE UNIQUE INDEX "reports_open_user_unique" ON "reports" ("reporter_id", "target_user_id") WHERE "status" = 'OPEN' AND "target_user_id" IS NOT NULL;
