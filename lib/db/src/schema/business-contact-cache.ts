import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// 요구사항(2026-09-11 사용자 지적: "API 는 호출량이 있고... 이런식으로 하면
// 손해배상청구 소송"): 낙찰자 연락처를 네이버 오픈API(지역검색/웹문서/블로그
// 검색)로 보완할 때, 기존에는 캐시가 "이번 스캔 실행 중"에만 메모리에 남아있다
// 실행이 끝나면 사라졌다 — 같은 회사가 다음 주/다음 달 다른 공고에 또 낙찰돼도
// 네이버 API를 처음부터 다시 불렀다. 여기에 회사명(+지역) 단위로 영구 캐시해
// 같은 회사는 평생 한 번만 조회하면 되게 한다. 지역검색(portal)과 웹/블로그
// 검색(web)은 서로 다른 API·다른 결과이므로 각각 "조회했는지"와 "조회 결과"를
// 따로 기록한다 — 아직 안 해본 쪽만 API를 부르고, 해봤는데 못 찾은 것도
// (checked=true, 값=null) 그대로 캐시해 다시 묻지 않는다.
export const businessContactCacheTable = pgTable("business_contact_cache", {
  cacheKey: text("cache_key").primaryKey(),
  portalChecked: boolean("portal_checked").notNull().default(false),
  portalAddress: text("portal_address"),
  portalPhone: text("portal_phone"),
  webChecked: boolean("web_checked").notNull().default(false),
  webPhone: text("web_phone"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BusinessContactCacheRow = typeof businessContactCacheTable.$inferSelect;
export type InsertBusinessContactCacheRow = typeof businessContactCacheTable.$inferInsert;
