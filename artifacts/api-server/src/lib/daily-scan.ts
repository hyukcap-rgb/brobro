import { tmpdir } from "node:os";
import path from "node:path";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { desc, eq, inArray, notInArray } from "drizzle-orm";
import { db, dailyScanRunsTable, awardedMatchesTable, noticeDetailCacheTable, type DailyScanRun } from "@workspace/db";
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
  searchBusinessContactOnWeb,
  lookupGovCorpInfo,
} from "./bid-processing";
import { getAppSettings } from "./settings";
import { kstToday, shiftKstDate, isKoreanHoliday, type KstDate } from "./kr-holidays";
import { SCAN_ROOT } from "./scan-storage";
import { logger } from "./logger";

// 하루 API 장애 등으로 여러 날이 한꺼번에 누락된 경우, 한 번의 실행에서 최대
// 이만큼만 소급 채운다(끝없이 과거로 폭주하는 것을 막는 안전장치). 이보다 긴
// 공백은 매일 조금씩 나눠서 채워지고, 로그에 경고를 남긴다.
const MAX_GAP_FILL_DAYS = 14;

// 요구사항(2026-09-11 사용자 지적: "이런식으로 하면 손해배상청구 소송"): 매일
// 07시 자동 스캔과 관리자의 수동 "지금 실행"이 같은 순간 겹치거나, 버튼을 두 번
// 눌러 동시에 두 개의 스캔이 돌면 data.go.kr·네이버 API 호출량이 그대로 두
// 배로 나가 어제 같은 한도 초과가 다시 발생할 수 있다. daily_scan_runs에 걸어둔
// 부분 유니크 인덱스(status='running'인 행은 항상 최대 1개)가 DB 차원에서 동시
// 실행을 막아주며, 이 인덱스 위반(23505)을 이 에러로 변환해 호출부가 "진짜
// 오류"와 "이미 실행 중이라 거절됨"을 구분할 수 있게 한다.
export class ScanAlreadyRunningError extends Error {
  constructor(message = "이미 다른 스캔이 진행 중입니다.") {
    super(message);
    this.name = "ScanAlreadyRunningError";
  }
}

// 실사용 검증(2026-09-11): 동시 실행 두 건을 실제로 겹쳐 보내 확인한 결과, DB
// 유니크 인덱스 위반은 발생했지만 이 함수가 이를 감지하지 못해 500(진짜 오류)로
// 새어나갔다 — drizzle-orm(node-postgres)가 실제 pg 오류를 최상위 error.code가
// 아니라 DrizzleQueryError의 error.cause.code에 담아 던지기 때문이다. 둘 다
// 확인해야 한다.
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "23505") return true;
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  return cause?.code === "23505";
}

// 요구사항(2026-09-10 사용자 리포트: "부직포 매칭이 하나도 안됨 — 아까는 많았는데"):
// 원인을 로그로 추적해보니 실제로는 버그가 아니라 data.go.kr(공공데이터포털)의
// "일일 서비스 요청제한 횟수 초과"(LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR,
// HTTP 429) 였다 — 공고 상세 조회가 전부 이 오류로 실패해 첨부파일 검색 자체를
// 시작하지 못했다. 이 상태를 일반적인 "공고 상세 없음"과 구분해서 화면(오류 컬럼)에
// 명확히 알려주기 위한 전용 에러 타입과 감지 함수.
class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

function extractOpenApiErrorMessage(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const envelope = parsed.OpenAPI_ServiceResponse as Record<string, unknown> | undefined;
    const header = envelope?.cmmMsgHeader as Record<string, unknown> | undefined;
    if (header?.errMsg) return String(header.errMsg);
  } catch {
    // 아래 XML 폴백으로 계속 진행.
  }
  const xmlMatch = /<errMsg>([^<]+)<\/errMsg>/i.exec(bodyText);
  return xmlMatch ? xmlMatch[1] : null;
}

