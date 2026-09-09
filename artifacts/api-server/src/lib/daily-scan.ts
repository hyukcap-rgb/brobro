import { tmpdir } from "node:os";
import path from "node:path";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { desc, eq } from "drizzle-orm";
import { db, dailyScanRunsTable, awardedMatchesTable, type DailyScanRun } from "@workspace/db";
import {
  requestBuffer,
  formatServiceKey,
  normalizeItems,
  collectAttachments,
  isPriorityAttachment,
  sanitizeName,
  downloadAttachment,
  extractZipRecursively,
  extractSegments,
  searchSegments,
  withRetry,
  describeError,
  extractItemFields,
  extractBusinessContactFromText,
  searchBusinessContactOnPortal,
} from "./bid-processing";
import { getAppSettings } from "./settings";
import { kstToday, shiftKstDate, isKoreanHoliday, type KstDate } from "./kr-holidays";
import { SCAN_ROOT } from "./scan-storage";
import { logger } from "./logger";

// 하루 API 장애 등으로 여러 날이 한꺼번에 누락된 경우, 한 번의 실행에서 최대
// 이만큼만 소급 채운다(끝없이 과거로 폭주하는 것을 막는 안전장치). 이보다 긴
// 공백은 매일 조금씩 나눠서 채워지고, 로그에 경고를 남긴다.
const MAX_GAP_FILL_DAYS = 14;

// 요구사항(재확인, 2026-09-08 사용자 확인): 나라장터의 "최종낙찰자" 데이터는
// 개찰일이 지나도 몇 시간~며칠에 걸쳐 점진적으로 확정되어, 이미 "완료"로 기록된
// 날짜라도 다시 스캔하면 새로 확정된 낙찰건이 추가로 나타날 수 있다. 기존
// 갭필 로직은 "완료"로 기록된 날짜는 다시 보지 않으므로, 이런 뒤늦은 확정
// 건들은 영구적으로 누락될 수 있었다 — 이를 막기 위해 매 실행마다 최근
// N일(어제/그저께/그끄제)을 완료 여부와 무관하게 항상 다시 훑는다.
// awardedMatchesTable insert는 onConflictDoNothing()이라 중복 저장 걱정 없이
// 안전하게 재확인할 수 있다.
const RECHECK_WINDOW_DAYS = 3;

// 업무구분(사업 종류)별 나라장터 OpenAPI 엔드포인트. 조달청이 물품(Thng)/
// 용역(Servc)/공사(Cnstwk)를 각각 별도 오퍼레이션으로 제공하기 때문에, 사용자가
// 설정에서 고른 업무구분마다 이 매핑으로 정확한 URL을 찾아 따로 조회한다.
// "일반용역"과 "기술용역"은 나라장터 API 상 하나의 용역(Servc) 오퍼레이션으로만
// 제공되고 서로 구분되는 필드가 확인되지 않아, 둘 중 하나라도 선택되면 용역
// 오퍼레이션을 한 번만 호출한다 (SOURCE_BY_CATEGORY로 매핑).
//
// "기타"와 "민간"은 나라장터가 아니라 완전히 별도의 누리장터
// (조달청_누리장터 민간입찰공고서비스/민간낙찰정보서비스) API 등록이 필요해서
// 아직 연동하지 않았다 — settings.ts의 SUPPORTED_WORK_CATEGORIES 참고.
type WorkSource = "물품" | "용역" | "공사";

const WORK_SOURCE_ENDPOINTS: Record<WorkSource, { awardUrl: string; detailUrl: string }> = {
  공사: {
    awardUrl: "https://apis.data.go.kr/1230000/as/ScsbidInfoService/getScsbidListSttusCnstwk",
    detailUrl: "https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoCnstwk",
  },
  물품: {
    awardUrl: "https://apis.data.go.kr/1230000/as/ScsbidInfoService/getScsbidListSttusThng",
    detailUrl: "https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoThng",
  },
  용역: {
    awardUrl: "https://apis.data.go.kr/1230000/as/ScsbidInfoService/getScsbidListSttusServc",
    detailUrl: "https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoServc",
  },
};

const CATEGORY_TO_SOURCE: Record<string, WorkSource> = {
  물품: "물품",
  일반용역: "용역",
  기술용역: "용역",
  공사: "공사",
};

