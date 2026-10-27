-- Report snapshot is TEXT, not JSONB (Decision 77: "the report stores a text snapshot at report time"; owner decision 2026-10-26).
-- It preserves the message body as it was when the report was filed; the sender, conversation, seq and time of a message
-- cannot change and are read from the message row.

-- AlterTable
-- Hand-edited: Prisma generated a bare `SET DATA TYPE TEXT`, which would keep the JSON quotes of a stored string value.
-- A JSON string is unwrapped; any other JSON value (none is written by the application) keeps its JSON text.
ALTER TABLE "reports" ALTER COLUMN "message_snapshot" SET DATA TYPE TEXT
  USING (CASE WHEN jsonb_typeof("message_snapshot") = 'string' THEN "message_snapshot" #>> '{}' ELSE "message_snapshot"::text END);

-- ===== Hand-written part (Decision 102) =====
-- CHECK: the snapshot is a message body, so it follows the message body limit (TEXT_LIMITS.MESSAGE_BODY, 1-2000 characters).
-- It is NULL for USER reports (reports_target_shape). Tested in test/integration/g5-constraints.integration-spec.ts and
-- compared with the constant in test/integration/schema-suite.integration-spec.ts.
ALTER TABLE "reports" ADD CONSTRAINT "reports_message_snapshot_length"
  CHECK ("message_snapshot" IS NULL OR char_length("message_snapshot") BETWEEN 1 AND 2000);
