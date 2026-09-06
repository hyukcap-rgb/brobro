// KST(Asia/Seoul) 달력 날짜 유틸 + 정적 관공서 공휴일 목록.
//
// 서버(Railway)는 보통 UTC로 동작하므로 `new Date().getDate()` 같은 로컬 getter는
// 쓰지 않는다. 대신 Intl.DateTimeFormat으로 "지금이 KST로 몇 년 몇 월 며칠/무슨
// 요일인지"를 문자열로 뽑아내고, 그 문자열(YYYY-MM-DD)만으로 날짜를 다룬다.
//
// data.go.kr의 특일 정보 API(getRestDeInfo)는 이 서비스에 등록된 서비스키로
// 403(미승인 데이터셋)을 반환해 사용할 수 없었다. 나라장터 발주기관은 모두
// 정부/공공기관이므로 "관공서의 공휴일에 관한 규정" 기준으로 목록을 만들었고,
// 근로자의 날(5/1)·제헌절(7/17)은 공공기관 휴무일이 아니므로 제외했다.
//
// 매년 말 다음 연도 값을 추가해줘야 한다 (관리자 설정 화면에는 아직 노출하지 않음).
const KR_PUBLIC_HOLIDAYS = new Set<string>([
  // 2026
  "2026-01-01", // 신정
  "2026-02-16", // 설 연휴
  "2026-02-17", // 설날
  "2026-02-18", // 설 연휴
  "2026-03-01", // 삼일절
  "2026-03-02", // 대체공휴일(삼일절)
  "2026-05-05", // 어린이날
  "2026-05-24", // 부처님오신날
  "2026-05-25", // 대체공휴일(부처님오신날)
  "2026-06-06", // 현충일
  "2026-08-15", // 광복절
  "2026-08-17", // 대체공휴일(광복절)
  "2026-09-24", // 추석 연휴
  "2026-09-25", // 추석
  "2026-09-26", // 추석 연휴
  "2026-10-03", // 개천절
  "2026-10-05", // 대체공휴일(개천절)
  "2026-10-09", // 한글날
  "2026-12-25", // 크리스마스
  // 2027
  "2027-01-01", // 신정
  "2027-02-06", // 설 연휴
  "2027-02-07", // 설날
  "2027-02-08", // 설 연휴
  "2027-02-09", // 대체공휴일(설날)
  "2027-03-01", // 삼일절
  "2027-05-05", // 어린이날
  "2027-05-13", // 부처님오신날
  "2027-06-06", // 현충일
  "2027-08-15", // 광복절
  "2027-08-16", // 대체공휴일(광복절)
  "2027-09-14", // 추석 연휴
  "2027-09-15", // 추석
  "2027-09-16", // 추석 연휴
  "2027-10-03", // 개천절
  "2027-10-04", // 대체공휴일(개천절)
  "2027-10-09", // 한글날
  "2027-10-11", // 대체공휴일(한글날)
  "2027-12-25", // 크리스마스
  "2027-12-27", // 대체공휴일(크리스마스)
]);

export const KST_TIME_ZONE = "Asia/Seoul";

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const kstFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: KST_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
});

export interface KstDate {
  /** "YYYY-MM-DD" */
  key: string;
  /** "YYYYMMDD", for 나라장터 API date params */
  compact: string;
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// A Date object anchored at 12:00 UTC for the given Y/M/D never crosses a
// calendar boundary when read back with UTC getters, regardless of the
// server's local timezone — this is the trick that keeps all the date
// arithmetic below timezone-safe without a date library.
function utcNoon(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function toKstDate(anchor: Date): KstDate {
  const parts = Object.fromEntries(
    kstFormatter.formatToParts(anchor).map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const weekday = WEEKDAY_INDEX[parts.weekday] ?? anchor.getUTCDay();
  return { key: `${year}-${pad2(month)}-${pad2(day)}`, compact: `${year}${pad2(month)}${pad2(day)}`, year, month, day, weekday };
}

/** KST 기준 "지금"의 달력 날짜. */
export function kstToday(instant: Date = new Date()): KstDate {
  return toKstDate(instant);
}

/** KST 달력 날짜를 deltaDays만큼 이동시킨 날짜(음수면 과거). */
export function shiftKstDate(date: KstDate, deltaDays: number): KstDate {
  const anchor = utcNoon(date.year, date.month, date.day);
  anchor.setUTCDate(anchor.getUTCDate() + deltaDays);
  return toKstDate(anchor);
}

export function isKoreanHoliday(date: KstDate): boolean {
  return KR_PUBLIC_HOLIDAYS.has(date.key);
}

export function isWeekend(date: KstDate): boolean {
  return date.weekday === 0 || date.weekday === 6;
}

export function isNonBusinessDay(date: KstDate): boolean {
  return isWeekend(date) || isKoreanHoliday(date);
}
