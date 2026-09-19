import {
  bigint,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { adminUsersTable } from "./admin-users";
import { dailyScanRunsTable } from "./daily-scan-runs";

// One row per (notice, matched keyword, attachment) hit found by the daily
// scan. This is the cumulative, ever-growing list shown on the "누적 결과"
// screen and downloadable as Excel — the actual sales-lead list.
//
// 요구사항(2026-09-18 사용자 요청: "admin 과 msjbro 는 별도의 독립적인 id
// 야. msjbro에는 admin 의 모든 정보를 공유하지않아... 두 아이디로 입력은
// 서로 영향을 미치지 않아"): 어느 계정이 찾은 리드인지를 scanRunId를 거친
// 조인 없이도 바로 걸러낼 수 있도록 adminUserId를 직접 갖는다. 아래 유니크
// 인덱스에도 포함시켜, 두 계정이 우연히 같은 키워드 설정으로 같은 공고를
// 각자 찾아내도 서로의 결과를 가리지 않고 독립적으로 남도록 한다.
export const awardedMatchesTable = pgTable(
  "awarded_matches",
  {
    id: serial("id").primaryKey(),
    adminUserId: integer("admin_user_id")
      .notNull()
      .references(() => adminUsersTable.id, { onDelete: "cascade" }),
    scanRunId: integer("scan_run_id").references(() => dailyScanRunsTable.id),
    noticeNumber: text("notice_number").notNull(),
    noticeName: text("notice_name"),
    siteName: text("site_name"),
    siteOffice: text("site_office"),
    // 실제 공사현장 위치(사업자 소재지인 bidderAddress와는 다름). daily-scan.ts 참고.
    siteAddress: text("site_address"),
    workTypeName: text("work_type_name"),
    // 이 공고를 어떤 업무구분 API(물품/용역/공사)로 찾았는지.
    workCategory: text("work_category"),
    // 요구사항(2026-09-14 사용자 요청: "나라장터를 기본으로, 토지공사나 군대
    // 입찰싸이트도 선택하면 검색할 수 있도록"): 이 매칭을 어느 사이트(나라장터/LH)
    // 에서 찾았는지. siteName(현장명)과는 무관한 별도 축이다.
    source: text("source").notNull().default("나라장터"),
    demandAgency: text("demand_agency"),
    bidderName: text("bidder_name"),
    bidderBizno: text("bidder_bizno"),
    bidderAddress: text("bidder_address"),
    bidderPhone: text("bidder_phone"),
    // 낙찰자 주소/연락처를 어디서 채웠는지: government(정부 낙찰기록) /
    // attachment(첨부파일에서 추출) / portal(네이버 지역검색 API로 보완).
    contactSource: text("contact_source"),
    budgetAmount: bigint("budget_amount", { mode: "number" }),
    estimatedAmount: bigint("estimated_amount", { mode: "number" }),
    awardAmount: bigint("award_amount", { mode: "number" }),
    awardDate: text("award_date"),
    matchedKeyword: text("matched_keyword").notNull(),
    quantityText: text("quantity_text"),
    surroundingText: text("surrounding_text"),
    attachmentFileName: text("attachment_file_name"),
    attachmentStoredPath: text("attachment_stored_path"),
    // 요구사항(첨부파일 보관, 2026-09-09): 다운로드된 첨부파일은 최대 5개월간만
    // 디스크에 보관하고 자동 삭제된다(재요청 방지용 캐시일 뿐, 리드 원본 데이터가
    // 아니므로). 이 컬럼이 채워지면 실제 파일은 이미 삭제된 상태이고, 매칭 레코드
    // 자체(리드 정보)는 그대로 남는다 — attachment-cleanup.ts 참고.
    attachmentDeletedAt: timestamp("attachment_deleted_at", { withTimezone: true }),
    smsSentAt: timestamp("sms_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A notice can legitimately produce more than one row (different
    // attachment / different matched keyword), but the exact same hit should
    // never be inserted twice across scan reruns.
    //
    // 요구사항(2026-09-19 사용자 재지적: "검색결과가 1000m2 이하인 것들도
    // 많던데 내가 1000m2 이하는 검색하지 말라고 했잖아"): 예전에는 이
    // 인덱스가 (계정, 사이트, 공고, 매칭키워드, 첨부파일명)까지만 걸려서,
    // 같은 첨부파일 한 개 안에서 "부직포"가 여러 줄(예: 87㎡, 263㎡)에 걸쳐
    // 여러 번 매칭되면 전부 똑같은 유니크 키를 갖게 됐다 — 그래서 daily-
    // scan.ts는 메모리상으로는 "이 공고에 매칭이 2건이니 1,000㎡ 이하
    // 단독매칭 제외 규칙을 적용하지 않는다"고 정확히 판단했는데도, 실제
    // DB에는 onConflictDoNothing에 의해 그 중 1건(더 작은 수량일 수도 있는
    // 아무 1건)만 저장되고 나머지는 조용히 사라졌다. 결과적으로 "여러 건 중
    // 작은 것 하나만 화면에 노출"되는, 사용자가 명시적으로 하지 말라고 한
    // 상황이 재현됐다. surroundingText(매칭된 줄의 셀/행 위치까지 포함하는
    // 텍스트, 예: "C29=... E29=87 F29=㎡")를 인덱스에 추가해 같은 파일 안의
    // 서로 다른 매칭 줄이 서로 다른 유니크 키를 갖게 한다 — 재실행 시 완전히
    // 동일한 매칭(같은 줄)만 여전히 중복 삽입을 막는다.
    uniqueIndex("awarded_matches_unique_hit").on(
      table.adminUserId,
      table.source,
      table.noticeNumber,
      table.matchedKeyword,
      table.attachmentFileName,
      table.surroundingText,
    ),
  ],
);

export type AwardedMatch = typeof awardedMatchesTable.$inferSelect;
export type InsertAwardedMatch = typeof awardedMatchesTable.$inferInsert;
