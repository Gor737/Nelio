-- Text-length CHECKs for the G1 columns that have a limit in TEXT_LIMITS (src/common/constants/limits.ts) but were created
-- without one in the M5 migration. Hand-written (Decision 102); no schema change, so Prisma has nothing to generate.
-- Every constraint is exercised by test/integration/schema-suite.integration-spec.ts, which also compares the numbers below
-- with the constants. The limits were approved by the owner on 2026-10-25 (docs/proposed-defaults.md).
-- `ALTER TABLE ... ADD CONSTRAINT` validates the existing rows; a violating row makes this migration fail loudly.

ALTER TABLE "users" ADD CONSTRAINT "users_email_length" CHECK (char_length("email") BETWEEN 3 AND 254);
ALTER TABLE "users" ADD CONSTRAINT "users_full_name_length" CHECK (char_length("full_name") BETWEEN 1 AND 100);
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_application_message_length" CHECK ("application_message" IS NULL OR char_length("application_message") BETWEEN 10 AND 1000);
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_decision_note_length" CHECK ("decision_note" IS NULL OR char_length("decision_note") BETWEEN 1 AND 1000);
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_original_name_length" CHECK (char_length("original_name") BETWEEN 1 AND 255);
