import { tmpdir } from "node:os";
import path from "node:path";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { and, desc, eq } from "drizzle-orm";
import { db, dailyScanRunsTable, awardedMatchesTable, noticeDetailCacheTable, type DailyScanRun, type InsertAwardedMatch } from "@workspace/db";
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
  extractSiteAddress,
  extractGeneralAddress,
  extractBusinessContactFromText,
  searchBusinessContactOnPortal,
  searchBusinessContactOnWeb,
  lookupGovCorpInfo,
  type ExtractedSegment,
} from "./bid-processing";
import { fetchLhAwardsForDate, type LhBidItem } from "./lh-source";
import { getAppSettings } from "./settings";
import { kstToday, shiftKstDate, isKoreanHoliday, type KstDate } from "./kr-holidays";
import { SCAN_ROOT, resolveMatchAttachmentPath } from "./scan-storage";
import { listAwardedMatchesForRun } from "./matches-store";
import { sendScanResultEmail, type ScanResultEmailAttachment } from "./mailer";
import { logger } from "./logger";

// 최적화(2026-09-22, 순수 리팩터링 — 동작 변화 없음): "우선순위 첨부파일을
// 앞으로 정렬"하는 동일한 비교 함수가 1차 키워드 파이프라인과 "사용자지정"
// (2차 키워드) 파이프라인 두 곳에 똑같이 복사돼 있었다. 정렬 기준(내림차순,
// 우선순위 첨부파일 먼저)은 동일하므로 공용 함수로 추출한다.
function collectAttachmentsByPriority(detail: Parameters<typeof collectAttachments>[0]): ReturnType<typeof collectAttachments> {
  return collectAttachments(detail).sort(
    (a, b) => Number(isPriorityAttachment(b.name)) - Number(isPriorityAttachment(a.name)),
  );
}

// 최적화(2026-09-22, 순수 리팩터링 — 동작 변화 없음): "사용자지정"(2차 키워드)
// 금액 범위 판정도 나라장터/LH 두 파이프라인에 동일한 조건식으로 복사돼
// 있었다(금액을 구하는 방법만 다름 — 나라장터는 낙찰금액, LH는 기초금액을
// 대리값으로 씀. 이 차이는 호출부에서 그대로 유지하고, 범위 비교 로직만
// 공용화한다).
function isWithinSecondaryAwardRange(
  amount: number | null | undefined,
  settings: Awaited<ReturnType<typeof getAppSettings>>,
): boolean {
  return (
    amount != null &&
    (settings.secondaryMinAwardAmount == null || amount >= settings.secondaryMinAwardAmount) &&
    (settings.secondaryMaxAwardAmount == null || amount <= settings.secondaryMaxAwardAmount)
  );
}

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