// 요구사항(재확인, 2026-09-08 사용자 확인): 나라장터의 "최종낙찰자" 데이터는
// 개찰일이 지나도 몇 시간~며칠에 걸쳐 점진적으로 확정되어, 이미 "완료"로 기록된
// 날짜라도 다시 스캔하면 새로 확정된 낙찰건이 추가로 나타날 수 있다. 기존
// 갭필 로직은 "완료"로 기록된 날짜는 다시 보지 않으므로, 이런 뒤늦은 확정
// 건들은 영구적으로 누락될 수 있었다 — 이를 막기 위해 매 실행마다 최근
// N일(어제/그저께/그끄제)을 완료 여부와 무관하게 항상 다시 훑는다.
// awardedMatchesTable insert는 onConflictDoNothing()이라 중복 저장 걱정 없이
// 안전하게 재확인할 수 있다.
const RECHECK_WINDOW_DAYS = 3;

// 요구사항(2026-09-11 사용자 요청: "기간 지정하는 기간 또한 낙찰일을 기준으로
// 검색하라는 뜻이야" / "낙찰자가 확정된 건만 검색해야 헷갈리지 않는데"): 나라장터
// 낙찰정보 API는 개찰일시 기준으로만 조회할 수 있고 낙찰일(최종낙찰자 확정일)
// 기준 조회를 지원하지 않는다. "이 기간으로 검색"이 낙찰일 기준으로 동작하려면,
// 지정한 시작일보다 이만큼 더 이전 날짜까지 개찰일 기준으로 넓게 훑은 뒤, 그중
// 실제 낙찰일(확정일)이 지정 기간 안에 드는 건만 남겨야 한다(바로 위 주석처럼
// 확정이 개찰 후 며칠씩 늦어지는 사례가 흔해 안전 마진을 둔다). 아직 확정일
// 자체가 없는 건(화면에 개찰일로 대체 표시되던 것)은 사용자 확인에 따라 "낙찰일
// 기준" 결과에서 완전히 제외한다.
const MANUAL_RANGE_AWARD_DATE_LOOKBACK_DAYS = 14;

// 나라장터 날짜 필드는 "YYYY-MM-DD" 또는 "YYYY-MM-DD HH:MI:SS" 형태로 온다.
// 앞 10자리만 취해 날짜 키로 비교한다(문자열 사전식 비교 = 날짜순 비교가 그대로
// 성립하는 "YYYY-MM-DD" 형식이므로).
function extractDateKey(raw: unknown): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const key = trimmed.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}

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
  if (response.status < 200 || response.status >= 300) {
    const bodyText = response.body.toString("utf8");
    // 원인 진단용 임시 로그(2026-09-10): "상세 조회가 전부 0건" 문제의 원인을
    // 밝히기 위해, HTTP 오류인 경우 상태코드와 응답 본문 일부를 남긴다.
    logger.warn(
      { bidNtceNo, source, status: response.status, bodyHead: bodyText.slice(0, 300) },
      "일별 스캔[진단]: 공고 상세 조회 HTTP 오류",
    );
    const apiErrMsg = extractOpenApiErrorMessage(bodyText);
    if (apiErrMsg === "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR") {
      throw new QuotaExceededError("공공데이터포털 일일 호출 한도를 초과했습니다.");
    }
    return null;
  }
  const bodyText = response.body.toString("utf8");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(bodyText) as Record<string, unknown>;
  } catch (error) {
    // 원인 진단용 임시 로그(2026-09-10): data.go.kr가 트래픽 초과 등으로 JSON이
    // 아닌 XML/HTML 오류 응답을 HTTP 200으로 내려주는 경우가 있어, 파싱 실패
    // 시에도 원인을 알 수 있도록 본문 일부를 남긴다.
    logger.warn(
      { bidNtceNo, source, bodyHead: bodyText.slice(0, 300) },
      "일별 스캔[진단]: 공고 상세 조회 응답이 JSON이 아님",
    );
    throw error;
  }
  const items = normalizeItems(payload);
  if (items.length === 0) {
    // 원인 진단용 임시 로그(2026-09-10 사용자 리포트: "부직포 매칭이 하나도 안됨"):
    // 상세 API가 HTTP 200 + 빈 items로 응답하는 경우(트래픽 초과 등 API 자체
    // 오류를 본문에 담아 200으로 내려주는 케이스 포함)를 구분하기 위해 응답의
    // header(resultCode/resultMsg 등)와 본문 일부를 남긴다.
    const responseRoot = (payload.response ?? payload) as Record<string, unknown>;
    logger.warn(
      {
        bidNtceNo,
        source,
        header: responseRoot.header ?? null,
        bodyHead: bodyText.slice(0, 300),
      },
      "일별 스캔[진단]: 공고 상세 조회 결과가 0건",
    );
  }
  const wanted = Number.parseInt(bidNtceOrd, 10);
  return items.find((item) => Number(item.bidNtceOrd) === wanted) ?? items[0] ?? null;
}

