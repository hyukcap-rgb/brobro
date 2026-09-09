import cron from "node-cron";
import { runDailyScan } from "./daily-scan";
import { runAttachmentCleanup } from "./attachment-cleanup";
import { logger } from "./logger";
import { KST_TIME_ZONE } from "./kr-holidays";

let started = false;
let attachmentCleanupStarted = false;

// 요구사항: 매일 오전 7시(KST)에 자동 실행.
export function startDailyScanScheduler(): void {
  if (started) return;
  started = true;
  cron.schedule(
    "0 7 * * *",
    () => {
      logger.info("일별 낙찰 공고 스캔 시작 (스케줄)");
      runDailyScan("schedule").catch((error) => {
        logger.error({ err: error }, "일별 낙찰 공고 스캔 실패 (스케줄)");
      });
    },
    { timezone: KST_TIME_ZONE },
  );
  logger.info({ timezone: KST_TIME_ZONE }, "일별 낙찰 공고 스캔 스케줄러 등록 완료 (매일 07:00)");
}
// 요구사항(첨부파일 보관, 2026-09-09): 매일 오전 4시(KST, 본 스캔 07:00 이전)에
// 보관기간(5개월) 지난 첨부파일을 자동 삭제한다.
export function startAttachmentCleanupScheduler(): void {
  if (attachmentCleanupStarted) return;
  attachmentCleanupStarted = true;
  cron.schedule(
    "0 4 * * *",
    () => {
      logger.info("첨부파일 보관기간 만료 자동삭제 시작 (스케줄)");
      runAttachmentCleanup().catch((error) => {
        logger.error({ err: error }, "첨부파일 보관기간 만료 자동삭제 실패 (스케줄)");
      });
    },
    { timezone: KST_TIME_ZONE },
  );
  logger.info({ timezone: KST_TIME_ZONE }, "첨부파일 자동삭제 스케줄러 등록 완료 (매일 04:00)");
}
