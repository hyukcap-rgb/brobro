import app from "./app";
import { logger } from "./lib/logger";
import { ensureAdminSeeded, ensureExtraAdminSeeded } from "./lib/auth";
import { startDailyScanScheduler, startAttachmentCleanupScheduler } from "./lib/scheduler";
import { recoverOrphanedScanRuns } from "./lib/daily-scan";
import { clearStoredBidderAddresses } from "./lib/matches-store";
import { sendTestEmail } from "./lib/mailer";
import { requestBuffer, formatServiceKey, compactDate } from "./lib/bid-processing";
import { ensureSchema } from "@workspace/db";
import { startConstructionPeriodBackfill } from "./lib/construction-period-backfill";

// 요구사항(2026-09-14 사용자 요청: "테스트 메일 보내줘"): SEND_TEST_EMAIL_TO가
// 설정되어 있으면 기동 시 1회 테스트 메일을 보낸다. 평소에는 이 환경변수가
// 없어서 아무 일도 하지 않는다.
function maybeSendTestEmail(): Promise<void> {
  const to = process.env.SEND_TEST_EMAIL_TO;
  if (!to) return Promise.resolve();
  return sendTestEmail(to);
}

// 요구사항(2026-09-14 사용자 요청: "토지공사 API 붙이자"): LH 오픈API 2종
// (입찰공고정보_GW, 전자조달-개찰정보(개찰결과정보)_GW)를 실제로 연동하기 전에,
// 날짜 파라미터 형식과 응답 필드(특히 업체별 낙찰상태 vndrSccfBidStatusNm의
// 실제 문자열 값)를 먼저 확인해야 한다. RUN_LH_API_TEST가 설정된 동안만 기동
// 시 1회 호출해서 응답 앞부분을 로그로 남긴다 — 확인 후 이 코드와 환경변수는
// 제거한다(본 기능 구현에는 포함되지 않는 일회성 진단 코드).
function decodeEucKr(body: Buffer): string {
  return new TextDecoder("euc-kr", { fatal: false }).decode(body);
}

async function maybeRunLhApiTest(): Promise<void> {
  if (!process.env.RUN_LH_API_TEST) return;
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key) {
    logger.warn("LH API 테스트 건너뜀: DATA_GO_KR_SERVICE_KEY가 없습니다.");
    return;
  }
  const serviceKey: string = key;
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 30);

  // 여러 페이지에 걸쳐 상태값 enum 전체를 모은다(응답 본문 전체를 로그로
  // 남기면 너무 커서, distinct 값만 추출).
  async function collectDistinctValues(
    baseUrl: string,
    extraParams: string,
    fieldName: string,
    maxPages: number,
  ): Promise<{ values: string[]; totalCount: number | null; pagesFetched: number }> {
    const values = new Set<string>();
    let totalCount: number | null = null;
    let page = 1;
    for (; page <= maxPages; page += 1) {
      const query = [
        `serviceKey=${formatServiceKey(serviceKey)}`,
        `pageNo=${page}`,
        "numOfRows=100",
        extraParams,
      ].join("&");
      const res = await requestBuffer(`${baseUrl}?${query}`);
      const decoded = decodeEucKr(res.body);
      if (totalCount === null) {
        const m = /<totalCount>(\d+)<\/totalCount>/.exec(decoded);
        if (m) totalCount = Number(m[1]);
      }
      const re = new RegExp(`<${fieldName}>([^<]*)</${fieldName}>`, "g");
      for (const m of decoded.matchAll(re)) values.add(m[1].trim());
      if (!decoded.includes("<item>")) break;
    }
    return { values: [...values], totalCount, pagesFetched: page - 1 };
  }

  try {
    const result = await collectDistinctValues(
      "https://apis.data.go.kr/B552555/OpenBidInfoList/getOpenBidInfo",
      `tndrbidRegDtStart=${compactDate(start)}&tndrbidRegDtEnd=${compactDate(today)}`,
      "bidProgrsStatus",
      10,
    );
    logger.info(result, "LH API 테스트: getOpenBidInfo bidProgrsStatus distinct 값");
  } catch (error) {
    logger.error({ err: error }, "LH API 테스트: getOpenBidInfo 실패");
  }

  try {
    const result = await collectDistinctValues(
      "https://apis.data.go.kr/B552555/OpenTenderopenList/getOpenTenderopenList",
      `openDtmStart=${compactDate(start)}&openDtmEnd=${compactDate(today)}`,
      "vndrSccfBidStatusNm",
      10,
    );
    logger.info(result, "LH API 테스트: getOpenTenderopenList vndrSccfBidStatusNm distinct 값");
  } catch (error) {
    logger.error({ err: error }, "LH API 테스트: getOpenTenderopenList 실패");
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

ensureSchema()
  .then(() => ensureAdminSeeded())
  .then(() => ensureExtraAdminSeeded())
  .then(() => recoverOrphanedScanRuns())
  .then(async () => {
    const cleared = await clearStoredBidderAddresses();
    if (cleared > 0) logger.info({ cleared }, "저장돼 있던 낙찰자 사업장 주소 삭제");
  })
  .then(() => startDailyScanScheduler())
  .then(() => startAttachmentCleanupScheduler())
  .then(() => startConstructionPeriodBackfill())
  .then(() => maybeSendTestEmail())
  .then(() => maybeRunLhApiTest())
  .catch((err: unknown) => {
    logger.error({ err }, "Could not initialize database schema/admin account");
  });

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// 장애 대응(2026-10-13): 메인 스레드가 오래 막히면(동기 연산 등) 웹 요청이 전부
// 멈추는데, 막혀 있는 동안에는 로그도 안 찍혀서 원인을 찾기 어려웠다. 5초마다
// 타이머가 제때 돌았는지 확인해, 10초 이상 늦었으면 풀린 직후 얼마나 막혀
// 있었는지 경고를 남긴다(직전 로그와 함께 보면 무엇이 막았는지 좁힐 수 있다).
const EVENT_LOOP_CHECK_MS = 5_000;
let lastEventLoopTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const lagMs = now - lastEventLoopTick - EVENT_LOOP_CHECK_MS;
  if (lagMs > 10_000) logger.warn({ lagMs }, "이벤트 루프(메인 스레드)가 오래 멈춰 있었음");
  lastEventLoopTick = now;
}, EVENT_LOOP_CHECK_MS).unref();

// 장애 대응(2026-10-15): 7/15~16 기간 재검색 중 서버가 오류 로그 없이 두 번
// 재시작됐다(재배포 아님 — Railway가 죽은 프로세스를 자동 재기동). 처리되지 않은
// 예외/거부가 프로세스를 죽이면 진행 중 스캔이 통째로 날아가므로, 로그를 남기고
// 서버는 계속 살려 둔다. 종료 시점도 기록해 다음 재시작의 원인을 추적한다.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "처리되지 않은 Promise 거부 (서버는 계속 동작)");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "처리되지 않은 예외 (서버는 계속 동작)");
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    logger.warn({ signal }, "종료 신호 수신 — 서버 종료");
    process.exit(0);
  });
}
process.on("exit", (code) => {
  logger.warn({ code }, "서버 프로세스 종료");
});