function resolveWorkSources(workCategories: string[]): WorkSource[] {
  const sources = new Set<WorkSource>();
  for (const category of workCategories) {
    const source = CATEGORY_TO_SOURCE[category];
    if (source) sources.add(source);
  }
  // 설정이 비어있거나(예: 마이그레이션 직후) 전부 미지원 값이면, 과거 기본
  // 동작(공사만 검색)으로 안전하게 되돌아간다.
  if (sources.size === 0) sources.add("공사");
  return [...sources];
}

// 요구사항 1, 2: 기본은 "전일" 낙찰 공고만 검색하고, 오늘이 월요일이거나 공휴일이면
// 전일 + 전전일 둘 다 검색한다 (주말/공휴일에는 낙찰 공고가 거의 올라오지 않기 때문).
export function computeTargetDates(instant: Date = new Date()): KstDate[] {
  const today = kstToday(instant);
  const yesterday = shiftKstDate(today, -1);
  const dayBeforeYesterday = shiftKstDate(today, -2);
  if (today.weekday === 1 || isKoreanHoliday(today)) {
    return [yesterday, dayBeforeYesterday];
  }
  return [yesterday];
}

function kstDateFromKey(key: string): KstDate {
  const [year, month, day] = key.split("-").map(Number);
  // weekday는 placeholder(0)로 넣어두고 shiftKstDate(0일 이동)를 한 번 거쳐
  // Intl.DateTimeFormat으로 정확한 요일을 다시 계산한다 — executeScanRun에서
  // 저장된 targetDates 문자열을 KstDate로 복원할 때 쓰는 것과 같은 패턴.
  const placeholder: KstDate = { key, compact: key.replaceAll("-", ""), year, month, day, weekday: 0 };
  return shiftKstDate(placeholder, 0);
}

// 완료된(status="completed") 스캔들의 targetDates 중 가장 최근 날짜(문자열
// "YYYY-MM-DD"는 사전식 정렬 = 날짜순 정렬이 그대로 성립)를 찾는다. 갭필로
// 인해 나중 실행이 더 과거 날짜를 대상으로 할 수도 있어(예: 장애 복구 후 밀린
// 날짜를 뒤늦게 채우는 경우) startedAt 순서와 targetDates 순서가 항상 같지는
// 않으므로, 최근 실행 여러 건을 모아 그 안에서 최대값을 구한다.
async function getMostRecentCoveredDateKey(): Promise<string | null> {
  const recentCompleted = await db
    .select({ targetDates: dailyScanRunsTable.targetDates })
    .from(dailyScanRunsTable)
    .where(eq(dailyScanRunsTable.status, "completed"))
    .orderBy(desc(dailyScanRunsTable.startedAt))
    .limit(30);
  let maxKey: string | null = null;
  for (const row of recentCompleted) {
    for (const key of row.targetDates) {
      if (!maxKey || key > maxKey) maxKey = key;
    }
  }
  return maxKey;
}

// 요구사항(납품 신뢰성): computeTargetDates()는 항상 "지금 기준 어제"만 바라보기
// 때문에, apis.data.go.kr 장애 등으로 특정 날짜의 스캔이 통째로 실패하면 그
// 날짜의 낙찰 데이터는 이후 어떤 실행에서도 다시 확인되지 않고 영구적으로
// 누락된다 — 이는 납품물의 정확성을 보장할 수 없는 구조적 결함이었다.
//
// 이를 막기 위해, 매 실행마다 "완료로 기록된 가장 최근 날짜" 이후부터 어제까지
// 빠짐없이 훑어 대상 날짜에 포함시킨다(정상적인 하루 1건 운영 시에는 결과가
// computeTargetDates()와 동일 — 즉, 기존 동작을 바꾸지 않으면서 장애 이후에는
// 자동으로 밀린 날짜를 채워 넣는다).
function computeRecheckDates(instant: Date): KstDate[] {
  const today = kstToday(instant);
  const dates: KstDate[] = [];
  for (let i = 1; i <= RECHECK_WINDOW_DAYS; i++) {
    dates.push(shiftKstDate(today, -i));
  }
  return dates;
}