// 요구사항(2026-09-11 사용자 재지적: "입찰,개찰,낙찰 3가지를 정확히 구분해야
// 한다 — 자동검색이든 기간 지정 재검색이든 모든 검색의 기준은 낙찰일이다.
// 낙찰이 안 된 건에서 키워드를 검색할 필요 없다. 낙찰 된 건 >> 키워드가
// 있는 건, 이 순서대로 하라"): 나라장터 낙찰정보 API는 개찰일시로만 조회할
// 수 있고 낙찰일(최종낙찰자 확정일, fnlSucsfDate) 기준 조회를 지원하지
// 않는다. "어제 낙찰된 건"을 정확히 찾으려면, 대상 낙찰일보다 이만큼 더
// 이전 개찰일까지 넓게 훑은 뒤(개찰과 낙찰 확정 사이에 며칠씩 지연이 흔하다),
// 그중 실제 낙찰일이 대상 날짜에 해당하는 것만 남겨야 한다 — 자동 스캔(매일
// 07시)·"지금 실행"·"기간 지정 재검색" 전부 이 기준 하나로 통일한다(바로
// 아래 executeScanRun의 fetchDates/confirmedAwards 참고). 이 방식이 아래
// RECHECK_WINDOW_DAYS 역할(뒤늦게 확정되는 낙찰 건을 놓치지 않는 것)까지
// 함께 해결하므로 그 로직은 제거한다.
const AWARD_DATE_LOOKBACK_DAYS = 14;

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
// 요구사항(2026-09-18 사용자 요청: "admin 과 msjbro 는 별도의 독립적인 id
// 야... 두 아이디로 입력은 서로 영향을 미치지 않아"): 갭필 기준일도 계정별로
// 독립적으로 계산한다 — admin의 스캔 이력이 msjbro의 "얼마나 채웠는지" 판단에
// 섞여 들어가면 안 된다(계정마다 스캔 시작 시점·이력이 다를 수 있다).
async function getMostRecentCoveredDateKey(adminUserId: number): Promise<string | null> {
  const recentCompleted = await db
    .select({ targetDates: dailyScanRunsTable.targetDates })
    .from(dailyScanRunsTable)
    .where(and(eq(dailyScanRunsTable.status, "completed"), eq(dailyScanRunsTable.adminUserId, adminUserId)))
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
//
// 요구사항(2026-09-11): 예전에는 여기에 더해 "최근 3일을 완료 여부와 무관하게
// 항상 재확인"하는 RECHECK_WINDOW_DAYS 로직이 있었다 — 낙찰 확정이 개찰 후
// 며칠씩 늦어지는 걸 놓치지 않기 위해서였다. 이제는 모든 검색 기준이 애초에
// "낙찰일"이고(executeScanRun의 AWARD_DATE_LOOKBACK_DAYS 참고), 매일 그 날의
// 낙찰일을 찾을 때 개찰일 기준 최대 14일을 되짚어 확인하므로 이 문제가 이미
// 해결된다 — 별도의 재확인 로직이 더 이상 필요 없다.
export async function computeTargetDatesWithGapFill(
  adminUserId: number,
  instant: Date = new Date(),
): Promise<KstDate[]> {
  const today = kstToday(instant);
  const yesterday = shiftKstDate(today, -1);
  const lastCoveredKey = await getMostRecentCoveredDateKey(adminUserId);

  if (!lastCoveredKey) {
    // 완료된 실행 기록이 아직 없다(최초 실행). 기존 로직 그대로.
    return computeTargetDates(instant);
  }

  const lastCovered = kstDateFromKey(lastCoveredKey);
  if (lastCovered.key >= yesterday.key) {
    // 이미 어제까지(혹은 수동 재실행 등으로 그 이후까지) 커버되어 있다 — 손실
    // 구간 없음. 기존 로직(월요일/공휴일 다음날 이중 확인 포함) 그대로 수행한다.
    return computeTargetDates(instant);
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

  return dates;
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

// 요구사항(2026-09-13 사용자 요청: "히스토리는 계속 누적으로 남겨두고 다만
// 10개까지 보여주고 페이지를 넘기는 방식으로 수정하자"): 2026-09-10에 넣었던
// "최근 7개만 남기고 나머지는 자동삭제" 로직(pruneOldScanRuns)을 제거했다 —
// 화면은 이제 서버 페이지네이션(routes/scans.ts의 offset)으로 10개씩 넘겨
// 보여주고, 기록 자체는 지우지 않고 전부 보존한다. 참고로 이 자동삭제가
// getMostRecentCoveredDateKey()가 참조하는 "완료된 실행 기록"까지 지워버려서,
// 최근 실행이 재배포/한도초과로 계속 실패할 때 정상 완료됐던 과거 기록마저
// 밀려나 사라지고 gap-fill 기준일이 필요 이상으로 옛날로 후퇴하는 부작용도
// 있었다 — 히스토리를 보존하는 쪽이 이 문제도 함께 줄여준다.

// 스캔 실행 기록만 즉시 만들어 반환한다 (수동 트리거 API가 바로 202로 응답할 수
// 있도록). 실제 스캔은 executeScanRun에서 진행되며 몇 분씩 걸릴 수 있다.
export async function createPendingScanRun(
  triggerType: "schedule" | "manual",
  adminUserId: number,
  explicitDateRange?: { start: string; end: string },
): Promise<DailyScanRun> {
  const targetDates = explicitDateRange
    ? buildDateRange(explicitDateRange.start, explicitDateRange.end)
    : await computeTargetDatesWithGapFill(adminUserId); // 요구사항: 기간 지정 시 갭필 없이 그 구간만 검색, 생략 시 기존 자동 로직(전일 기준+미완료 구간 자동 보충) 사용
  // 요구사항(2026-09-15 사용자 리포트: "대상일이 엉뚱하게 나와"): 실제로 이번
  // 실행이 명시적 기간 요청이었는지, 갭필 자동 로직으로 빠졌는지, 그 결과
  // targetDates가 무엇으로 계산됐는지를 남겨 원인을 바로 확인할 수 있게 한다.
  logger.info(
    { triggerType, adminUserId, explicitDateRange, targetDates: targetDates.map((d) => d.key) },
    "createPendingScanRun: 대상 날짜 계산 결과",
  );
  let run: DailyScanRun | undefined;
  try {
    // 요구사항(2026-09-18 사용자 요청: "admin 과 msjbro 는 별도의 독립적인 id
    // 야... 두 아이디로 입력은 서로 영향을 미치지 않아"): 이 실행이 어느
    // 계정의 설정으로 도는지, 결과가 어느 계정 소유가 될지를 여기서 못박는다.
    // 동시실행 방지 유니크 인덱스도 이제 (admin_user_id, status='running')
    // 기준이라(migrate.ts 참고), 같은 계정 안에서만 중복 실행을 막는다.
    [run] = await db
      .insert(dailyScanRunsTable)
      .values({ adminUserId, targetDates: targetDates.map((d) => d.key), status: "running", triggerType })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ScanAlreadyRunningError();
    }
    throw error;
  }
  if (!run) throw new Error("스캔 작업을 생성하지 못했습니다.");
  return run;
}

// 요구사항(2026-09-11 사용자 재지적: "입찰,개찰,낙찰 3가지를 정확히 구분해야
// 한다 — 자동검색이든 기간 지정 재검색이든 모든 검색의 기준은 낙찰일이다.
// 낙찰이 안 된 건에서 키워드를 검색할 필요 없다. 낙찰 된 건 >> 키워드가
// 있는 건, 이 순서대로 하라"): 나라장터 낙찰정보 API는 개찰일자로만 조회할 수
// 있으므로, run.targetDates(찾고자 하는 낙찰일들)보다 최대
// AWARD_DATE_LOOKBACK_DAYS일 더 이전 개찰일까지 넓게 훑어 후보를 가져온 뒤,
// 그중 실제 낙찰일(fnlSucsfDate)이 targetDates에 해당하는 것만 남긴다(아래
// confirmedAwards 필터). 자동 스캔(매일 07시)·"지금 실행"·"기간 지정 재검색"
// 전부 이 하나의 로직(executeScanRun)을 공유하므로 기준이 항상 낙찰일로
// 통일된다 — 더 이상 흐름별로 구분할 필요가 없다.
export async function executeScanRun(run: DailyScanRun): Promise<DailyScanRun> {
  // 요구사항(2026-09-18 사용자 요청: "admin 과 msjbro 는 별도의 독립적인 id
  // 야... 두 아이디로 입력은 서로 영향을 미치지 않아"): 이 실행이 어느 계정
  // 소유인지는 run.adminUserId(createPendingScanRun에서 이미 못박음)로 정해져
  // 있으므로, 그 계정의 설정만 읽는다.
  const settings = await getAppSettings(run.adminUserId);
  const targetDateKeys = run.targetDates;
  const targetDateSet = new Set(targetDateKeys);
  const minTargetKey = targetDateKeys.reduce(
    (min, key) => (key < min ? key : min),
    targetDateKeys[0] ?? kstToday(new Date()).key,
  );
  const maxTargetKey = targetDateKeys.reduce(
    (max, key) => (key > max ? key : max),
    targetDateKeys[0] ?? minTargetKey,
  );
  const lookbackStartKey = shiftKstDate(kstDateFromKey(minTargetKey), -AWARD_DATE_LOOKBACK_DAYS).key;
  const fetchDates = targetDateKeys.length > 0 ? buildDateRange(lookbackStartKey, maxTargetKey) : [];
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
      // 요구사항: 낙찰자가 확정되어 있고(bidwinnrNm), 그 낙찰일(fnlSucsfDate)이
      // 실제로 찾고자 하는 날짜(targetDateSet)에 해당하는 건만 남긴다 — 개찰일
      // 기준으로 넓게 훑어온 후보 중 "낙찰 된 건"만, 그것도 요청받은 낙찰일의
      // 것만 걸러내는 단계 (키워드 검색은 이 다음 단계에서 진행 — "낙찰 된
      // 건 >> 키워드가 있는 건" 순서).
      const confirmedAwards = awardItems.filter((item) => {
        if (String(item.bidwinnrNm ?? "").trim().length === 0) return false;
        const awardDateKey = extractDateKey(item.fnlSucsfDate);
        return awardDateKey !== null && targetDateSet.has(awardDateKey);
      });
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

        // 요구사항(2026-09-15 사용자 요청: "키워드 2번째를 설정할 수 있도록
        // 해줘. 낙찰금액과 공사제목만 넣으면 첫번째 키워드가 없어도 검색되게
        // 하는거야" / 2026-09-18 사용자 요청: "10억 이상 낙찰 공사건중
        // 사용자가 입력하는 키워드가 있으면 '사용자지정' 이라는 이름으로
        // 키워드를 검색해서 똑같이 list up 해줘. 공사 제목에 들어가 있는
        // 키워드는 or 개념으로 하고 첨부파일은 모두 해줘" / 2026-09-18 사용자
        // 재지적: "정확히 말하면 키워드가 있는 건 중 금액 설정하는 방법과
        // 10억이상 공사건 중 키워드가 없는건 중 제목에 새로 지정하는 키워드가
        // 있는거는 검색해 달라는거야. 키워드와 키워드2 개념이야. 둘은 달라"):
        // 1차 키워드(matchKeywords, 첨부파일 내용 검색)와 2차 키워드("사용자지정",
        // 공고 제목 검색)는 서로 다른 개념이지만 상호 배타적으로 적용한다 — 아래
        // primaryPipeline 블록에서 1차 키워드가 실제로 매칭되면(수량까지 확정된
        // 진짜 매칭, primaryMatchedAny=true) "사용자지정" 조건은 적용하지 않는다.
        // 1차 키워드가 없는(또는 예산/추정가격/공종/첨부파일 등 1차 조건을 애초에
        // 통과하지 못한) 공고 중에서만, 낙찰금액이 지정한 범위(권장: 10억 이상)
        // 안이고 공고 제목에 사용자가 등록한 키워드 중 하나라도(OR) 있으면
        // "사용자지정"으로 리드 등록한다(맨 아래 참고). 화면/메일에는 실제 매칭된
        // 키워드가 아니라 통일된 라벨 "사용자지정"으로 표시하고(어떤 키워드였는지는
        // surroundingText에만 남겨 추적용으로 보존), 첨부파일 내용은 검색하지
        // 않지만(제목만으로 이미 매칭 확정) 해당 공고의 첨부파일은 전부 내려받아
        // 1차 매칭과 동일하게 보관/열람/메일 첨부가 되게 한다.
        let primaryMatchedAny = false;
        primaryPipeline: {
        // 요구사항 3: 공사 규모 필터 (최종 확인).
        const budgetAmount = Number(detail.bdgtAmt ?? 0) || Number(award.sucsfbidAmt ?? 0);
        if (budgetAmount < settings.minBudgetAmount) {
          funnel.skippedBudget += 1;
          break primaryPipeline;
        }

        // 요구사항 2: 추정가격(presmptPrce) 범위 필터. 값이 있을 때만 적용한다 —
        // 일부 공고는 추정가격을 공개하지 않아 0/누락으로 오는 경우가 있는데, 그런
        // 공고까지 걸러내면 위의 예산 기준 필터와 상충해 리드를 놓치게 된다.
        const estimatedAmount = Number(detail.presmptPrce ?? 0) || null;
        if (estimatedAmount != null) {
          if (settings.minEstimatedPrice != null && estimatedAmount < settings.minEstimatedPrice) {
            funnel.skippedEstimatedPrice += 1;
            break primaryPipeline;
          }
          if (settings.maxEstimatedPrice != null && estimatedAmount > settings.maxEstimatedPrice) {
            funnel.skippedEstimatedPrice += 1;
            break primaryPipeline;
          }
        }

        // 원인 진단용 임시 로그: "추정가격 미공개라서 예산(낙찰금액) 기준으로만
        // 통과한 건"과 "추정가격이 실제로 존재하는 건"을 구분하기 위해 원본 금액
        // 필드를 그대로 남긴다. (사용자가 나라장터 원본 사이트의 "추정가격≥N"
        // 필터 결과와 우리 시스템의 후보 수가 다르다고 지적한 것을 검증하기 위함)
        logger.debug(
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
          break primaryPipeline;
        }

        // 요구사항 4, 5: 공사 내역/요청서 첨부파일에서 키워드(=우리가 설정한 품목) 검색.
        const attachments = collectAttachmentsByPriority(detail);
        if (attachments.length === 0) {
          // 원인 진단용 임시 로그: 매칭이 0건인 이유가 "첨부파일 자체가 없어서"인지
          // 아니면 다른 단계(다운로드/텍스트 추출)에서 실패하는지 구분하기 위함.
          funnel.noAttachmentUrl += 1;
          logger.debug(
            { noticeNumber, source, bidNtceNm: detail.bidNtceNm },
            "일별 스캔[진단]: 공고 상세에 첨부파일 URL이 없음",
          );
          break primaryPipeline;
        }
        funnel.reachedAttachmentSearch += 1;

        // 요구사항(2026-09-18 사용자 요청: "검색 결과에서 1,000m2 이하
        // 하나만 검색되는 공고를 삭제해줘. 무슨뜻이냐 하면 첨부파일에서
        // 부직포 키워드로 100m2 하나와 10000m2 이렇게 두개가 검색되면 지금처럼
        // 그대로 보여주고, 1000m2 이하 하나만 검색되면 그 공고는 검색하지
        // 않아도 된다는 뜻임"): 이 공고(모든 첨부파일 포함)에서 나온 매칭을
        // 여기 모아뒀다가, 첨부파일을 전부 훑은 뒤에 한 번에 개수/수량을 보고
        // DB에 넣을지 말지 정한다(아래 attachments 루프 끝 참고). 그 전까지는
        // DB에 바로 넣지 않는다.
        const pendingInserts: {
          values: InsertAwardedMatch;
          quantityValue: number | null;
          unit: string | null;
        }[] = [];

        // 요구사항(2026-09-18 사용자 요청: "주소는 현장주소를 1번으로 하고
        // 클릭하면 사업자 주소가 나오게 해줘. 현장주소가 가장 중요해.
        // 첨부파일이나 파일을 검색해서 현장주소 DATA를 꼭 찾아줘"): 예전에는
        // 키워드가 매칭된 그 줄 주변 텍스트(surroundingText)에서만 현장주소를
        // 찾아서, "현장위치:" 같은 문구가 다른 줄이나 다른 첨부파일(시방서·
        // 현장설명서 등)에 있으면 놓치는 경우가 많았다. 이 공고의 첨부파일을
        // 전부 훑으며(아래 attachments 루프) 키워드 매칭 여부와 무관하게 전체
        // 텍스트를 여기 모아뒀다가, 루프가 끝난 뒤 문서 전체에서 현장주소를
        // 찾는다(아래 "현장주소 재검색" 참고). 드물게 첨부파일이 아주 크더라도
        // 메모리를 과하게 쓰지 않도록 누적 길이를 제한한다.
        let allAttachmentText = "";
        const ATTACHMENT_TEXT_CAP = 300_000;

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

              // 요구사항(2026-09-18: 현장주소 재검색) 계속: 키워드 매칭 여부와 무관하게
              // 이 첨부파일에서 추출된 텍스트 전체를 누적한다 — "현장위치:" 같은 라벨이
              // 키워드가 매칭된 행이 아니라 전혀 다른 행/첨부파일(시방서·현장설명서 등)에
              // 있는 경우가 많아서다. ATTACHMENT_TEXT_CAP을 넘으면 더 이상 추가하지
              // 않는다(대용량 첨부파일이 여러 개라도 메모리를 무한정 쓰지 않도록).
              // 장애 대응(2026-09-23 사고: 관리자 계정 일별 스캔이 공고
              // R26BK01720667-000 처리 직후 "RangeError: Invalid string length"로
              // 전체 중단됨 — 첨부파일 배포 직후 첫 스캔에서 처음 발생). 원인: 특정
              // 손상/비정상 첨부파일에서 extractSegments가 비정상적으로 많은(또는
              // 개별적으로 매우 긴) 세그먼트를 반환하면, 아래 join이 최종적으로
              // ATTACHMENT_TEXT_CAP으로 잘리기도 전에 문자열 최대 길이를 넘겨
              // 스캔 실행 전체가 죽었다(이후 공고는 하나도 처리되지 못함). 이제는
              // 세그먼트를 누적하면서 매 조각을 개별적으로도 캡을 넘지 않게 자르고
              // 캡에 도달하면 즉시 멈춰, 거대한 중간 문자열을 절대 만들지 않는다.
              // 정상 범위 첨부파일에서는 최종 결과(allAttachmentText, 캡까지 잘림)가
              // 이전과 동일하다. try/catch는 그래도 예상 못한 실패가 있으면 이
              // 첨부파일만 건너뛰고 나머지 공고 처리는 계속되도록 하는 안전망이다.
              if (allAttachmentText.length < ATTACHMENT_TEXT_CAP) {
                try {
                  // "\n"으로 join한 것과 동일한 모양(구분자가 조각 "사이"에만 들어가고
                  // 끝에는 안 붙음)을 유지하기 위해 첫 조각 여부를 따로 추적한다.
                  let segmentText = "";
                  let isFirstChunk = true;
                  for (const segment of segments) {
                    const chunk = (segment.itemContext ?? segment.text ?? "").slice(0, ATTACHMENT_TEXT_CAP);
                    segmentText += (isFirstChunk ? "" : "\n") + chunk;
                    isFirstChunk = false;
                    if (segmentText.length >= ATTACHMENT_TEXT_CAP) break;
                  }
                  allAttachmentText = `${allAttachmentText}\n${segmentText}`.slice(0, ATTACHMENT_TEXT_CAP);
                } catch (error) {
                  logger.warn(
                    { err: error, noticeNumber, fileName: path.basename(searchablePath) },
                    "일별 스캔[진단]: 첨부파일 텍스트 누적 실패 (이 첨부파일만 건너뜀)",
                  );
                }
              }

              // 요구사항 4: 설정된 키워드(=선택한 품목, 기본 "부직포")가 있는 공고만.
              const matches = searchSegments(segments, settings.matchKeywords);
              logger.debug(
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
                const quantityValue =
                  itemFields.itemQuantity && itemFields.itemQuantity !== "미공개/확인불가"
                    ? Number(itemFields.itemQuantity.replace(/,/g, ""))
                    : null;
                const unit =
                  itemFields.itemUnit && itemFields.itemUnit !== "미공개/확인불가"
                    ? itemFields.itemUnit
                    : null;
                const quantityText =
                  [itemFields.itemQuantity, itemFields.itemUnit]
                    .filter((value) => value && value !== "미공개/확인불가")
                    .join(" ") || null;
                // 요구사항(2026-09-10 사용자 요청: "수량이 없는 키워드는 검색하지
                // 마 ... 검색 결과에 키워드/수량을 꼭 함께 넣어줘"): 문서에 키워드
                // 단어 자체는 있어도 수량을 특정할 수 없으면 실제 발주 물량을 알 수
                // 없는 단순 언급일 가능성이 커서 영업 리드로 만들지 않는다.
                //
                // 요구사항(2026-09-22 사용자 재지적: brog2b.com 실제 결과 화면에서
                // "부직포 · M2"처럼 숫자 없이 단위만 붙거나, "부직포 · 0 m²"처럼
                // 수량이 0으로 기재된 행이 같은 공고에서 여러 건 노출되는 문제 발견
                // — 예: "2026년 긴급누수복구공사 연간단가계약(북구3권역)2차" 공고
                // 하나가 전부 "부직포 · 0 m²"인 행 24건으로 목록을 채움): 단위 셀만
                // 단독으로 매칭되면 itemQuantity가 비어도(itemUnit만 있어도) 위
                // quantityText는 "M2"처럼 채워져 truthy가 되고, 마찬가지로
                // itemQuantity가 문자 그대로 "0"이면 quantityText가 "0 ㎡"로 채워져
                // 역시 truthy가 되어 둘 다 위 필터를 통과해 버렸다. 실제 발주 수량이
                // 없거나(단위만 있음) 0으로 기재된 경우는 "수량 미상"과 실질적으로
                // 같은 상황(발주 물량을 알 수 없음)이므로 원래 취지대로 함께
                // 제외한다.
                if (!quantityText || quantityValue == null || quantityValue <= 0) continue;
                // 요구사항(2026-09-18 사용자 요청: "관급자제 에 키워드가 있는경우
                // 검색하지 않아도 됨. 키워드가 관급자제 아래 검색하려는 키워드가
                // 있는경우 삭제 해줘.이건 우리가 영업을 하지 못해"): 관급자재는
                // 발주기관이 직접 사급(공급)하는 자재라 시공사가 납품 영업을 할 수
                // 없는 항목이므로, 애초에 리드 후보에도 넣지 않는다.
                if (match.section === "관급자재") continue;
                // 요구사항(2026-09-18 사용자 재지적: "키워드가 있는 건 중 금액 설정하는
                // 방법과 10억이상 공사건 중 키워드가 없는건 중 제목에 새로 지정하는
                // 키워드가 있는거는 검색해 달라는거야. 키워드와 키워드2 개념이야. 둘은
                // 달라"): 수량까지 확정된 진짜 1차 키워드 매칭 "후보"이므로(최종
                // 리드로 남길지는 아래 attachments 루프가 끝난 뒤 개수/수량 규칙으로
                // 정한다) 일단 여기서는 아직 primaryMatchedAny를 세우지 않는다.
                // 요구사항 6: 현장명 / 현장사무소 / 수량.
                const siteOffice =
                  guessSiteOffice(match.surroundingText) ??
                  guessSiteOffice(match.originalText) ??
                  (detail.dminsttNm ? `${String(detail.dminsttNm)} (발주기관 문의)` : null);

                // 요구사항(2026-09-18: 현장주소 재검색) 계속: 예전에는 여기서
                // match.surroundingText/originalText(키워드가 매칭된 그 줄 주변)만
                // 보고 현장주소를 찾았다. 이제는 첨부파일 전체를 모은
                // allAttachmentText를 attachments 루프가 다 끝난 뒤 한 번에 검색해서
                // (finalInserts를 만드는 아래쪽 블록 참고) 문서 어디에 있든 찾을 수
                // 있게 한다 — 여기서는 자리만 null로 잡아두고 나중에 채운다.
                const siteAddress: string | null = null;

                // 요구사항 7, 8: 낙찰자 연락처/주소 — 정부 기록에 없으면 첨부파일,
                // 그래도 없으면 네이버 API로 보완.
                const { address: bidderAddress, phone: bidderPhone, contactSource } = await resolveBidderContactCached(
                  String(award.bidwinnrNm ?? "").trim() || null,
                  String(award.bidwinnrAdrs ?? "").trim() || null,
                  String(award.bidwinnrTelNo ?? "").trim() || null,
                  `${match.surroundingText}\n${match.originalText}`,
                  String(award.bidwinnrBizno ?? "").trim() || null,
                );

                // 요구사항(2026-09-18: 1,000㎡ 이하 단독 매칭 제외 — 아래 attachments
                // 루프가 끝난 뒤 개수를 보고 최종 판정): DB 삽입은 미루고 후보로만
                // 쌓아둔다.
                pendingInserts.push({
                  values: {
                    adminUserId: run.adminUserId,
                    scanRunId: run.id,
                    noticeNumber,
                    noticeName: String(detail.bidNtceNm ?? "").trim() || null,
                    siteName: String(detail.bidNtceNm ?? "").trim() || null,
                    siteOffice,
                    siteAddress,
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
                  },
                  quantityValue,
                  unit,
                });
              }
            }
          }

          // 요구사항(2026-09-23 사용자 리포트: "이 결과는 다 같은거 같은데 왜
          // 중복으로 나오는거야?" — 스크린샷으로 확인, "2026년 토하마을
          // 조성사업"/"2026. 진남초 급식소..." 등에서 완전히 동일해 보이는 행이
          // 2개씩 노출됨. 실제 저장된 데이터를 직접 조회해 원인 확인: 같은
          // 공고·같은 첨부파일·같은 매칭키워드·같은 수량("783 kg", "2 M2")인데
          // surroundingText(셀 위치)만 다른 두 행이 저장돼 있었다 — 내역서
          // 엑셀에 총괄내역서/산출내역서처럼 같은 항목이 서로 다른 시트·행에 두
          // 번 적혀 있어서 extractSegments가 그 두 줄을 각각 별도 매칭으로
          // 반환한 것. 2026-09-19에 유니크 인덱스에 surroundingText를 추가한
          // 것은 "정말 다른 두 매칭(예: 87㎡ 한 줄, 263㎡ 다른 줄)은 둘 다
          // 보여준다"는 의도였는데, "같은 수량이 같은 파일에 두 번 적힌 경우"까지
          // 함께 통과시키는 부작용이 있었다. 같은 첨부파일 안에서 같은
          // 매칭키워드로 수량·단위까지 완전히 같은 매칭은 실제로는 같은 항목을
          // 한 번 더 언급한 것일 뿐이므로 첫 번째 것만 남긴다(개수/1,000㎡ 판정도
          // 이 중복 제거 후 기준으로 한다). 서로 다른 첨부파일에 우연히 같은
          // 수량이 나오는 경우는 다른 항목일 수 있어 그대로 둔다.
          const seenPendingKeys = new Set<string>();
          const dedupedPendingInserts = pendingInserts.filter((entry) => {
            const key = `${entry.values.attachmentFileName ?? ""}::${entry.values.matchedKeyword}::${entry.values.quantityText ?? ""}`;
            if (seenPendingKeys.has(key)) return false;
            seenPendingKeys.add(key);
            return true;
          });

          // 요구사항(2026-09-18 사용자 요청: "검색 결과에서 1,000m2 이하 하나만
          // 검색되는 공고를 삭제해줘. 무슨뜻이냐 하면 첨부파일에서 부직포 키워드로
          // 100m2 하나와 10000m2 이렇게 두개가 검색되면 지금처럼 그대로 보여주고,
          // 1000m2 이하 하나만 검색되면 그 공고는 검색하지 않아도 된다는 뜻임"):
          // 이 공고(모든 첨부파일 통틀어)에서 수량 있는 매칭이 정확히 1건뿐이고,
          // 그 단위가 면적 단위(㎡/m²/m2/M2)이며 수량이 1,000 이하면 리드로 만들지
          // 않는다. 2건 이상이면(단위/수량과 무관하게) 기존처럼 전부 보여준다.
          // "100m2"처럼 소량이 하나만 잡힌 건 실제 발주 물량이라기보다 단순 언급일
          // 가능성이 높다는 판단(사용자 예시)이라, 판정 기준값(1,000)을 사용자가
          // 구체적으로 제시한 면적 단위에 한정해서 적용한다 — 개/식/kg/톤처럼 규모
          // 단위가 전혀 다른 수량까지 같은 "1000 이하"로 재단하면 오히려 정상적인
          // 리드를 놓칠 수 있어서다.
          const AREA_UNITS = new Set(["㎡", "m²", "m2", "M2"]);
          let finalInserts = dedupedPendingInserts;
          if (dedupedPendingInserts.length === 1) {
            const only = dedupedPendingInserts[0];
            if (
              only.unit &&
              AREA_UNITS.has(only.unit) &&
              only.quantityValue != null &&
              Number.isFinite(only.quantityValue) &&
              only.quantityValue <= 1000
            ) {
              finalInserts = [];
              logger.info(
                { noticeNumber, quantityValue: only.quantityValue, unit: only.unit },
                "일별 스캔: 1,000㎡ 이하 단독 매칭이라 리드 제외",
              );
            }
          }
          if (finalInserts.length > 0) {
            // 요구사항(2026-09-18 사용자 재지적, 위 918행 주석 참고): 최종적으로
            // 리드가 남는 경우에만 "1차 키워드 있음"으로 표시해 "사용자지정"(2차
            // 키워드) 조건이 중복 적용되지 않게 한다.
            primaryMatchedAny = true;

            // 요구사항(2026-09-18 사용자 요청: "주소는 현장주소를 1번으로 하고
            // 클릭하면 사업자 주소가 나오게 해줘. 현장주소가 가장 중요해.
            // 첨부파일이나 파일을 검색해서 현장주소 DATA를 꼭 찾아줘" / 같은 날
            // 재지적: "보통 공사 제목에 들어가 있잖아. 그걸 토대로 현장주소를
            // 찾아줘"): 발주기관이 공고 제목(bidNtceNm)에 "OO공사(전라남도
            // 여수시 소라면)"처럼 현장 소재지를 직접 적어두는 경우가 흔하고, 이
            // 값은 발주기관이 직접 쓴 것이라 첨부파일 속 다른 언급(예: 관련 없는
            // 참고현장, 협력업체 주소 등)보다 신뢰도가 높다 — 그래서 공고 제목의
            // 주소 패턴(extractGeneralAddress)을 최우선으로 시도한다. 제목에
            // 없으면 첨부파일에서 "현장위치:" 같은 명시적 라벨을 찾고
            // (extractSiteAddress), 그래도 없으면 라벨 없이 첨부파일 본문에
            // 섞여 나오는 주소 패턴 자체를 찾는다(extractGeneralAddress). 첨부파일
            // 쪽은 이 공고의 첨부파일 전체(allAttachmentText, 위 attachments
            // 루프에서 키워드 매칭 여부와 무관하게 누적)를 대상으로 검색하므로,
            // "현장위치:" 라벨이 키워드가 매칭된 줄이 아니라 다른 줄/다른
            // 첨부파일(시방서·현장설명서 등)에 있어도 찾을 수 있다. 그래도 못
            // 찾으면 마지막으로 공사현장지역명(cnstrtsiteRgnNm, 구 단위까지만
            // 나오는 API 필드)으로 대체한다 — bidderAddress(낙찰자 사업자 소재지)
            // 와는 다른 값이다.
            const resolvedSiteAddress =
              extractGeneralAddress(String(detail.bidNtceNm ?? "")) ??
              extractSiteAddress(allAttachmentText) ??
              extractGeneralAddress(allAttachmentText) ??
              (String(detail.cnstrtsiteRgnNm ?? "").trim() || null);
            for (const row of finalInserts) {
              row.values.siteAddress = resolvedSiteAddress;
            }

            for (const row of finalInserts) {
              try {
                const inserted = await db
                  .insert(awardedMatchesTable)
                  .values(row.values)
                  .onConflictDoNothing()
                  .returning({ id: awardedMatchesTable.id });
                if (inserted.length > 0) matchesFound += 1;
              } catch (error) {
                logger.warn({ err: error, noticeNumber }, "일별 스캔: 매칭 결과 저장 실패");
              }
            }
          }
        } finally {
          await rm(scratchDir, { recursive: true, force: true });
        }
        }

        // "사용자지정"(2차 키워드) 조건: 위 primaryPipeline에서 1차 키워드가
        // 이 공고에 대해 실제로 매칭되지 않았을 때만 적용한다(중복 리드 방지 —
        // 2026-09-18 사용자 재지적 참고).
        if (!primaryMatchedAny && settings.secondaryKeywords.length > 0) {
          const secondaryAwardAmount = Number(award.sucsfbidAmt ?? 0) || null;
          const inSecondaryRange = isWithinSecondaryAwardRange(secondaryAwardAmount, settings);
          if (inSecondaryRange) {
            const secondaryTitleSegments: ExtractedSegment[] = [
              { text: String(detail.bidNtceNm ?? ""), sheet: null, page: null, location: "공고명" },
            ];
            const secondaryMatches = searchSegments(secondaryTitleSegments, settings.secondaryKeywords);
            for (const match of secondaryMatches) {
              const actualKeywords = match.foundKeywords.join(", ");
              const secondaryBudgetAmount = Number(detail.bdgtAmt ?? 0) || Number(award.sucsfbidAmt ?? 0) || null;
              const secondaryEstimatedAmount = Number(detail.presmptPrce ?? 0) || null;
              const baseValues = {
                adminUserId: run.adminUserId,
                scanRunId: run.id,
                noticeNumber,
                noticeName: String(detail.bidNtceNm ?? "").trim() || null,
                siteName: String(detail.bidNtceNm ?? "").trim() || null,
                workCategory: source,
                demandAgency: String(detail.dminsttNm ?? award.dminsttNm ?? "").trim() || null,
                bidderName: String(award.bidwinnrNm ?? "").trim() || null,
                bidderBizno: String(award.bidwinnrBizno ?? "").trim() || null,
                budgetAmount: secondaryBudgetAmount,
                estimatedAmount: secondaryEstimatedAmount,
                awardAmount: secondaryAwardAmount,
                awardDate: String(award.fnlSucsfDate ?? award.rlOpengDt ?? "").trim() || null,
                matchedKeyword: "사용자지정",
                surroundingText: `사용자지정 키워드 매칭: ${actualKeywords}`,
              };

              // 요구사항(2026-09-18 사용자 지적: "조건2번째로 검색된 이곳에서 같은곳이
              // 3개야. 같은곳이 없도록 해야지"): 이전에는 첨부파일마다 매번 별도의
              // 행을 만들어 넣어서(매칭 키워드·내용이 모두 "사용자지정"으로 동일한데도)
              // 같은 공고가 첨부파일 개수만큼 화면에 중복으로 나왔다. 첨부파일은
              // 전부 내려받아 보관은 하되(요구사항: 열람/메일 첨부용), 목록에는 공고당
              // 한 행만 남긴다 — 우선순위 첨부파일(isPriorityAttachment, 1차 매칭과
              // 동일 기준)을 대표로 삼는다.
              const secondaryAttachments = collectAttachmentsByPriority(detail);
              let primaryAttachment: { matchedFileName: string; storedRelPath: string } | null = null;
              if (secondaryAttachments.length > 0) {
                const scratchDir = await mkdtemp(path.join(tmpdir(), "daily-scan-secondary-"));
                try {
                  for (const attachment of secondaryAttachments) {
                    let downloadedPath: string;
                    try {
                      const download = await withRetry(
                        () => downloadAttachment(attachment.url, scratchDir, attachment.name),
                        3,
                      );
                      downloadedPath = download.value;
                    } catch (error) {
                      logger.warn(
                        { err: error, noticeNumber, fileName: attachment.name },
                        "일별 스캔: 사용자지정 조건 첨부파일 다운로드 실패",
                      );
                      continue;
                    }
                    const matchedFileName = sanitizeName(attachment.name);
                    const storedDir = path.join(SCAN_ROOT, noticeNumber);
                    await mkdir(storedDir, { recursive: true });
                    const storedPath = path.join(storedDir, path.basename(downloadedPath));
                    await copyFile(downloadedPath, storedPath).catch(() => {});
                    if (!primaryAttachment) {
                      primaryAttachment = {
                        matchedFileName,
                        storedRelPath: path.relative(SCAN_ROOT, storedPath),
                      };
                    }
                  }
                } finally {
                  await rm(scratchDir, { recursive: true, force: true });
                }
              }

              // 첨부파일이 아예 없거나 전부 다운로드에 실패해도, 조건에 맞는
              // 공고 자체는 목록에서 빠지면 안 되므로 파일 없는 행으로라도 남긴다.
              // NULL은 유니크 인덱스에서 서로 다른 값으로 취급되어 재실행 시
              // 중복 삽입될 수 있어, 빈 문자열로 채운다(dedupe가 정상 동작하도록).
              try {
                const inserted = await db
                  .insert(awardedMatchesTable)
                  .values({
                    ...baseValues,
                    attachmentFileName: primaryAttachment?.matchedFileName ?? "",
                    attachmentStoredPath: primaryAttachment?.storedRelPath,
                  })
                  .onConflictDoNothing()
                  .returning({ id: awardedMatchesTable.id });
                if (inserted.length > 0) matchesFound += 1;
              } catch (error) {
                logger.warn({ err: error, noticeNumber }, "일별 스캔: 사용자지정 조건 매칭 결과 저장 실패");
              }
            }
          }
        }

      }
    }

    // 요구사항(2026-09-14 사용자 요청: "나라장터를 기본으로, 토지공사나 군대
    // 입찰싸이트도 선택하면 검색할 수 있는 싸이트로 업그레이드"): 설정에서 LH를
    // 켰으면 나라장터와 별도로 LH 낙찰공고도 함께 검색한다. LH는 첨부파일
    // 다운로드 링크가 없어 공고명(제목)만으로 키워드를 찾고, 첨부파일 기반
    // 수량 확인이 구조적으로 불가능하므로 quantityText 없이(=수량 미상) 바로
    // 리드로 남긴다 — 사용자 확인(2026-09-14): "LH는 수량 없이도 리드로 표시".
    // 낙찰업체명/연락처는 1차 버전에서 제공하지 않는다(사용자 확인: "1차는
    // 업체정보 없이 출시") — lh-source.ts 상단 주석 참고.
    if (settings.enabledSources.includes("LH")) {
      for (const dateKey of targetDateKeys) {
        const date = kstDateFromKey(dateKey);
        let lhAwards: LhBidItem[] = [];
        try {
          lhAwards = await fetchLhAwardsForDate(date);
        } catch (error) {
          logger.warn({ err: error, date: dateKey }, "일별 스캔: LH 낙찰 목록 조회 실패");
          continue;
        }
        awardsFound += lhAwards.length;

        for (const award of lhAwards) {
          if (!award.bidNum || !award.noticeName) continue;
          candidatesChecked += 1;

          // 요구사항(2026-09-15 사용자 요청: 2차 키워드 — 낙찰금액과 공사제목만
          // 넣으면 1차 키워드가 없어도 검색 / 2026-09-18 사용자 요청: "사용자지정"
          // 라벨 통일 / 2026-09-18 사용자 재지적: "정확히 말하면 키워드가 있는 건
          // 중 금액 설정하는 방법과 10억이상 공사건 중 키워드가 없는건 중 제목에
          // 새로 지정하는 키워드가 있는거는 검색해 달라는거야. 키워드와 키워드2
          // 개념이야. 둘은 달라"): 나라장터와 동일하게, 1차 키워드(matchKeywords,
          // 공고 제목 검색 — LH는 첨부파일이 없어 제목만 검색)와 2차 키워드
          // ("사용자지정")는 상호 배타적이다. 아래 primaryPipeline에서 1차
          // 키워드가 제목에 매칭되면(primaryMatchedAny=true) "사용자지정" 조건은
          // 적용하지 않는다. LH는 실제 낙찰금액(sucsfbidAmt에 해당하는 필드)을
          // 제공하지 않아(lh-source.ts 상단 주석 참고) 기초금액(fdmtlAmt, 예산)을
          // 대신 비교 기준으로 쓴다. LH는 첨부파일 다운로드 링크 자체를 제공하지
          // 않으므로(위 LH 낙찰 검색과 동일) 첨부파일 없이 제목 매칭만으로 리드를
          // 남긴다.
          let primaryMatchedAny = false;

          primaryPipeline: {
          const budgetAmount = award.fdmtlAmt;
          if (budgetAmount != null && budgetAmount < settings.minBudgetAmount) {
            funnel.skippedBudget += 1;
            break primaryPipeline;
          }
          const estimatedAmount = award.presmtPrc;
          if (estimatedAmount != null) {
            if (settings.minEstimatedPrice != null && estimatedAmount < settings.minEstimatedPrice) {
              funnel.skippedEstimatedPrice += 1;
              break primaryPipeline;
            }
            if (settings.maxEstimatedPrice != null && estimatedAmount > settings.maxEstimatedPrice) {
              funnel.skippedEstimatedPrice += 1;
              break primaryPipeline;
            }
          }

          const titleSegments: ExtractedSegment[] = [
            { text: award.noticeName, sheet: null, page: null, location: "공고명" },
          ];
          const matches = searchSegments(titleSegments, settings.matchKeywords);
          if (matches.length === 0) break primaryPipeline;
          // 요구사항(2026-09-18 사용자 재지적: "키워드가 있는 건 중 금액 설정하는
          // 방법과 10억이상 공사건 중 키워드가 없는건 중 제목에 새로 지정하는
          // 키워드가 있는거는 검색해 달라는거야. 키워드와 키워드2 개념이야. 둘은
          // 달라"): 1차 키워드가 제목에서 매칭됐으므로 아래 "사용자지정"(2차 키워드)
          // 조건이 중복 적용되지 않게 표시한다.
          primaryMatchedAny = true;

          const noticeNumber = `LH-${award.bidNum}-${award.bidDegree}`;
          for (const match of matches) {
            const matchedKeyword = match.foundKeywords[0] ?? settings.matchKeywords[0] ?? "";
            try {
              const inserted = await db
                .insert(awardedMatchesTable)
                .values({
                  adminUserId: run.adminUserId,
                  scanRunId: run.id,
                  source: "LH",
                  noticeNumber,
                  noticeName: award.noticeName,
                  siteName: award.noticeName,
                  workTypeName: award.workTypeName,
                  demandAgency: award.zoneHqCd ? `한국토지주택공사 ${award.zoneHqCd}` : "한국토지주택공사",
                  budgetAmount,
                  estimatedAmount,
                  awardDate: award.openDateKey ?? dateKey,
                  matchedKeyword,
                  // NULL은 유니크 인덱스에서 서로 다른 값으로 취급되어 재실행 시
                  // 중복 삽입될 수 있어, 첨부파일이 없는 LH 매칭은 빈 문자열로
                  // 채운다(dedupe가 정상 동작하도록).
                  attachmentFileName: "",
                })
                .onConflictDoNothing()
                .returning({ id: awardedMatchesTable.id });
              if (inserted.length > 0) matchesFound += 1;
            } catch (error) {
              logger.warn({ err: error, noticeNumber }, "일별 스캔: LH 매칭 결과 저장 실패");
            }
          }
          }

          // "사용자지정"(2차 키워드) 조건: 위 primaryPipeline에서 1차 키워드가
          // 이 공고 제목에 실제로 매칭되지 않았을 때만 적용한다(중복 리드 방지 —
          // 2026-09-18 사용자 재지적 참고).
          if (!primaryMatchedAny && settings.secondaryKeywords.length > 0) {
            const secondaryProxyAmount = award.fdmtlAmt;
            const inSecondaryRange = isWithinSecondaryAwardRange(secondaryProxyAmount, settings);
            if (inSecondaryRange) {
              const secondaryTitleSegments: ExtractedSegment[] = [
                { text: award.noticeName, sheet: null, page: null, location: "공고명" },
              ];
              const secondaryMatches = searchSegments(secondaryTitleSegments, settings.secondaryKeywords);
              const secondaryNoticeNumber = `LH-${award.bidNum}-${award.bidDegree}`;
              for (const match of secondaryMatches) {
                const actualKeywords = match.foundKeywords.join(", ");
                try {
                  const inserted = await db
                    .insert(awardedMatchesTable)
                    .values({
                      adminUserId: run.adminUserId,
                      scanRunId: run.id,
                      source: "LH",
                      noticeNumber: secondaryNoticeNumber,
                      noticeName: award.noticeName,
                      siteName: award.noticeName,
                      workTypeName: award.workTypeName,
                      demandAgency: award.zoneHqCd ? `한국토지주택공사 ${award.zoneHqCd}` : "한국토지주택공사",
                      budgetAmount: award.fdmtlAmt,
                      estimatedAmount: award.presmtPrc,
                      awardDate: award.openDateKey ?? dateKey,
                      matchedKeyword: "사용자지정",
                      surroundingText: `사용자지정 키워드 매칭: ${actualKeywords}`,
                      attachmentFileName: "",
                    })
                    .onConflictDoNothing()
                    .returning({ id: awardedMatchesTable.id });
                  if (inserted.length > 0) matchesFound += 1;
                } catch (error) {
                  logger.warn({ err: error, noticeNumber: secondaryNoticeNumber }, "일별 스캔: LH 사용자지정 조건 매칭 결과 저장 실패");
                }
              }
            }
          }

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
export async function runDailyScan(
  adminUserId: number,
  triggerType: "schedule" | "manual" = "schedule",
): Promise<DailyScanRun> {
  const run = await createPendingScanRun(triggerType, adminUserId);
  const completed = await executeScanRun(run);
  // 요구사항(2026-09-12 사용자 요청: "오전에 검색이 완료되면 자동으로
  // 보내지도록 해주고"): 매일 07시 자동 스캔(schedule)에서만 메일을 보낸다.
  // 화면에서 수동으로 "지금 실행"/"기간 지정 재검색"을 누를 때마다 메일이
  // 오면 번거롭기 때문이다.
  if (triggerType === "schedule") {
    await sendScheduleResultEmailIfNeeded(completed);
  }
  return completed;
}

function formatDateLabel(dateKeys: string[]): string {
  if (dateKeys.length === 0) {
    const today = kstToday(new Date());
    return `${today.month}/${today.day}`;
  }
  const latest = [...dateKeys].sort()[dateKeys.length - 1];
  const [, month, day] = latest.split("-").map(Number);
  return `${month}/${day}`;
}

// 요구사항(2026-09-12 사용자 요청: "전일 검색 결과가 있으면 메일 제목에
// '나라장터 검색결과_9/12일_몇건' 이렇게 해서 보낼 수 있도록 해줘... 검색
// 결과가 있으면 해당 키워드가 있던 첨부파일도 함께 보내줘"): 이번 실행에서
// 새로 저장된 매칭(matchesFound > 0)이 있고 설정에 등록된 수신 주소가 있을
// 때만 보낸다. 메일 발송이 실패해도 스캔 실행 자체의 성공/실패 판정에는
// 영향을 주지 않도록 별도로 감싼다.
async function sendScheduleResultEmailIfNeeded(run: DailyScanRun): Promise<void> {
  try {
    if (run.status !== "completed" || run.matchesFound <= 0) return;
    const settings = await getAppSettings(run.adminUserId);
    if (settings.notificationEmails.length === 0) return;
    const matches = await listAwardedMatchesForRun(run.id);
    if (matches.length === 0) return;

    const attachments: ScanResultEmailAttachment[] = [];
    for (const match of matches) {
      if (match.attachmentDeletedAt || !match.attachmentStoredPath) continue;
      try {
        const filePath = await resolveMatchAttachmentPath(match.attachmentStoredPath);
        attachments.push({ filename: match.attachmentFileName || path.basename(filePath), path: filePath });
      } catch (error) {
        logger.warn({ err: error, matchId: match.id }, "일일 검색결과 메일: 첨부파일 준비 실패 - 건너뜀");
      }
    }

    await sendScanResultEmail({
      to: settings.notificationEmails,
      dateLabel: formatDateLabel(run.targetDates),
      matches: matches.map((match) => ({
        siteName: match.siteName,
        noticeName: match.noticeName,
        demandAgency: match.demandAgency,
        bidderName: match.bidderName,
        matchedKeyword: match.matchedKeyword,
        quantityText: match.quantityText,
        attachmentFileName: match.attachmentFileName,
      })),
      attachments,
    });
  } catch (error) {
    logger.error({ err: error, runId: run.id }, "일일 검색결과 메일 발송 처리 중 오류");
  }
}
