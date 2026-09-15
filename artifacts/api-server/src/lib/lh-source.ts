// 요구사항(2026-09-14 사용자 요청: "나라장터를 기본으로, 토지공사나 군대 입찰싸이트도
// 선택하면 검색할 수 있는 싸이트로 업그레이드"): 한국토지주택공사(LH) 오픈API
// 연동. data.go.kr에 등록된 계정별 서비스키(DATA_GO_KR_SERVICE_KEY, 나라장터와
// 동일)로 호출한다 — 단, data.go.kr는 API 상품마다 별도 활용신청이 필요하므로
// 이 API에 대한 신청이 안 되어 있으면 403(SERVICE_KEY_IS_NOT_REGISTERED_ERROR)로
// 실패한다.
//
// 중요한 구조적 차이(나라장터 대비):
// 1. 응답이 EUC-KR로 인코딩된 XML이다(나라장터는 UTF-8 JSON/XML). UTF-8로
//    그대로 디코딩하면 한글이 깨진다 — 반드시 decodeEucKr을 거쳐야 한다.
// 2. "입찰공고정보_GW"(getOpenBidInfo)는 공고 등록일(tndrbidRegDt)로만 조회할
//    수 있고, 나라장터의 fnlSucsfDate 같은 "낙찰 확정일" 필드가 없다. 대신
//    응답에 bidProgrsStatus(진행상태) 필드가 있어 값이 "낙찰"이면 그 공고가
//    낙찰 확정된 것을 바로 알 수 있다(실사용 확인: 낙찰/입찰진행중/심사중/개찰/
//    유찰/마감 6가지 값 확인됨). 언제 낙찰됐는지는 openDtm(개찰일시)으로
//    판단한다 — LH는 개찰과 동시에(또는 그 직후로) 낙찰자가 정해지는 것으로
//    보여(전자조달-개찰정보 API의 업체별 낙찰상태가 개찰 시점에 함께 내려옴),
//    나라장터처럼 개찰일과 낙찰확정일 사이에 별도의 긴 지연을 두지 않는다.
// 3. 낙찰업체명/연락처를 주지 않는다 — 별도 API(전자조달-개찰정보)를 업체별
//    상태값까지 맞춰 연동해야 하는데, "낙찰" 상태를 뜻하는 정확한 문자열 값을
//    아직 확인하지 못했다(그동안 확인된 값은 전부 탈락/대기 상태:
//    낙찰하한율미만/미심사/예가초과). 1차 버전에서는 업체 정보 없이 공고명/
//    발주처/금액/날짜만 제공한다.
// 4. 첨부파일 다운로드 링크 자체가 없다 — 나라장터처럼 첨부파일 본문에서
//    키워드를 찾을 수 없고, 공고명(bidnmKor)만으로 키워드 매칭한다.
import { requestBuffer, formatServiceKey, parseXmlItems, tagValue } from "./bid-processing";
import { shiftKstDate, type KstDate } from "./kr-holidays";
import { logger } from "./logger";

const LH_BID_INFO_URL = "https://apis.data.go.kr/B552555/OpenBidInfoList/getOpenBidInfo";

// LH의 심사(심사중) 단계가 나라장터보다 길게 걸리는 경우를 놓치지 않도록
// 나라장터(AWARD_DATE_LOOKBACK_DAYS=14)보다 넉넉하게 등록일을 되짚어본다.
const LH_REG_LOOKBACK_DAYS = 45;

export interface LhBidItem {
  bidNum: string;
  bidDegree: string;
  noticeName: string;
  workTypeName: string | null;
  zoneHqCd: string | null;
  bidProgrsStatus: string;
  openDateKey: string | null;
  fdmtlAmt: number | null;
  presmtPrc: number | null;
}

function decodeEucKr(body: Buffer): string {
  return new TextDecoder("euc-kr", { fatal: false }).decode(body);
}

// LH openDtm 필드는 "2026/08/25 15:00" 형태로 온다 — 앞 10자리를
// "YYYY-MM-DD"로 바꿔 나라장터와 동일한 날짜 키 형식으로 맞춘다.
function extractOpenDateKey(raw: unknown): string | null {
  const trimmed = String(raw ?? "").trim();
  const match = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(trimmed);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function toNumberOrNull(raw: unknown): number | null {
  const value = Number(String(raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function fetchLhBidInfoPage(
  serviceKey: string,
  regStartCompact: string,
  regEndCompact: string,
  page: number,
): Promise<{ items: Record<string, unknown>[]; totalCount: number }> {
  const query = [
    `serviceKey=${formatServiceKey(serviceKey)}`,
    `pageNo=${page}`,
    "numOfRows=999",
    `tndrbidRegDtStart=${regStartCompact}`,
    `tndrbidRegDtEnd=${regEndCompact}`,
  ].join("&");
  const response = await requestBuffer(`${LH_BID_INFO_URL}?${query}`);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`LH 입찰공고정보 조회 실패 (HTTP ${response.status})`);
  }
  const decoded = decodeEucKr(response.body);
  const resultCode = tagValue(decoded, "resultCode");
  if (resultCode && resultCode !== "00") {
    throw new Error(`LH API 오류 ${resultCode}: ${tagValue(decoded, "resultMsg") || "알 수 없는 오류"}`);
  }
  const totalCount = Number(tagValue(decoded, "totalCount") || "0") || 0;
  return { items: parseXmlItems(decoded), totalCount };
}

// 요구사항: 등록일 기준 넓게 훑어온 뒤(나라장터와 동일 철학 — "낙찰,개찰,입찰을
// 정확히 구분") bidProgrsStatus가 "낙찰"이고 개찰일이 정확히 원하는 날짜인
// 것만 남긴다.
export async function fetchLhAwardsForDate(date: KstDate): Promise<LhBidItem[]> {
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key) throw new Error("DATA_GO_KR_SERVICE_KEY가 설정되지 않았습니다.");
  const regStart = shiftKstDate(date, -LH_REG_LOOKBACK_DAYS).compact;
  const regEnd = date.compact;

  const items: Record<string, unknown>[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const { items: pageItems, totalCount } = await fetchLhBidInfoPage(key, regStart, regEnd, page);
    items.push(...pageItems);
    totalPages = Math.max(1, Math.ceil(totalCount / 999));
    page += 1;
    // 안전장치: 응답이 totalCount와 어긋나 무한 루프가 되는 것을 막는다.
  } while (page <= totalPages && page <= 20);

  const awarded = items.filter((item) => String(item.bidProgrsStatus ?? "").trim() === "낙찰");
  const onTargetDate = awarded.filter((item) => extractOpenDateKey(item.openDtm) === date.key);

  logger.info(
    { date: date.key, fetched: items.length, awarded: awarded.length, onTargetDate: onTargetDate.length },
    "LH 스캔: 입찰공고정보 조회 결과",
  );

  return onTargetDate.map((item) => ({
    bidNum: String(item.bidNum ?? "").trim(),
    bidDegree: String(item.bidDegree ?? "").trim(),
    noticeName: String(item.bidnmKor ?? "").trim(),
    workTypeName: String(item.cstrtnJobGbNm ?? "").trim() || null,
    zoneHqCd: String(item.zoneHqCd ?? "").trim() || null,
    bidProgrsStatus: String(item.bidProgrsStatus ?? "").trim(),
    openDateKey: extractOpenDateKey(item.openDtm),
    fdmtlAmt: toNumberOrNull(item.fdmtlAmt),
    presmtPrc: toNumberOrNull(item.presmtPrc),
  }));
}