// 요구사항(2026-09-11 사용자 제안: "전일 공사 항목의 첨부파일을 서버에 저장하고
// 서버에 저장한 파일을 키워드 검색하면 어떨까"): 공고 상세정보(첨부파일 URL,
// 예산, 업무구분 등)는 한 번 등록되면 이후로 바뀌지 않는다 — 매일 다시 확인해야
// 하는 것은 "최종낙찰자 확정 여부"뿐이고, 그건 상세 API가 아니라 낙찰 목록
// API(fetchAwardsForDate)로 확인한다. 그런데도 RECHECK_WINDOW_DAYS(최근 3일
// 재확인) 로직 때문에 같은 공고의 상세정보를 매일, 그리고 수동 재실행 때마다
// data.go.kr 상세 API로 매번 다시 조회하고 있었다 — 이것이 "일일 서비스
// 요청제한 횟수 초과" 오류의 실질적 원인이었다. 한 번 성공한 상세정보를 DB에
// 캐시해두고 같은 공고를 다시 만나면 캐시를 그대로 재사용해 API 호출 자체를
// 없앤다.
async function getCachedNoticeDetail(noticeNumber: string): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ detailJson: noticeDetailCacheTable.detailJson })
    .from(noticeDetailCacheTable)
    .where(eq(noticeDetailCacheTable.noticeNumber, noticeNumber))
    .limit(1);
  return row?.detailJson ?? null;
}

async function cacheNoticeDetail(
  noticeNumber: string,
  source: WorkSource,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await db
      .insert(noticeDetailCacheTable)
      .values({ noticeNumber, source, detailJson: detail })
      .onConflictDoNothing();
  } catch (error) {
    // 캐시 저장 실패는 이번 실행의 매칭 결과에 영향을 주면 안 되므로(다음 번에
    // 다시 API로 조회하면 그만이다) 경고만 남기고 계속 진행한다.
    logger.warn({ err: error, noticeNumber }, "일별 스캔: 공고 상세 캐시 저장 실패");
  }
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

// 요구사항(전화번호 검색, 2026-09-09 사용자 리포트: "전화번호를 검색해서
// 보여줘"): 나라장터 낙찰정보 API는 낙찰자 전화번호를 개인정보 보호를 위해
// "***********" 같은 별표로 마스킹해서 내려주는 경우가 많다. 예전 코드는 이
// 마스킹된 값도 "값이 있다"고 보고 첨부파일/네이버 검색을 건너뛰어서, 화면에
// 아무 쓸모 없는 별표만 뜨고 실제 번호는 찾지 않는 문제가 있었다. 별표가 섞인
// 값은 "아직 못 찾은 것"으로 취급해 첨부파일 → 네이버 지역검색으로 계속
// 진짜 번호를 찾도록 고친다.
function isUsablePhone(phone: string | null | undefined): boolean {
  return Boolean(phone && !phone.includes("*"));
}

