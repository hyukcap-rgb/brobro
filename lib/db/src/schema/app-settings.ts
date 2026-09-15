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
  // 요구사항(2026-09-12 사용자 요청: "설정에서 매일 검색 결과를 이메일로 자동
  // 전송될 수 있는 주소를 넣는곳을 만들어줘"): 매일 07시 자동 스캔이 끝났을 때
  // 결과 요약 메일을 받을 주소 목록. 설정 화면에서 추가/삭제한다.
  notificationEmails: jsonb("notification_emails").$type<string[]>().notNull().default([]),
  // 요구사항(2026-09-14 사용자 요청: "토지공사나 군대 입찰싸이트도 선택하면 검색할 수
  // 있는 싸이트로 업그레이드"): 매일 07시 자동 검색 + 수동 검색 모두에서 어떤
  // 사이트를 조회할지. "나라장터"는 항상 포함(화면에서 끌 수 없음). "LH"는 선택.
  // "D2B"(군대)는 API 연동 전까지 화면에서 비활성화 표시만 하고 저장 값에는
  // 나타나지 않는다.
  enabledSources: jsonb("enabled_sources").$type<string[]>().notNull().default(["나라장터"]),
  // 요구사항(2026-09-15 사용자 요청: "키워드 2번째를 설정할 수 있도록 해줘.
  // 낙찰금액과 공사제목만 넣으면 첫번째 키워드가 없어도 검색되게 하는거야"):
  // 1차 키워드(matchKeywords, 첨부파일 내용 검색)와 완전히 독립된 2차 조건.
  // 공고 제목에 이 키워드 중 하나라도 있고 낙찰금액이 아래 범위 안이면,
  // 업무구분/추정가격/최소공사규모/첨부파일 존재 여부와 무관하게 리드로
  // 등록한다 — daily-scan.ts 참고. 비어 있으면(기본값) 이 조건을 쓰지 않는다.
  secondaryKeywords: jsonb("secondary_keywords").$type<string[]>().notNull().default([]),
  secondaryMinAwardAmount: bigint("secondary_min_award_amount", { mode: "number" }),
  secondaryMaxAwardAmount: bigint("secondary_max_award_amount", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AppSettingsRow = typeof appSettingsTable.$inferSelect;
export type InsertAppSettings = typeof appSettingsTable.$inferInsert;
