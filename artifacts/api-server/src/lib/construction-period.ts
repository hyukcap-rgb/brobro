// 요구사항(2026-10-19 사용자 요청: "공사 기간이 정해져 있는데 검색리스트에
// "일"로 표시해줘. 2개월 -> 60일 로 변환해서"): 공고문·시방서 등 첨부문서에
// 적힌 공사기간을 찾아 "일" 단위 숫자로 바꾼다. 표기 방식이 제각각이라
// (예: "공사기간: 착공일로부터 60일간", "공 사 기 간 : 2개월",
// "계약기간 : 2026.10.20 ~ 2026.12.31", "공기 : 1년 6개월") 아래 순서로 해석한다.
//   1) 라벨 바로 뒤 문구에서 날짜 구간(시작~종료) → 시작·종료일 포함 일수
//   2) "N일"이 명시돼 있으면 그대로(예: "2개월(60일)"이면 60일)
//   3) "N년 N개월" → 1년=365일, 1개월=30일로 환산
// 라벨이 없더라도 "착공일로부터 N일/N개월" 문구가 있으면 그걸 쓴다.

export type ConstructionPeriod = { days: number; text: string };

const MAX_DAYS = 3650;
const WINDOW = 120;

// "공기"는 "공기청정기"·"공기압축기"처럼 다른 단어에도 들어가므로 콜론이 바로
// 붙은 경우만 라벨로 인정한다.
const LABEL_RE =
  /(공\s*사\s*기\s*간|시\s*공\s*기\s*간|계\s*약\s*기\s*간|사\s*업\s*기\s*간|공\s*기\s*(?=[:：]))/g;

const DATE_RANGE_RE =
  /(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?\s*\.?\s*(?:\([^)]{0,3}\))?\s*(?:부터|[~∼～〜]|-)\s*(?:(\d{4})\s*[.\-/년]\s*)?(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/;
const SINGLE_DATE_RE = /\d{2,4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}\s*일?/g;

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

function utcDay(y: number, m: number, d: number): number | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

function valid(days: number | null): days is number {
  return days != null && Number.isFinite(days) && days >= 1 && days <= MAX_DAYS;
}

function parseWindow(windowText: string): number | null {
  const range = DATE_RANGE_RE.exec(windowText);
  if (range) {
    const y1 = Number(range[1]);
    const y2 = range[4] ? Number(range[4]) : y1;
    const start = utcDay(y1, Number(range[2]), Number(range[3]));
    const end = utcDay(y2, Number(range[5]), Number(range[6]));
    if (start != null && end != null) {
      const days = end - start + 1;
      if (valid(days)) return days;
    }
  }

  // 단독 날짜(준공일 등)는 "N일"로 오인되지 않도록 지운 뒤 기간 숫자를 찾는다.
  const text = windowText.replace(SINGLE_DATE_RE, " ");

  const dayMatch = /(\d{1,3}(?:,\d{3})*|\d+)\s*일(?!\s*[0-9])/.exec(text);
  if (dayMatch) {
    const days = toNumber(dayMatch[1]);
    if (valid(days)) return days;
  }

  const years = /(\d+(?:\.\d+)?)\s*년(?!\s*\d{1,2}\s*월)/.exec(text);
  const months = /(\d+(?:\.\d+)?)\s*개\s*월/.exec(text);
  if (years || months) {
    const days = Math.round((years ? Number(years[1]) * 365 : 0) + (months ? Number(months[1]) * 30 : 0));
    if (valid(days)) return days;
  }
  return null;
}

function cleanSnippet(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 60);
}

export function extractConstructionPeriod(text: string | null | undefined): ConstructionPeriod | null {
  if (!text) return null;

  LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let checked = 0;
  while ((m = LABEL_RE.exec(text)) && checked < 50) {
    checked += 1;
    const start = m.index + m[0].length;
    const windowText = text.slice(start, start + WINDOW).replace(/^[\s:：\-·.]+/, "");
    // 다음 항목 라벨(예: "공사금액", "준공일") 전까지만 본다.
    const cut = windowText.search(/\n\s*\n|(?:공\s*사\s*금\s*액|추\s*정\s*가\s*격|기\s*초\s*금\s*액|입\s*찰\s*방\s*법|공\s*사\s*개\s*요|공\s*사\s*위\s*치|현\s*장\s*위\s*치)/);
    const scoped = cut > 0 ? windowText.slice(0, cut) : windowText;
    const days = parseWindow(scoped);
    if (days != null) return { days, text: cleanSnippet(scoped) };
  }

  const fromStart = /착\s*공\s*(?:일|일자|후)?\s*(?:로\s*)?부\s*터\s*([^\n]{0,40})/.exec(text);
  if (fromStart) {
    const days = parseWindow(fromStart[1]);
    if (days != null) return { days, text: cleanSnippet(fromStart[0]) };
  }
  return null;
}

// 공고 상세 API 응답에 기간 필드가 있으면 그것도 같은 규칙으로 해석한다.
export function extractConstructionPeriodFromDetail(detail: Record<string, unknown>): ConstructionPeriod | null {
  for (const key of ["cnstrtsPeriod", "cnstrtnPrd", "cntrctPrd", "cnstwkPrd"]) {
    const raw = String(detail[key] ?? "").trim();
    if (!raw) continue;
    const days = parseWindow(raw);
    if (days != null) return { days, text: cleanSnippet(raw) };
  }
  return null;
}