// 요구사항 7, 8: 정부 낙찰기록에 낙찰자 주소/전화가 비어있거나(위 마스킹 포함)
// 쓸 수 없으면, 이미 다운로드해 둔 첨부파일 텍스트에서 먼저 찾아보고(무료),
// 그래도 없으면 네이버 지역검색 API로 최후 보완한다(NAVER_CLIENT_ID/SECRET
// 필요, 없으면 조용히 건너뜀). 어느 경로로 채웠는지는 contactSource로 남겨
// 화면/엑셀에서 신뢰도를 구분할 수 있게 한다.
async function resolveBidderContact(
  bidderName: string | null,
  addressFromAward: string | null,
  phoneFromAward: string | null,
  attachmentText: string,
  bizno: string | null,
): Promise<{
  address: string | null;
  phone: string | null;
  contactSource: "government" | "attachment" | "registry" | "portal" | "web" | null;
}> {
  let address = addressFromAward;
  let phone = isUsablePhone(phoneFromAward) ? phoneFromAward : null;
  let contactSource: "government" | "attachment" | "registry" | "portal" | "web" | null = address || phone ? "government" : null;

  if (!bidderName) return { address, phone, contactSource };
  const needsAddress = !address;
  const needsPhone = !phone;
  if (!needsAddress && !needsPhone) return { address, phone, contactSource };

  const fromAttachment = extractBusinessContactFromText(attachmentText, bidderName);
  if (needsAddress && fromAttachment.address) {
    address = fromAttachment.address;
    contactSource = "attachment";
  }
  if (needsPhone && isUsablePhone(fromAttachment.phone)) {
    phone = fromAttachment.phone ?? null;
    contactSource = "attachment";
  }

  if (address && phone) return { address, phone, contactSource };

  // 요구사항(2026-09-11 사용자 요청: 조달청 "나라장터 사용자정보 서비스"
  // (조달업체 기본정보 조회) 공공데이터를 낙찰자 연락처 보강에 써달라고
  // 요청 → "기존 낙찰자 정보를 이 API로 보강" 선택): 사업자등록번호를 알고
  // 있으면 조달청에 정식 등록된 주소/전화를 정확 매칭으로 조회한다. 회사명
  // 텍스트 검색인 Naver보다 신뢰도가 높으므로 그보다 먼저 시도한다.
  if (bizno) {
    const fromRegistry = await lookupGovCorpInfo(bizno);
    if (fromRegistry) {
      if (!address && fromRegistry.address) {
        address = fromRegistry.address;
        contactSource = "registry";
      }
      if (!phone && isUsablePhone(fromRegistry.phone)) {
        phone = fromRegistry.phone ?? null;
        contactSource = "registry";
      }
    }
    if (address && phone) return { address, phone, contactSource };
  }

  // 요구사항(전화번호 정확도 보완, 2026-09-09 사용자 리포트: "회사이름과
  // 주소를 교차검증하면 전화번호를 정확히 찾을 수 있을 것 같아"): 이미 알고
  // 있는 주소(이 시점의 address)가 있으면 지역명을 검색어에 더하고, 결과
  // 주소가 그 지역과 일치하는지 교차검증해 동명의 다른 업체를 걸러낸다.
  const fromPortal = await searchBusinessContactOnPortal(bidderName, address);
  if (fromPortal) {
    if (!address && fromPortal.address) {
      address = fromPortal.address;
      contactSource = "portal";
    }
    if (!phone && isUsablePhone(fromPortal.phone)) {
      phone = fromPortal.phone ?? null;
      contactSource = "portal";
    }
  }

  // 요구사항(전화번호 검색 보완, 2026-09-09): 네이버 지역검색은 "스마트플레이스"
  // 등록 업체만 색인해서 협동조합·비영리단체 등은 못 찾는 경우가 있다(명문사회적
  // 협동조합 사례). 그래도 전화번호가 여전히 없으면 더 넓게 색인된 네이버
  // 웹문서/블로그 검색으로 최후 보완한다. 텍스트 검색결과에서 정규식으로 뽑아내는
  // 값이라 정확도는 낮으므로 contactSource를 "web"으로 따로 남긴다.
  if (!phone) {
    const fromWeb = await searchBusinessContactOnWeb(bidderName, address);
    if (fromWeb && isUsablePhone(fromWeb.phone)) {
      phone = fromWeb.phone ?? null;
      contactSource = "web";
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

// 요구사항(기간 검색, 2026-09-09 사용자 요청): 시작일~종료일(포함) 구간의 모든
// 날짜를 대상으로 만든다. 사용자가 "검색 기간을 내가 설정하는거야"라고 명시적
// 요청 — 기존에는 시작 날짜 하나만 받아 그 하루만 검색했다.
function buildDateRange(startKey: string, endKey: string): KstDate[] {
  const dates: KstDate[] = [];
  let cursor = kstDateFromKey(startKey);
  const end = kstDateFromKey(endKey);
  while (cursor.key <= end.key) {
    dates.push(cursor);
    cursor = shiftKstDate(cursor, 1);
  }
  return dates;
}

// 요구사항(2026-09-10 사용자 요청: "검색 list 가 오래 쌓이면 아래로 너무
// 내려감. 검색을 언제 했는지는 중요하지 않으니 결과 history는 없어도 됨.
// 최근 7개만 보여주고 나머지는 다 자동삭제해줘"): 자동검색 실행 기록은 "언제
// 검색했는지"만 남기는 로그라 오래될수록 볼 필요가 없다. 매 실행마다 최근
// MAX_SCAN_RUN_HISTORY건만 남기고 더 오래된 기록은 지운다. 단, 그 기록에
// 연결된 매칭 결과(누적 영업 리드)는 별개의 누적 데이터이므로 지우지 않고
// scanRunId 연결만 끊는다.
const MAX_SCAN_RUN_HISTORY = 7;

async function pruneOldScanRuns(): Promise<void> {
  const recent = await db
    .select({ id: dailyScanRunsTable.id })
    .from(dailyScanRunsTable)
    .orderBy(desc(dailyScanRunsTable.startedAt))
    .limit(MAX_SCAN_RUN_HISTORY);
  const keepIds = recent.map((row) => row.id);
  if (keepIds.length === 0) return;
  const stale = await db
    .select({ id: dailyScanRunsTable.id })
    .from(dailyScanRunsTable)
    .where(notInArray(dailyScanRunsTable.id, keepIds));
  const staleIds = stale.map((row) => row.id);
  if (staleIds.length === 0) return;
  await db
    .update(awardedMatchesTable)
    .set({ scanRunId: null })
    .where(inArray(awardedMatchesTable.scanRunId, staleIds));
  await db.delete(dailyScanRunsTable).where(inArray(dailyScanRunsTable.id, staleIds));
}

// 스캔 실행 기록만 즉시 만들어 반환한다 (수동 트리거 API가 바로 202로 응답할 수
// 있도록). 실제 스캔은 executeScanRun에서 진행되며 몇 분씩 걸릴 수 있다.
export async function createPendingScanRun(
  triggerType: "schedule" | "manual",
  explicitDateRange?: { start: string; end: string },
): Promise<DailyScanRun> {
  const targetDates = explicitDateRange
    ? buildDateRange(explicitDateRange.start, explicitDateRange.end)
    : await computeTargetDatesWithGapFill(); // 요구사항: 기간 지정 시 갭필 없이 그 구간만 검색, 생략 시 기존 자동 로직(전일 기준+미완료 구간 자동 보충) 사용
  let run: DailyScanRun | undefined;
  try {
    [run] = await db
      .insert(dailyScanRunsTable)
      .values({ targetDates: targetDates.map((d) => d.key), status: "running", triggerType })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ScanAlreadyRunningError();
    }
    throw error;
  }
  if (!run) throw new Error("스캔 작업을 생성하지 못했습니다.");
  await pruneOldScanRuns().catch((error) => {
    logger.warn({ err: error }, "Failed to prune old scan run history");
  });
  return run;
}

export async function executeScanRun(
  run: DailyScanRun,
  options?: { awardDateRange?: { start: string; end: string } },
): Promise<DailyScanRun> {
  const settings = await getAppSettings();
  const targetDates = run.targetDates.map((key) => {
    const [year, month, day] = key.split("-").map(Number);
    return { key, compact: key.replaceAll("-", ""), year, month, day, weekday: 0 } as KstDate;
  });
  // 요구사항(2026-09-11, 낙찰일 기준 검색): 지정 기간 시작일보다 더 이전까지
  // 개찰일 기준으로 넓게 조회할 대상 날짜. run.targetDates(=화면 "대상일"에 표시될
  // 사용자가 지정한 기간)는 그대로 두고, 실제 나라장터 조회 범위만 넓힌다.
  const awardDateRange = options?.awardDateRange;
  const fetchDates = awardDateRange
    ? buildDateRange(
        shiftKstDate(kstDateFromKey(awardDateRange.start), -MANUAL_RANGE_AWARD_DATE_LOOKBACK_DAYS).key,
        awardDateRange.end,
      )
    : targetDates;
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
    // 요구사항(2026-09-10 사용자 리포트: "부직포 매칭이 하나도 안됨"): data.go.kr
    // 일일 호출 한도 초과로 상세 조회 자체가 실패한 건수를 별도로 센다.
    quotaExceeded: 0,
    // 요구사항(2026-09-11 사용자 제안: "첨부파일을 서버에 저장하고 검색하면
    // 어떨까"): API를 다시 부르지 않고 캐시로 해결한 건수 — 이 수가 클수록
    // 오늘 절약한 API 호출 수라고 보면 된다.
    detailFromCache: 0,
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
    bizno: string | null,
  ) {
    const cacheKey = `${bidderName ?? ""}|${addressFromAward ?? ""}|${phoneFromAward ?? ""}|${bizno ?? ""}`;
    const cached = contactCache.get(cacheKey);
    if (cached) return cached;
    const resolved = await resolveBidderContact(bidderName, addressFromAward, phoneFromAward, attachmentText, bizno);
    contactCache.set(cacheKey, resolved);
    return resolved;
  }

  try {
    for (const source of workSources) {
      const awardItems: Record<string, unknown>[] = [];
      for (const date of fetchDates) {
        try {
          awardItems.push(...(await fetchAwardsForDate(date, source)));
        } catch (error) {
          // 업무구분 하나가 실패해도 나머지(예: 공사)는 계속 진행한다.
          logger.warn({ err: error, source, date: date.key }, "일별 스캔: 낙찰 목록 조회 실패");
        }
      }
      // 요구사항: 최종 낙찰자가 확정된 공고만.
      let confirmedAwards = awardItems.filter((item) => String(item.bidwinnrNm ?? "").trim().length > 0);
      if (awardDateRange) {
        // 요구사항(2026-09-11, 낙찰일 기준 검색): 위에서 넓게 가져온 후보 중
        // 실제 낙찰일(fnlSucsfDate, 개찰일로의 대체 없이)이 지정 기간 안에 드는
        // 것만 남긴다. 확정일 자체가 없는 건은 "낙찰일 기준" 결과에서 제외한다.
        confirmedAwards = confirmedAwards.filter((item) => {
          const awardDateKey = extractDateKey(item.fnlSucsfDate);
          return awardDateKey != null && awardDateKey >= awardDateRange.start && awardDateKey <= awardDateRange.end;
        });
      }
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

        let detail: Record<string, unknown> | null = await getCachedNoticeDetail(noticeNumber);
        if (detail) {
          funnel.detailFromCache += 1;
        } else {
          try {
            const lookup = await withRetry(() => fetchNoticeDetail(bidNtceNo, bidNtceOrd, source), 2);
            detail = lookup.value;
          } catch (error) {
            if (error instanceof QuotaExceededError) {
              funnel.quotaExceeded += 1;
              continue;
            }
            logger.warn({ err: error, noticeNumber, source }, "일별 스캔: 공고 상세 조회 실패");
            continue;
          }
          if (detail) {
            // 요구사항(2026-09-11 사용자 제안): 성공한 상세정보는 캐시에 저장해
            // 다음 재확인/재실행 때 API를 다시 부르지 않게 한다.
            await cacheNoticeDetail(noticeNumber, source, detail);
          }
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
                // 요구사항(2026-09-10 사용자 요청: "수량이 없는 키워드는 검색하지
                // 마 ... 검색 결과에 키워드/수량을 꼭 함께 넣어줘"): 문서에 키워드
                // 단어 자체는 있어도 수량을 특정할 수 없으면 실제 발주 물량을 알 수
                // 없는 단순 언급일 가능성이 커서 영업 리드로 만들지 않는다.
                if (!quantityText) continue;
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
                  String(award.bidwinnrBizno ?? "").trim() || null,
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

    // 요구사항(2026-09-10 사용자 리포트: "부직포 매칭이 하나도 안됨 — 아까는
    // 많았는데"): data.go.kr 일일 호출 한도 초과로 상세 조회 자체가 실패하면
    // 매칭 결과가 조용히 0건이 되어 "진짜로 해당 키워드가 없다"와 구분이 안
    // 됐다. 화면의 "오류" 컬럼에 원인을 명확히 남겨 혼동을 막는다.
    const errorMessage =
      funnel.quotaExceeded > 0
        ? `공공데이터포털(data.go.kr) 일일 호출 한도 초과로 ${funnel.quotaExceeded}건의 공고 상세를 확인하지 못했습니다. 보통 자정(KST) 이후 한도가 초기화되니 내일 다시 확인해 주세요.`
        : null;
    const [completed] = await db
      .update(dailyScanRunsTable)
      .set({ status: "completed", awardsFound, candidatesChecked, matchesFound, finishedAt: new Date(), errorMessage })
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