// 완료 여부와 무관하게 항상 재확인할 최근 N일을 base 날짜 목록에 합친다(중복은
// key 기준으로 제거, 날짜순 정렬). explicitDateKey로 특정 날짜만 지정한
// 수동검색 경로(createPendingScanRun)는 이 함수를 거치지 않으므로 영향받지 않는다.
function withRecheckWindow(baseDates: KstDate[], instant: Date): KstDate[] {
  const merged = new Map<string, KstDate>();
  for (const date of [...baseDates, ...computeRecheckDates(instant)]) merged.set(date.key, date);
  return [...merged.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export async function computeTargetDatesWithGapFill(instant: Date = new Date()): Promise<KstDate[]> {
  const today = kstToday(instant);
  const yesterday = shiftKstDate(today, -1);
  const lastCoveredKey = await getMostRecentCoveredDateKey();

  if (!lastCoveredKey) {
    // 완료된 실행 기록이 아직 없다(최초 실행). 기존 로직 그대로.
    return withRecheckWindow(computeTargetDates(instant), instant);
  }

  const lastCovered = kstDateFromKey(lastCoveredKey);
  if (lastCovered.key >= yesterday.key) {
    // 이미 어제까지(혹은 수동 재실행 등으로 그 이후까지) 커버되어 있다 — 손실
    // 구간 없음. 기존 로직(월요일/공휴일 다음날 이중 확인 포함) 그대로 수행한다.
    return withRecheckWindow(computeTargetDates(instant), instant);
  }

  // lastCovered 다음날부터 어제까지 공백을 전부 채운다.
  const dates: KstDate[] = [];
  let cursor = shiftKstDate(lastCovered, 1);
  while (cursor.key <= yesterday.key && dates.length < MAX_GAP_FILL_DAYS) {
    dates.push(cursor);
    cursor = shiftKstDate(cursor, 1);
  }

  if (dates.length > 1) {
    logger.warn(
      { lastCoveredKey, dates: dates.map((d) => d.key) },
      "일별 스캔: 이전 공백(스캔 실패/미실행) 감지, 밀린 날짜를 함께 검색합니다.",
    );
  }
  if (cursor.key <= yesterday.key) {
    logger.warn(
      { lastCoveredKey, yesterday: yesterday.key, filledThrough: dates.at(-1)?.key, maxGapFillDays: MAX_GAP_FILL_DAYS },
      "일별 스캔: 공백이 너무 길어 이번 실행에서 다 채우지 못했습니다. 다음 실행에서 이어서 채웁니다.",
    );
  }

  return withRecheckWindow(dates, instant);
}

async function fetchAwardsForDate(date: KstDate, source: WorkSource): Promise<Record<string, unknown>[]> {
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key) throw new Error("DATA_GO_KR_SERVICE_KEY가 설정되지 않았습니다.");
  const items: Record<string, unknown>[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const query = [
      `serviceKey=${formatServiceKey(key)}`,
      `pageNo=${page}`,
      "numOfRows=999",
      "inqryDiv=2",
      `inqryBgnDt=${date.compact}0000`,
      `inqryEndDt=${date.compact}2359`,
      "type=json",
    ].join("&");
    const response = await requestBuffer(`${WORK_SOURCE_ENDPOINTS[source].awardUrl}?${query}`);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`낙찰 목록 조회 실패 (HTTP ${response.status}, ${source}, ${date.key})`);
    }
    const payload = JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
    const body = ((payload.response as Record<string, unknown>)?.body ?? {}) as Record<string, unknown>;
    items.push(...normalizeItems(payload));
    totalPages = Math.max(1, Math.ceil(Number(body.totalCount ?? 0) / 999));
    page += 1;
  } while (page <= totalPages);
  return items;
}

async function fetchNoticeDetail(
  bidNtceNo: string,
  bidNtceOrd: string,
  source: WorkSource,
): Promise<Record<string, unknown> | null> {
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key) throw new Error("DATA_GO_KR_SERVICE_KEY가 설정되지 않았습니다.");
  const query = [
    `serviceKey=${formatServiceKey(key)}`,
    "pageNo=1",
    "numOfRows=100",
    "inqryDiv=2",
    `bidNtceNo=${encodeURIComponent(bidNtceNo)}`,
    "type=json",
  ].join("&");
  const response = await requestBuffer(`${WORK_SOURCE_ENDPOINTS[source].detailUrl}?${query}`);
  if (response.status < 200 || response.status >= 300) return null;
  const payload = JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
  const items = normalizeItems(payload);
  const wanted = Number.parseInt(bidNtceOrd, 10);
  return items.find((item) => Number(item.bidNtceOrd) === wanted) ?? items[0] ?? null;
}

