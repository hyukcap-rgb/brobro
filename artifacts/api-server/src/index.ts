import app from "./app";
import { logger } from "./lib/logger";
import { ensureAdminSeeded } from "./lib/auth";
import { startDailyScanScheduler, startAttachmentCleanupScheduler } from "./lib/scheduler";
import { recoverOrphanedScanRuns } from "./lib/daily-scan";
import { sendTestEmail } from "./lib/mailer";
import { requestBuffer, formatServiceKey, compactDate } from "./lib/bid-processing";
import { ensureSchema } from "@workspace/db";

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
async function maybeRunLhApiTest(): Promise<void> {
  if (!process.env.RUN_LH_API_TEST) return;
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key) {
    logger.warn("LH API 테스트 건너뜀: DATA_GO_KR_SERVICE_KEY가 없습니다.");
    return;
  }
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 30);

  const bidInfoQuery = [
    `serviceKey=${formatServiceKey(key)}`,
    "pageNo=1",
    "numOfRows=5",
    `tndrbidRegDtStart=${compactDate(start)}`,
    `tndrbidRegDtEnd=${compactDate(today)}`,
  ].join("&");
  try {
    const res = await requestBuffer(
      `https://apis.data.go.kr/B552555/OpenBidInfoList/getOpenBidInfo?${bidInfoQuery}`,
    );
    logger.info(
      { status: res.status, bodyPreview: res.body.toString("utf8").slice(0, 3000) },
      "LH API 테스트: getOpenBidInfo 응답",
    );
  } catch (error) {
    logger.error({ err: error }, "LH API 테스트: getOpenBidInfo 실패");
  }

  const tenderOpenQuery = [
    `serviceKey=${formatServiceKey(key)}`,
    "pageNo=1",
    "numOfRows=5",
    `openDtmStart=${compactDate(start)}0000`,
    `openDtmEnd=${compactDate(today)}2359`,
  ].join("&");
  try {
    const res = await requestBuffer(
      `https://apis.data.go.kr/B552555/OpenTenderopenList/getOpenTenderopenList?${tenderOpenQuery}`,
    );
    logger.info(
      { status: res.status, bodyPreview: res.body.toString("utf8").slice(0, 3000) },
      "LH API 테스트: getOpenTenderopenList 응답",
    );
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
  .then(() => recoverOrphanedScanRuns())
  .then(() => startDailyScanScheduler())
  .then(() => startAttachmentCleanupScheduler())
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
