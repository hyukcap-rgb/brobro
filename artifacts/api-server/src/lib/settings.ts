import { db, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { DEFAULT_KEYWORDS } from "./bid-processing";

// 업무구분(공종) 판단용 기본 키워드. 나라장터 공고 상세 API의 주공종명/부공종명
// 필드는 실제로 비어있는 경우가 많아, 채워져 있으면 그것을 우선 쓰고 비어 있으면
// 공고명 등에서 이 키워드로 대체 판단한다 (하이브리드 방식).
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

const DEFAULT_MIN_BUDGET = 50_000_000;

export interface AppSettingsView {
  matchKeywords: string[];
  workTypeKeywords: string[];
  minBudgetAmount: number;
  updatedAt: string;
}

function toView(row: {
  matchKeywords: string[];
  workTypeKeywords: string[];
  minBudgetAmount: number;
  updatedAt: Date;
}): AppSettingsView {
  return {
    matchKeywords: row.matchKeywords,
    workTypeKeywords: row.workTypeKeywords,
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
  minBudgetAmount?: number;
}

export async function updateAppSettings(input: UpdateSettingsInput): Promise<AppSettingsView> {
  await getAppSettings(); // ensure row exists
  const [updated] = await db
    .update(appSettingsTable)
    .set({
      ...(input.matchKeywords ? { matchKeywords: input.matchKeywords } : {}),
      ...(input.workTypeKeywords ? { workTypeKeywords: input.workTypeKeywords } : {}),
      ...(input.minBudgetAmount !== undefined ? { minBudgetAmount: input.minBudgetAmount } : {}),
      updatedAt: new Date(),
    })
    .where(eq(appSettingsTable.id, 1))
    .returning();
  if (!updated) throw new Error("설정을 업데이트하지 못했습니다.");
  return toView(updated);
}
