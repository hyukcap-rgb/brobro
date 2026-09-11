import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// 요구사항(2026-09-11 사용자 제안: "전일 공사 항목의 첨부파일을 서버에 저장하고
// 서버에 저장한 파일을 키워드 검색하면 어떨까"): 공고 "상세정보"(첨부파일 URL,
// 예산, 업무구분 등)는 한 번 공고가 등록되면 이후로 바뀌지 않는다 — 매일 다시
// 확인해야 하는 것은 "최종낙찰자 확정 여부"뿐이고, 그건 상세 API가 아니라 낙찰
// 목록 API(fetchAwardsForDate)로 확인한다. 그런데도 daily-scan.ts는
// RECHECK_WINDOW_DAYS(최근 3일 재확인) 로직 때문에 같은 공고의 상세정보를 매일,
// 그리고 수동 재실행 때마다 data.go.kr 상세 API로 매번 다시 조회하고 있었다 —
// 이게 "일일 서비스 요청제한 횟수 초과" 오류의 실질적 원인이었다. 한 번 조회에
// 성공한 공고의 상세정보(JSON 원본)를 여기 캐시해두고, 같은 공고를 다시 만나면
// API를 다시 부르지 않고 이 캐시를 그대로 재사용해 호출 횟수를 크게 줄인다.
export const noticeDetailCacheTable = pgTable("notice_detail_cache", {
  noticeNumber: text("notice_number").primaryKey(),
  source: text("source").notNull(),
  detailJson: jsonb("detail_json").$type<Record<string, unknown>>().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export type NoticeDetailCacheRow = typeof noticeDetailCacheTable.$inferSelect;
export type InsertNoticeDetailCacheRow = typeof noticeDetailCacheTable.$inferInsert;
