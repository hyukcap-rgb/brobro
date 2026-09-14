import app from "./app";
import { logger } from "./lib/logger";
import { ensureAdminSeeded } from "./lib/auth";
import { startDailyScanScheduler, startAttachmentCleanupScheduler } from "./lib/scheduler";
import { recoverOrphanedScanRuns } from "./lib/daily-scan";
import { sendTestEmail } from "./lib/mailer";
import { ensureSchema } from "@workspace/db";

// 요구사항(2026-09-14 사용자 요청: "테스트 메일 보내줘"): SEND_TEST_EMAIL_TO가
// 설정되어 있으면 기동 시 1회 테스트 메일을 보낸다. 평소에는 이 환경변수가
// 없어서 아무 일도 하지 않는다.
function maybeSendTestEmail(): Promise<void> {
  const to = process.env.SEND_TEST_EMAIL_TO;
  if (!to) return Promise.resolve();
  return sendTestEmail(to);
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
