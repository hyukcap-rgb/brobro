// data.go.kr 공용 서비스키 호출량 공유(2026-10-19 결정):
// 나라장터 API 키는 brog2b(이 서비스)와 narafile(brog2b-v2)이 같이 쓴다.
// 우선순위는 brog2b가 1순위, narafile이 2순위다 — brog2b가 일일 검색을
// 끝내면 narafile이 "남은 콜"만큼 쓴다. 그러려면 brog2b가
//   ① apis.data.go.kr 호출을 하루(KST) 단위로 세고
//   ② 07시 일일 검색이 끝났다는 표시를 남기고
//   ③ 그 둘을 narafile이 읽을 수 있는 엔드포인트로 내보내야 한다.
// 카운터는 재시작 후에도 유지되도록 DB(api_quota_days)에 둔다. 호출마다
// UPDATE 한 번이지만 하루 수백 콜 수준이라 부담이 없다.
import { pool } from "@workspace/db";
import { kstToday } from "./kr-holidays";
import { logger } from "./logger";

const ensured = { done: false, promise: null as Promise<void> | null };

export async function ensureApiQuotaSchema(): Promise<void> {
  if (ensured.done) return;
  if (!ensured.promise) {
    ensured.promise = pool
      .query(`
        CREATE TABLE IF NOT EXISTS api_quota_days (
          day TEXT PRIMARY KEY,
          calls INTEGER NOT NULL DEFAULT 0,
          scan_started_at TIMESTAMPTZ,
          scan_finished_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      .then(() => {
        ensured.done = true;
      });
  }
  await ensured.promise;
}

// 메모리 카운터(즉시 반영) + DB 반영(비동기). 응답 시에는 둘 중 큰 값을 쓴다.
let memDay = "";
let memCalls = 0;

export function recordDataGoKrCall(url: string): void {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (host !== "apis.data.go.kr") return;
  const day = kstToday().key;
  if (day !== memDay) {
    memDay = day;
    memCalls = 0;
  }
  memCalls += 1;
  void ensureApiQuotaSchema()
    .then(() =>
      pool.query(
        `INSERT INTO api_quota_days (day, calls) VALUES ($1, 1)
         ON CONFLICT (day) DO UPDATE SET calls = api_quota_days.calls + 1, updated_at = now()`,
        [day],
      ),
    )
    .catch((error) => logger.warn({ err: error }, "API 호출 카운터 DB 반영 실패(무시)"));
}

export async function markDailyScanStarted(): Promise<void> {
  const day = kstToday().key;
  await ensureApiQuotaSchema();
  await pool.query(
    `INSERT INTO api_quota_days (day, calls, scan_started_at, scan_finished_at)
     VALUES ($1, 0, now(), NULL)
     ON CONFLICT (day) DO UPDATE SET scan_started_at = now(), scan_finished_at = NULL, updated_at = now()`,
    [day],
  );
}

export async function markDailyScanFinished(): Promise<void> {
  const day = kstToday().key;
  await ensureApiQuotaSchema();
  await pool.query(
    `INSERT INTO api_quota_days (day, calls, scan_finished_at)
     VALUES ($1, 0, now())
     ON CONFLICT (day) DO UPDATE SET scan_finished_at = now(), updated_at = now()`,
    [day],
  );
}

export type ApiQuotaStatus = {
  service: "brog2b";
  day: string;
  calls: number;
  scanStartedAt: string | null;
  scanFinishedAt: string | null;
  // 오늘 07시 일일 검색이 끝났는가. narafile은 이 값이 true일 때만 2순위로 시작한다.
  dailyScanDone: boolean;
  // 아직 시작 전인지(true면 narafile은 기다려야 함), 진행 중인지 구분용.
  dailyScanRunning: boolean;
  now: string;
};

export async function getApiQuotaStatus(): Promise<ApiQuotaStatus> {
  const day = kstToday().key;
  await ensureApiQuotaSchema();
  const { rows } = await pool.query<{
    calls: number;
    scan_started_at: Date | null;
    scan_finished_at: Date | null;
  }>(`SELECT calls, scan_started_at, scan_finished_at FROM api_quota_days WHERE day = $1`, [day]);
  const row = rows[0];
  const dbCalls = row ? Number(row.calls) : 0;
  const calls = memDay === day ? Math.max(memCalls, dbCalls) : dbCalls;
  const started = row?.scan_started_at ?? null;
  const finished = row?.scan_finished_at ?? null;
  return {
    service: "brog2b",
    day,
    calls,
    scanStartedAt: started ? started.toISOString() : null,
    scanFinishedAt: finished ? finished.toISOString() : null,
    dailyScanDone: finished !== null,
    dailyScanRunning: started !== null && finished === null,
    now: new Date().toISOString(),
  };
}
