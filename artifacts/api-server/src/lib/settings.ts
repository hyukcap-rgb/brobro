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

// 요구사항(2026-09-14 사용자 요청: "나라장터를 기본으로, 토지공사나 군대 입찰싸이트도
// 선택하면 검색할 수 있도록"): 매일 07시 자동 검색 + 수동 검색 모두가 대상으로
// 삼을 사이트 목록. "나라장터"는 항상 강제 포함(화면에서 끌 수 없음). "D2B"(군대)는
// 아직 API 연동이 없어 SUPPORTED_SOURCES에 포함하지 않는다 — 화면에는 비활성화
// 표시만 한다.
export const SUPPORTED_SOURCES = ["나라장터", "LH"] as const;
export type SiteSource = (typeof SUPPORTED_SOURCES)[number];

const DEFAULT_SOURCES: SiteSource[] = ["나라장터"];

export interface AppSettingsView {
  matchKeywords: string[];
  workTypeKeywords: string[];
  workCategories: string[];
  minEstimatedPrice: number | null;
  maxEstimatedPrice: number | null;
  minBudgetAmount: number;
  notificationEmails: string[];
  enabledSources: string[];
  secondaryKeywords: string[];
  secondaryMinAwardAmount: number | null;
  secondaryMaxAwardAmount: number | null;
  updatedAt: string;
}

function toView(row: {
  matchKeywords: string[];
  workTypeKeywords: string[];
  workCategories: string[];
  minEstimatedPrice: number | null;
  maxEstimatedPrice: number | null;
  minBudgetAmount: number;
  notificationEmails: string[];
  enabledSources: string[];
  secondaryKeywords: string[];
  secondaryMinAwardAmount: number | null;
  secondaryMaxAwardAmount: number | null;
  updatedAt: Date;
}): AppSettingsView {
  return {
    matchKeywords: row.matchKeywords,
    workTypeKeywords: row.workTypeKeywords,
    workCategories: row.workCategories,
    minEstimatedPrice: row.minEstimatedPrice ?? null,
    maxEstimatedPrice: row.maxEstimatedPrice ?? null,
    minBudgetAmount: row.minBudgetAmount,
    notificationEmails: row.notificationEmails ?? [],
    // "나라장터"는 화면에서 끌 수 없는 항상 포함 사이트이므로, 과거 데이터에
    // 없더라도(마이그레이션 직후 등) 항상 강제로 포함시킨다.
    enabledSources: Array.from(new Set(["나라장터", ...(row.enabledSources ?? [])])),
    secondaryKeywords: row.secondaryKeywords ?? [],
    secondaryMinAwardAmount: row.secondaryMinAwardAmount ?? null,
    secondaryMaxAwardAmount: row.secondaryMaxAwardAmount ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// 요구사항(2026-09-18 사용자 요청: "admin 과 msjbro 는 별도의 독립적인 id
// 야. msjbro에는 admin 의 모든 정보를 공유하지않아. 독립적인 id 로 작동되는
// 거야. 두 아이디로 입력은 서로 영향을 미치지 않아"): 예전에는 이 설정이
// id=1 고정인 단일 행이라 어떤 관리자로 로그인하든 같은 설정을 보고 같은
// 설정을 바꿨다. 이제 호출부(routes/settings.ts, daily-scan.ts)가 항상
// req.session.userId(로그인한 관리자 계정)를 넘겨줘야 하고, 그 계정 소유의
// 설정 행만 읽고 쓴다 — 계정이 다르면 완전히 별도의 키워드·예산·이메일
// 설정을 갖는다.
export async function getAppSettings(adminUserId: number): Promise<AppSettingsView> {
  const [existing] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.adminUserId, adminUserId))
    .limit(1);
  if (existing) return toView(existing);
  const [created] = await db
    .insert(appSettingsTable)
    .values({
      adminUserId,
      matchKeywords: [...DEFAULT_KEYWORDS],
      workTypeKeywords: DEFAULT_WORK_TYPE_KEYWORDS,
      workCategories: DEFAULT_WORK_CATEGORIES,
      minBudgetAmount: DEFAULT_MIN_BUDGET,
      notificationEmails: [],
      enabledSources: DEFAULT_SOURCES,
      secondaryKeywords: [],
    })
    .onConflictDoNothing()
    .returning();
  if (created) return toView(created);
  // Someone else inserted concurrently; read it back.
  const [row] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.adminUserId, adminUserId))
    .limit(1);
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
  notificationEmails?: string[];
  enabledSources?: string[];
  secondaryKeywords?: string[];
  secondaryMinAwardAmount?: number | null;
  secondaryMaxAwardAmount?: number | null;
}

export async function updateAppSettings(adminUserId: number, input: UpdateSettingsInput): Promise<AppSettingsView> {
  await getAppSettings(adminUserId); // ensure row exists
  const [updated] = await db
    .update(appSettingsTable)
    .set({
      ...(input.matchKeywords ? { matchKeywords: input.matchKeywords } : {}),
      ...(input.workTypeKeywords ? { workTypeKeywords: input.workTypeKeywords } : {}),
      ...(input.workCategories ? { workCategories: input.workCategories } : {}),
      ...(input.minEstimatedPrice !== undefined ? { minEstimatedPrice: input.minEstimatedPrice } : {}),
      ...(input.maxEstimatedPrice !== undefined ? { maxEstimatedPrice: input.maxEstimatedPrice } : {}),
      ...(input.minBudgetAmount !== undefined ? { minBudgetAmount: input.minBudgetAmount } : {}),
      ...(input.notificationEmails ? { notificationEmails: input.notificationEmails } : {}),
      // "나라장터"는 항상 강제 포함 — 화면에서 체크를 뺀 값이 그대로 와도 저장
      // 시점에 다시 채워 넣는다(사용자가 실수로 나라장터를 끌 수 없게).
      ...(input.enabledSources
        ? { enabledSources: Array.from(new Set(["나라장터", ...input.enabledSources])) }
        : {}),
      // 요구사항(2026-09-15 사용자 요청: 2차 키워드): 빈 배열도 유효한 값(=2차
      // 조건 끄기)이라 matchKeywords처럼 truthy 체크만으로 충분하다 — []는
      // JS에서 truthy이므로 정상적으로 저장된다.
      ...(input.secondaryKeywords ? { secondaryKeywords: input.secondaryKeywords } : {}),
      ...(input.secondaryMinAwardAmount !== undefined
        ? { secondaryMinAwardAmount: input.secondaryMinAwardAmount }
        : {}),
      ...(input.secondaryMaxAwardAmount !== undefined
        ? { secondaryMaxAwardAmount: input.secondaryMaxAwardAmount }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(appSettingsTable.adminUserId, adminUserId))
    .returning();
  if (!updated) throw new Error("설정을 업데이트하지 못했습니다.");
  return toView(updated);
}
