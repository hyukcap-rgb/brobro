import { bigint, jsonb, pgTable, smallint, timestamp } from "drizzle-orm/pg-core";

// Single-row configuration table (id is always 1). Holds the admin-tunable
// criteria for the daily 낙찰 공고 scan: which document keywords count as a
// match (default 부직포 and its variants), which 공종/업무 keywords qualify a
// notice, and the minimum construction budget to bother scanning.
export const appSettingsTable = pgTable("app_settings", {
  id: smallint("id").primaryKey().default(1),
  matchKeywords: jsonb("match_keywords").$type<string[]>().notNull(),
  workTypeKeywords: jsonb("work_type_keywords").$type<string[]>().notNull(),
  // 업무구분(물품/일반용역/기술용역/공사) - 나라장터 API가 실제로 지원하는 값만.
  // 기타/민간은 별도 API 연동(누리장터)이 필요해 아직 지원하지 않는다.
  workCategories: jsonb("work_categories").$type<string[]>().notNull(),
  // 추정가격(presmptPrce) 범위. 둘 다 null이면 추정가격으로는 거르지 않는다.
  minEstimatedPrice: bigint("min_estimated_price", { mode: "number" }),
  maxEstimatedPrice: bigint("max_estimated_price", { mode: "number" }),
  minBudgetAmount: bigint("min_budget_amount", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AppSettingsRow = typeof appSettingsTable.$inferSelect;
export type InsertAppSettings = typeof appSettingsTable.$inferInsert;