// 요구사항: "업무구분"(공종) 필터. 나라장터 상세 API의 주공종명/부공종명 필드는
// 실제로 비어있는 경우가 많아, 채워져 있으면 그것으로 판단하고 비어 있으면 공고명 등
// 텍스트에서 설정된 공종 키워드를 찾는 방식으로 대체한다(하이브리드). 이 필드들은
// 공사(Cnstwk) 공고에만 존재하므로 물품/용역 공고에는 적용하지 않는다(호출부 참고).
function classifyWorkType(
  detail: Record<string, unknown>,
  workTypeKeywords: string[],
): { matched: boolean; workTypeName: string | null } {
  if (workTypeKeywords.length === 0) return { matched: true, workTypeName: null };
  const subTypes = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map((index) => String(detail[`subsiCnsttyNm${index}`] ?? "").trim())
    .filter(Boolean);
  const mainType = String(detail.mainCnsttyNm ?? "").trim();
  const declaredTypes = [mainType, ...subTypes].filter(Boolean);
  if (declaredTypes.length > 0) {
    const hit = declaredTypes.find((type) => workTypeKeywords.some((keyword) => type.includes(keyword)));
    return hit ? { matched: true, workTypeName: hit } : { matched: false, workTypeName: declaredTypes.join(", ") };
  }
  const haystack = `${String(detail.bidNtceNm ?? "")} ${String(detail.mtltyAdvcPsblYnCnstwkNm ?? "")}`;
  const hit = workTypeKeywords.find((keyword) => haystack.includes(keyword));
  return { matched: Boolean(hit), workTypeName: hit ?? null };
}

const SITE_OFFICE_PATTERN =
  /(현장\s*사무소|현장\s*사무실|현장\s*대리인|공사\s*감독관)\s*[:：]?\s*([^\n\r|]{2,60})/;

function guessSiteOffice(text: string): string | null {
  const match = SITE_OFFICE_PATTERN.exec(text);
  return match ? match[2].trim() : null;
}

// 요구사항 7, 8: 정부 낙찰기록에 낙찰자 주소/전화가 비어있으면, 이미 다운로드해 둔
// 첨부파일 텍스트에서 먼저 찾아보고(무료), 그래도 없으면 네이버 지역검색 API로
// 최후 보완한다(NAVER_CLIENT_ID/SECRET 필요, 없으면 조용히 건너뜀). 어느 경로로
// 채웠는지는 contactSource로 남겨 화면/엑셀에서 신뢰도를 구분할 수 있게 한다.
async function resolveBidderContact(
  bidderName: string | null,
  addressFromAward: string | null,
  phoneFromAward: string | null,
  attachmentText: string,
): Promise<{ address: string | null; phone: string | null; contactSource: "government" | "attachment" | "portal" | null }> {
  let address = addressFromAward;
  let phone = phoneFromAward;
  let contactSource: "government" | "attachment" | "portal" | null = address || phone ? "government" : null;

  if (!bidderName) return { address, phone, contactSource };
  const needsAddress = !address;
  const needsPhone = !phone;
  if (!needsAddress && !needsPhone) return { address, phone, contactSource };

  const fromAttachment = extractBusinessContactFromText(attachmentText, bidderName);
  if (needsAddress && fromAttachment.address) {
    address = fromAttachment.address;
    contactSource = "attachment";
  }
  if (needsPhone && fromAttachment.phone) {
    phone = fromAttachment.phone;
    contactSource = "attachment";
  }

  if (address && phone) return { address, phone, contactSource };

  const fromPortal = await searchBusinessContactOnPortal(bidderName);
  if (fromPortal) {
    if (!address && fromPortal.address) {
      address = fromPortal.address;
      contactSource = "portal";
    }
    if (!phone && fromPortal.phone) {
      phone = fromPortal.phone;
      contactSource = "portal";
    }
  }

  return { address, phone, contactSource };
}

