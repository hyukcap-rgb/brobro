import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// 요구사항(2026-09-11 사용자 요청: 조달청 "조달업체 등록 내역" 공공데이터를
// 알려주며 "기존 낙찰자 정보를 이 API로 보강"해달라고 요청): 조달청 "나라장터
// 사용자정보 서비스"(조달업체 기본정보 조회, getPrcrmntCorpBasicInfo02)로
// 사업자등록번호(bizno) 기준 정확 매칭 조회한 주소/전화번호를 영구 캐시한다.
// 같은 사업자등록번호는 평생 한 번만 조회하고(못 찾은 경우 포함) 이후에는
// 이 캐시만 사용해 API 호출을 아낀다. business_contact_cache(회사명+지역
// 기준, 네이버 검색용)와는 조회 기준(정확한 사업자등록번호)과 출처(조달청
// 정식 등록정보)가 달라 별도 테이블로 둔다.
export const govCorpCacheTable = pgTable("gov_corp_cache", {
  bizno: text("bizno").primaryKey(),
  checked: boolean("checked").notNull().default(false),
  address: text("address"),
  phone: text("phone"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GovCorpCacheRow = typeof govCorpCacheTable.$inferSelect;
export type InsertGovCorpCacheRow = typeof govCorpCacheTable.$inferInsert;
