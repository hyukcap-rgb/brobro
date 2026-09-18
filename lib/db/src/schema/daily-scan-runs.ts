import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { adminUsersTable } from "./admin-users";

// One row per daily automated scan execution (also created for manually
// triggered runs from the admin screen). targetDates covers the award
// date(s) actually searched: normally just "yesterday", but two dates when
// the run happens on a Monday or the day after a holiday.
//
// 요구사항(2026-09-18 사용자 요청: "admin 과 msjbro 는 별도의 독립적인 id
// 야... 두 아이디로 입력은 서로 영향을 미치지 않아"): 스캔 실행도 계정마다
// 독립적으로 돈다 — 어떤 관리자 계정의 설정(키워드·예산 등)으로 실행됐는지,
// 그 결과(awarded_matches)가 어느 계정 소유인지를 이 컬럼으로 구분한다.
export const dailyScanRunsTable = pgTable("daily_scan_runs", {
  id: serial("id").primaryKey(),
  adminUserId: integer("admin_user_id")
    .notNull()
    .references(() => adminUsersTable.id, { onDelete: "cascade" }),
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
