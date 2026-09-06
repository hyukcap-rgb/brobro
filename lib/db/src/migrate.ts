import { pool } from "./index";

// Lightweight, idempotent schema bootstrap. This project doesn't run a
// migration-file workflow (see drizzle-kit "push"/"push-force" in
// package.json, which is a manual dev-time command) — instead the tables the
// daily-scan feature needs are created here with CREATE TABLE IF NOT EXISTS
// on every boot, so a fresh production database picks them up automatically
// on first deploy without a manual step. Keep this in sync with
// src/schema/*.ts by hand; drizzle-kit push can still be run manually to
// reconcile anything this script doesn't cover (e.g. column changes).
export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_super_admin TEXT NOT NULL DEFAULT 'false',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1,
      match_keywords JSONB NOT NULL,
      work_type_keywords JSONB NOT NULL,
      min_budget_amount BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS daily_scan_runs (
      id SERIAL PRIMARY KEY,
      target_dates JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      trigger_type TEXT NOT NULL DEFAULT 'schedule',
      awards_found INTEGER NOT NULL DEFAULT 0,
      candidates_checked INTEGER NOT NULL DEFAULT 0,
      matches_found INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS awarded_matches (
      id SERIAL PRIMARY KEY,
      scan_run_id INTEGER REFERENCES daily_scan_runs(id),
      notice_number TEXT NOT NULL,
      notice_name TEXT,
      site_name TEXT,
      site_office TEXT,
      work_type_name TEXT,
      demand_agency TEXT,
      bidder_name TEXT,
      bidder_bizno TEXT,
      bidder_address TEXT,
      bidder_phone TEXT,
      budget_amount BIGINT,
      award_amount BIGINT,
      award_date TEXT,
      matched_keyword TEXT NOT NULL,
      quantity_text TEXT,
      surrounding_text TEXT,
      attachment_file_name TEXT,
      attachment_stored_path TEXT,
      sms_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS awarded_matches_unique_hit
      ON awarded_matches (notice_number, matched_keyword, attachment_file_name);

    -- express-session's store (connect-pg-simple) ships a table.sql asset it
    -- reads from disk to create this table on demand ("createTableIfMissing").
    -- That file doesn't survive our esbuild bundling step, so relying on it
    -- fails at runtime (ENOENT) and silently breaks session persistence —
    -- every login "succeeds" but the session is never actually saved, so the
    -- very next request looks logged out. We create the table ourselves here
    -- instead (schema matches connect-pg-simple's own default exactly) and
    -- set createTableIfMissing: false in app.ts.
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    );

    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);
}
