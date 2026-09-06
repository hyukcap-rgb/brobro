import cron from "node-cron";
import { runDailyScan } from "./daily-scan";
import { logger } from "./logger";
import { KST_TIME_ZONE } from "./kr-holidays";

let started = false;

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
