import { db, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { DEFAULT_KEYWORDS } from "./bid-processing";

// 업무구분(공종) 판단용 기본 키워드. 나라장터 공고 상세 API의 주공종명/부공종명
// 필드는 실제로 비어있는 경우가 많아, 채워져 있으면 그것을 우선 쓰고 비어 있으면
// 공고명 등에서 이 키워드로 대체 판단한다 (하이브리드 방식). 공사(Cnstwk)에만
// 해당하는 개념이라 물품/용역 카테고리에는 적용하지 않는다.
const DEFAULT_WORK_TYPE_KEYWORDS = [
  "토목",
  "조경",
  "수해복구",
  "하천",
  "배수",
  "우수관",
  "포장",
  "옹벽",
];

// 업무구분(사업 종류): 나라장터 OpenAPI가 실제로 별도 엔드포인트를 제공하는
// 물품(Thng)/용역(Servc)/공사(Cnstwk)만 지원한다. "기타"와 "민간"은 나라장터가
// 아닌 별도의 누리장터 API 등록이 필요해 아직 연동하지 않았다 — daily-scan.ts의
// WORK_CATEGORY_SOURCES 주석 참고.
export const SUPPORTED_WORK_CATEGORIES = ["물품", "일반용역", "기술용역", "공사"] as const;
export type WorkCategory = (typeof SUPPORTED_WORK_CATEGORIES)[number];

const DEFAULT_WORK_CATEGORIES: WorkCategory[] = ["물품", "일반용역", "기술용역", "공사"];
const DEFAULT_MIN_BUDGET = 50_000_000;

export interface AppSettingsView {
  matchKeywords: string[];
  workTypeKeywords: string[];
  workCategories: string[];
  minEstimatedPrice: number | null;
  maxEstimatedPrice: number | null;
  minBudgetAmount: number;
  updatedAt: string;
}

function toView(row: {
  matchKeywords: string[];
  workTypeKeywords: string[];
  workCategories: string[];
  minEstimatedPrice: number | null;
  maxEstimatedPrice: number | null;
  minBudgetAmount: number;
  updatedAt: Date;
}): AppSettingsView {
  return {
    matchKeywords: row.matchKeywords,
    workTypeKeywords: row.workTypeKeywords,
    workCategories: row.workCategories,
    minEstimatedPrice: row.minEstimatedPrice ?? null,
    maxEstimatedPrice: row.maxEstimatedPrice ?? null,
    minBudgetAmount: row.minBudgetAmount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getAppSettings(): Promise<AppSettingsView> {
  const [existing] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.id, 1)).limit(1);
  if (existing) return toView(existing);
  const [created] = await db
    .insert(appSettingsTable)
    .values({
      id: 1,
      matchKeywords: [...DEFAULT_KEYWORDS],
      workTypeKeywords: DEFAULT_WORK_TYPE_KEYWORDS,
      workCategories: DEFAULT_WORK_CATEGORIES,
      minBudgetAmount: DEFAULT_MIN_BUDGET,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return toView(created);
  // Someone else inserted concurrently; read it back.
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.id, 1)).limit(1);
  if (!row) throw new Error("설정을 초기화하지 못했습니다.");
  return toView(row);
}

export interface UpdateSettingsInput {
  matchKeywords?: string[];
  workTypeKeywords?: string[];
  workCategories?: string[];
  minEstimatedPrice?: number | null;
  maxEstimatedPrice?: number | null;
  minBudgetAmount?: number;
}

export async function updateAppSettings(input: UpdateSettingsInput): Promise<AppSettingsView> {
  await getAppSettings(); // ensure row exists
  const [updated] = await db
    .update(appSettingsTable)
    .set({
      ...(input.matchKeywords ? { matchKeywords: input.matchKeywords } : {}),
      ...(input.workTypeKeywords ? { workTypeKeywords: input.workTypeKeywords } : {}),
      ...(input.workCategories ? { workCategories: input.workCategories } : {}),
      ...(input.minEstimatedPrice !== undefined ? { minEstimatedPrice: input.minEstimatedPrice } : {}),
      ...(input.maxEstimatedPrice !== undefined ? { maxEstimatedPrice: input.maxEstimatedPrice } : {}),
      ...(input.minBudgetAmount !== undefined ? { minBudgetAmount: input.minBudgetAmount } : {}),
      updatedAt: new Date(),
    })
    .where(eq(appSettingsTable.id, 1))
    .returning();
  if (!updated) throw new Error("설정을 업데이트하지 못했습니다.");
  return toView(updated);
}