// 서버가 재시작/재배포되면 그 순간 진행 중이던 스캔은 메모리와 함께 그대로
// 사라지지만, DB에는 status="running" 행이 영원히 남아 화면에 "진행중"으로
// 표시된다. 새 프로세스가 뜬 시점에 "running"으로 남아있는 행은 전부 이전
// 프로세스가 죽으면서 고아가 된 것이므로(현재 프로세스는 아직 아무 스캔도
// 시작하지 않았다), 서버 시작 직후 한 번 실패 처리해 정리한다.
export async function recoverOrphanedScanRuns(): Promise<number> {
  const orphaned = await db
    .update(dailyScanRunsTable)
    .set({
      status: "failed",
      errorMessage: "서버 재시작으로 스캔이 중단되었습니다.",
      finishedAt: new Date(),
    })
    .where(eq(dailyScanRunsTable.status, "running"))
    .returning({ id: dailyScanRunsTable.id });
  if (orphaned.length > 0) {
    logger.warn({ count: orphaned.length, ids: orphaned.map((r) => r.id) }, "서버 시작: 중단된 이전 스캔 기록 정리");
  }
  return orphaned.length;
}

// 스캔 실행 기록만 즉시 만들어 반환한다 (수동 트리거 API가 바로 202로 응답할 수
// 있도록). 실제 스캔은 executeScanRun에서 진행되며 몇 분씩 걸릴 수 있다.
export async function createPendingScanRun(triggerType: "schedule" | "manual", explicitDateKey?: string): Promise<DailyScanRun> {
  const targetDates = explicitDateKey ? [kstDateFromKey(explicitDateKey)] : await computeTargetDatesWithGapFill(); // 요구사항: 특정 날짜 지정 시 갭필 없이 그 날짜만 검색, 생략 시 기존 자동 로직(전일 기준+미완료 구간 자동 보충) 사용
  const [run] = await db
    .insert(dailyScanRunsTable)
    .values({ targetDates: targetDates.map((d) => d.key), status: "running", triggerType })
    .returning();
  if (!run) throw new Error("스캔 작업을 생성하지 못했습니다.");
  return run;
}

