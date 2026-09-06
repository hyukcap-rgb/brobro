import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// One row per daily automated scan execution (also created for manually
// triggered runs from the admin screen). targetDates covers the award
// date(s) actually searched: normally just "yesterday", but two dates when
// the run happens on a Monday or the day after a holiday.
export const dailyScanRunsTable = pgTable("daily_scan_runs", {
  id: serial("id").primaryKey(),
  targetDates: jsonb("target_dates").$type<string[]>().notNull(),
  status: text("status", { enum: ["running", "completed", "failed"] }).notNull().default("running"),
  triggerType: text("trigger_type", { enum: ["schedule", "manual"] }).notNull().default("schedule"),
  awardsFound: integer("awards_found").notNull().default(0),
  candidatesChecked: integer("candidates_checked").notNull().default(0),
  matchesFound: integer("matches_found").notNull().default(0),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export type DailyScanRun = typeof dailyScanRunsTable.$inferSelect;
export type InsertDailyScanRun = typeof dailyScanRunsTable.$inferInsert;
