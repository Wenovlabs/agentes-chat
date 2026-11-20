-- Wenovlab fork migration 0001 (own registry: wenovlab.fork_migrations, not drizzle's). Statements are idempotent.
CREATE SCHEMA IF NOT EXISTS "wenovlab";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wenovlab"."weekly_quota_policy" (
  "org_id" uuid NOT NULL,
  "machine_account_id" uuid NOT NULL,
  "cap_percent" integer CHECK ("cap_percent" BETWEEN 0 AND 100),
  "release_hours" integer CHECK ("release_hours" >= 0),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "machine_account_id"),
  FOREIGN KEY ("org_id", "machine_account_id") REFERENCES "public"."machine_accounts"("org_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
-- Keeps what the retired official-journal migration 0309 left on a database that ran it (columns on machine_accounts).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'machine_accounts' AND column_name = 'weekly_cap_percent'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'machine_accounts' AND column_name = 'weekly_release_hours'
  ) THEN
    EXECUTE 'INSERT INTO "wenovlab"."weekly_quota_policy" ("org_id", "machine_account_id", "cap_percent", "release_hours")
             SELECT "org_id", "id", "weekly_cap_percent", "weekly_release_hours" FROM "public"."machine_accounts"
             WHERE "weekly_cap_percent" IS NOT NULL OR "weekly_release_hours" IS NOT NULL
             ON CONFLICT ("org_id", "machine_account_id") DO NOTHING';
  END IF;
END $$;