export async function executeScanRun(run: DailyScanRun): Promise<DailyScanRun> {
  const settings = await getAppSettings();
  const targetDates = run.targetDates.map((key) => {
    const [year, month, day] = key.split("-").map(Number);
    return { key, compact: key.replaceAll("-", ""), year, month, day, weekday: 0 } as KstDate;
  });
  const workSources = resolveWorkSources(settings.workCategories);

  let awardsFound = 0;
  let candidatesChecked = 0;
  let matchesFound = 0;

  // 원인 진단용 임시 카운터: candidatesChecked는 늘어나는데 matchesFound는
  // 0건인 이유가 "필터에 다 걸러져서 첨부파일 검색까지 가지도 못하는 것"인지,
  // "첨부파일 검색까지는 가는데 키워드가 없는 것"인지 한눈에 보기 위함.
  const funnel = {
    noDetail: 0,
    skippedBudget: 0,
    skippedEstimatedPrice: 0,
    skippedWorkType: 0,
    noAttachmentUrl: 0,
    reachedAttachmentSearch: 0,
  };

  // 같은 낙찰자가 여러 건 매칭되면(같은 공고의 여러 첨부파일, 또는 여러 공고를
  // 함께 낙찰) 네이버 API를 그때마다 새로 호출하지 않도록 낙찰자 이름 기준으로
  // 이번 스캔 실행 동안만 결과를 캐시한다 (무료 API 호출 한도 보호).
  const contactCache = new Map<
    string,
    ReturnType<typeof resolveBidderContact> extends Promise<infer T> ? T : never
  >();
  async function resolveBidderContactCached(
    bidderName: string | null,
    addressFromAward: string | null,
    phoneFromAward: string | null,
    attachmentText: string,
  ) {
    const cacheKey = `${bidderName ?? ""}|${addressFromAward ?? ""}|${phoneFromAward ?? ""}`;
    const cached = contactCache.get(cacheKey);
    if (cached) return cached;
    const resolved = await resolveBidderContact(bidderName, addressFromAward, phoneFromAward, attachmentText);
    contactCache.set(cacheKey, resolved);
    return resolved;
  }

  try {
    for (const source of workSources) {
      const awardItems: Record<string, unknown>[] = [];
      for (const date of targetDates) {
        try {
          awardItems.push(...(await fetchAwardsForDate(date, source)));
        } catch (error) {
          // 업무구분 하나가 실패해도 나머지(예: 공사)는 계속 진행한다.
          logger.warn({ err: error, source, date: date.key }, "일별 스캔: 낙찰 목록 조회 실패");
        }
      }
      // 요구사항: 최종 낙찰자가 확정된 공고만.
      const confirmedAwards = awardItems.filter((item) => String(item.bidwinnrNm ?? "").trim().length > 0);
      awardsFound += confirmedAwards.length;

      // 예산(공사 규모) 사전 필터: 상세 조회는 비용이 크므로, 낙찰금액(통상 예산의
      // 80~90%)으로 먼저 걸러낸다. 정확한 기준(bdgtAmt)은 상세 조회 후 다시 확인한다.
      const cheapCandidates = confirmedAwards.filter((item) => {
        const bidAmount = Number(item.sucsfbidAmt ?? 0);
        if (!bidAmount) return true;
        return bidAmount >= settings.minBudgetAmount * 0.5;
      });

      for (const award of cheapCandidates) {
        const bidNtceNo = String(award.bidNtceNo ?? "").trim();
        const bidNtceOrd = String(award.bidNtceOrd ?? "").trim();
        if (!bidNtceNo || !bidNtceOrd) continue;
        const noticeNumber = `${bidNtceNo}-${bidNtceOrd.padStart(3, "0")}`;
        candidatesChecked += 1;

        let detail: Record<string, unknown> | null = null;
        try {
          const lookup = await withRetry(() => fetchNoticeDetail(bidNtceNo, bidNtceOrd, source), 2);
          detail = lookup.value;
        } catch (error) {
          logger.warn({ err: error, noticeNumber, source }, "일별 스캔: 공고 상세 조회 실패");
          continue;
        }
        if (!detail) {
          funnel.noDetail += 1;
          continue;
        }

        // 요구사항 3: 공사 규모 필터 (최종 확인).
        const budgetAmount = Number(detail.bdgtAmt ?? 0) || Number(award.sucsfbidAmt ?? 0);
        if (budgetAmount < settings.minBudgetAmount) {
          funnel.skippedBudget += 1;
          continue;
        }

        // 요구사항 2: 추정가격(presmptPrce) 범위 필터. 값이 있을 때만 적용한다 —
        // 일부 공고는 추정가격을 공개하지 않아 0/누락으로 오는 경우가 있는데, 그런
        // 공고까지 걸러내면 위의 예산 기준 필터와 상충해 리드를 놓치게 된다.
        const estimatedAmount = Number(detail.presmptPrce ?? 0) || null;
        if (estimatedAmount != null) {
          if (settings.minEstimatedPrice != null && estimatedAmount < settings.minEstimatedPrice) {
            funnel.skippedEstimatedPrice += 1;
            continue;
          }
          if (settings.maxEstimatedPrice != null && estimatedAmount > settings.maxEstimatedPrice) {
            funnel.skippedEstimatedPrice += 1;
            continue;
          }
        }

        // 원인 진단용 임시 로그: "추정가격 미공개라서 예산(낙찰금액) 기준으로만
        // 통과한 건"과 "추정가격이 실제로 존재하는 건"을 구분하기 위해 원본 금액
        // 필드를 그대로 남긴다. (사용자가 나라장터 원본 사이트의 "추정가격≥N"
        // 필터 결과와 우리 시스템의 후보 수가 다르다고 지적한 것을 검증하기 위함)
        logger.info(
          {
            noticeNumber,
            bidNtceNm: detail.bidNtceNm,
            bdgtAmt: detail.bdgtAmt,
            sucsfbidAmt: award.sucsfbidAmt,
            presmptPrce: detail.presmptPrce,
            budgetAmount,
            estimatedAmount,
          },
          "일별 스캔[진단]: 금액 필드 원본값",
        );

        // 요구사항 1: 업무구분(공종) 필터 — 공사 카테고리에만 의미가 있다(주공종명/
        // 부공종명은 Cnstwk 응답에만 존재).
        const { matched: workTypeMatched, workTypeName } =
          source === "공사" ? classifyWorkType(detail, settings.workTypeKeywords) : { matched: true, workTypeName: null };
        if (!workTypeMatched) {
          funnel.skippedWorkType += 1;
          continue;
        }

        // 요구사항 4, 5: 공사 내역/요청서 첨부파일에서 키워드(=우리가 설정한 품목) 검색.
        const attachments = collectAttachments(detail).sort(
          (a, b) => Number(isPriorityAttachment(b.name)) - Number(isPriorityAttachment(a.name)),
        );
        if (attachments.length === 0) {
          // 원인 진단용 임시 로그: 매칭이 0건인 이유가 "첨부파일 자체가 없어서"인지
          // 아니면 다른 단계(다운로드/텍스트 추출)에서 실패하는지 구분하기 위함.
          funnel.noAttachmentUrl += 1;
          logger.warn(
            { noticeNumber, source, bidNtceNm: detail.bidNtceNm },
            "일별 스캔[진단]: 공고 상세에 첨부파일 URL이 없음",
          );
          continue;
        }
        funnel.reachedAttachmentSearch += 1;

        const scratchDir = await mkdtemp(path.join(tmpdir(), "daily-scan-"));
        try {
          for (const attachment of attachments) {
            let downloadedPath: string;
            try {
              // 요구사항(첨부파일 보관, 2026-09-09): 일시적 네트워크 오류로 매칭
              // 자체를 놓치는 일("누락")을 줄이기 위해 재시도 횟수를 2→3으로 상향.
              const download = await withRetry(
                () => downloadAttachment(attachment.url, scratchDir, attachment.name),
                3,
              );
              downloadedPath = download.value;
            } catch (error) {
              logger.warn({ err: error, noticeNumber, fileName: attachment.name }, "일별 스캔: 첨부파일 다운로드 실패");
              continue;
            }

            let searchRoots = [downloadedPath];
            if (path.extname(downloadedPath).toLowerCase() === ".zip") {
              try {
                searchRoots = await extractZipRecursively(downloadedPath);
              } catch (error) {
                logger.warn({ err: error, noticeNumber, fileName: attachment.name }, "일별 스캔: ZIP 압축 해제 실패");
                continue;
              }
            }

            for (const searchablePath of searchRoots) {
              if (path.extname(searchablePath).toLowerCase() === ".zip") continue;
              if ((await stat(searchablePath)).isDirectory()) continue;
              let segments;
              try {
                segments = await extractSegments(searchablePath);
              } catch (error) {
                // 원인 진단용 임시 로그: 예전에는 여기서 에러를 완전히 삼켜서
                // (아무 로그도 없이 continue) 텍스트 추출 자체가 매번 실패해도
                // 알 방법이 없었다. 확장자와 에러 메시지를 남긴다.
                logger.warn(
                  { err: error, noticeNumber, fileName: path.basename(searchablePath), ext: path.extname(searchablePath) },
                  "일별 스캔[진단]: 첨부파일 텍스트 추출 실패",
                );
                continue;
              }
              // 요구사항 4: 설정된 키워드(=선택한 품목, 기본 "부직포")가 있는 공고만.
              const matches = searchSegments(segments, settings.matchKeywords);
              logger.info(
                {
                  noticeNumber,
                  fileName: path.basename(searchablePath),
                  ext: path.extname(searchablePath),
                  segmentCount: segments.length,
                  matchCount: matches.length,
                },
                "일별 스캔[진단]: 첨부파일 텍스트 추출 결과",
              );
              if (matches.length === 0) continue;

              // 요구사항 6: 매칭된 첨부파일을 영구 저장(볼륨)한다.
              const matchedFileName = sanitizeName(attachment.name);
              const storedDir = path.join(SCAN_ROOT, noticeNumber);
              await mkdir(storedDir, { recursive: true });
              const storedPath = path.join(storedDir, path.basename(searchablePath));
              await copyFile(searchablePath, storedPath).catch(() => {});

              for (const match of matches) {
                const matchedKeyword = match.foundKeywords[0] ?? settings.matchKeywords[0] ?? "";
                const itemFields = extractItemFields(match.originalText, settings.matchKeywords);
                const quantityText =
                  [itemFields.itemQuantity, itemFields.itemUnit]
                    .filter((value) => value && value !== "미공개/확인불가")
                    .join(" ") || null;
                // 요구사항 6: 현장명 / 현장사무소 / 수량.
                const siteOffice =
                  guessSiteOffice(match.surroundingText) ??
                  guessSiteOffice(match.originalText) ??
                  (detail.dminsttNm ? `${String(detail.dminsttNm)} (발주기관 문의)` : null);

                // 요구사항 7, 8: 낙찰자 연락처/주소 — 정부 기록에 없으면 첨부파일,
                // 그래도 없으면 네이버 API로 보완.
                const { address: bidderAddress, phone: bidderPhone, contactSource } = await resolveBidderContactCached(
                  String(award.bidwinnrNm ?? "").trim() || null,
                  String(award.bidwinnrAdrs ?? "").trim() || null,
                  String(award.bidwinnrTelNo ?? "").trim() || null,
                  `${match.surroundingText}\n${match.originalText}`,
                );

                try {
                  const inserted = await db
                    .insert(awardedMatchesTable)
                    .values({
                      scanRunId: run.id,
                      noticeNumber,
                      noticeName: String(detail.bidNtceNm ?? "").trim() || null,
                      siteName: String(detail.bidNtceNm ?? "").trim() || null,
                      siteOffice,
                      workTypeName,
                      workCategory: source,
                      demandAgency: String(detail.dminsttNm ?? award.dminsttNm ?? "").trim() || null,
                      bidderName: String(award.bidwinnrNm ?? "").trim() || null,
                      bidderBizno: String(award.bidwinnrBizno ?? "").trim() || null,
                      bidderAddress,
                      bidderPhone,
                      contactSource,
                      budgetAmount: budgetAmount || null,
                      estimatedAmount,
                      awardAmount: Number(award.sucsfbidAmt ?? 0) || null,
                      awardDate: String(award.fnlSucsfDate ?? award.rlOpengDt ?? "").trim() || null,
                      matchedKeyword,
                      quantityText,
                      surroundingText: match.surroundingText,
                      attachmentFileName: matchedFileName,
                      attachmentStoredPath: path.relative(SCAN_ROOT, storedPath),
                    })
                    .onConflictDoNothing()
                    .returning({ id: awardedMatchesTable.id });
                  if (inserted.length > 0) matchesFound += 1;
                } catch (error) {
                  logger.warn({ err: error, noticeNumber }, "일별 스캔: 매칭 결과 저장 실패");
                }
              }
            }
          }
        } finally {
          await rm(scratchDir, { recursive: true, force: true });
        }
      }
    }

    // 원인 진단용 임시 로그: 위 funnel 카운터를 한 줄로 모아서, "왜 매칭이
    // 0건인지"를 각 단계별로 몇 건이 걸러졌는지 한눈에 볼 수 있게 한다.
    logger.warn(
      { runId: run.id, candidatesChecked, ...funnel, matchesFound },
      "일별 스캔[진단]: 후보 필터링 단계별 요약",
    );

    const [completed] = await db
      .update(dailyScanRunsTable)
      .set({ status: "completed", awardsFound, candidatesChecked, matchesFound, finishedAt: new Date() })
      .where(eq(dailyScanRunsTable.id, run.id))
      .returning();
    return completed ?? run;
  } catch (error) {
    const message = describeError(error);
    logger.error({ err: error, runId: run.id }, "일별 스캔 실패");
    const [failed] = await db
      .update(dailyScanRunsTable)
      .set({
        status: "failed",
        awardsFound,
        candidatesChecked,
        matchesFound,
        errorMessage: message,
        finishedAt: new Date(),
      })
      .where(eq(dailyScanRunsTable.id, run.id))
      .returning();
    return failed ?? run;
  }
}

// Convenience wrapper for callers that want to await the whole thing (the
// cron scheduler). The manual-trigger HTTP endpoint instead calls
// createPendingScanRun + executeScanRun separately so it can respond 202
// immediately while the scan keeps running in the background.
export async function runDailyScan(triggerType: "schedule" | "manual" = "schedule"): Promise<DailyScanRun> {
  const run = await createPendingScanRun(triggerType);
  return executeScanRun(run);
}
