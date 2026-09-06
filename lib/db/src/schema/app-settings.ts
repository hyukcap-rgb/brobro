import { bigint, jsonb, pgTable, smallint, timestamp } from "drizzle-orm/pg-core";

// Single-row configuration table (id is always 1). Holds the admin-tunable
// criteria for the daily 낙찰 공고 scan: which document keywords count as a
// match (default 부직포 and its variants), which 공종/업무 keywords qualify a
// notice, and the minimum construction budget to bother scanning.
export const appSettingsTable = pgTable("app_settings", {
  id: smallint("id").primaryKey().default(1),
  matchKeywords: jsonb("match_keywords").$type<string[]>().notNull(),
  workTypeKeywords: jsonb("work_type_keywords").$type<string[]>().notNull(),
  minBudgetAmount: bigint("min_budget_amount", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AppSettingsRow = typeof appSettingsTable.$inferSelect;
export type InsertAppSettings = typeof appSettingsTable.$inferInsert;
