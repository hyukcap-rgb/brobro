import {
  bigint,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { dailyScanRunsTable } from "./daily-scan-runs";

// One row per (notice, matched keyword, attachment) hit found by the daily
// scan. This is the cumulative, ever-growing list shown on the "누적 결과"
// screen and downloadable as Excel — the actual sales-lead list.
export const awardedMatchesTable = pgTable(
  "awarded_matches",
  {
    id: serial("id").primaryKey(),
    scanRunId: integer("scan_run_id").references(() => dailyScanRunsTable.id),
    noticeNumber: text("notice_number").notNull(),
    noticeName: text("notice_name"),
    siteName: text("site_name"),
    siteOffice: text("site_office"),
    workTypeName: text("work_type_name"),
    demandAgency: text("demand_agency"),
    bidderName: text("bidder_name"),
    bidderBizno: text("bidder_bizno"),
    bidderAddress: text("bidder_address"),
    bidderPhone: text("bidder_phone"),
    budgetAmount: bigint("budget_amount", { mode: "number" }),
    awardAmount: bigint("award_amount", { mode: "number" }),
    awardDate: text("award_date"),
    matchedKeyword: text("matched_keyword").notNull(),
    quantityText: text("quantity_text"),
    surroundingText: text("surrounding_text"),
    attachmentFileName: text("attachment_file_name"),
    attachmentStoredPath: text("attachment_stored_path"),
    smsSentAt: timestamp("sms_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A notice can legitimately produce more than one row (different
    // attachment / different matched keyword), but the exact same hit should
    // never be inserted twice across scan reruns.
    uniqueIndex("awarded_matches_unique_hit").on(
      table.noticeNumber,
      table.matchedKeyword,
      table.attachmentFileName,
    ),
  ],
);

export type AwardedMatch = typeof awardedMatchesTable.$inferSelect;
export type InsertAwardedMatch = typeof awardedMatchesTable.$inferInsert;
