import cron from "node-cron";
import { db, adminUsersTable } from "@workspace/db";
import { runDailyScan, ScanAlreadyRunningError } from "./daily-scan";
import { runAttachmentCleanup } from "./attachment-cleanup";
import { logger } from "./logger";
import { KST_TIME_ZONE } from "./kr-holidays";

let started = false;
let attachmentCleanupStarted = false;

// 요구사항(2026-09-18 사용자 요청: "admin 과 msjbro 는 별도의 독립적인 id
// 야. msjbro에는 admin 의 모든 정보를 공유하지않아... 두 아이디로 입력은
// 서로 영향을 미치지 않아"): 매일 07시 자동 스캔도 계정마다 독립적으로
// 돈다 — 계정마다 키워드/예산 등 설정이 다를 수 있으므로 각자의 설정으로
// 따로 실행해야 한다. data.go.kr 일일 호출 한도가 계정 수만큼 늘어나는
// 트레이드오프가 있지만(사용자 확인), 그래도 동시에 몰아서 부르지 않도록
// Promise.all이 아니라 순서대로(한 계정씩 끝난 뒤 다음 계정) 실행한다 —
// 한 계정의 실패/한도초과가 다른 계정의 실행 자체를 막지는 않는다.
async function runDailyScanForAllAdmins(): Promise<void> {
  const admins = await db.select({ id: adminUsersTable.id, username: adminUsersTable.username }).from(adminUsersTable);
  for (const admin of admins) {
    logger.info({ username: admin.username }, "일별 낙찰 공고 스캔 시작 (스케줄)");
    try {
      await runDailyScan(admin.id, "schedule");
    } catch (error) {
      // 요구사항(2026-09-11): 수동 실행과 겹쳐서 거절된 것은 오류가 아니라
      // 정상적인 동시실행 방지 동작이므로 error가 아닌 info로 남긴다.
      if (error instanceof ScanAlreadyRunningError) {
        logger.info({ username: admin.username }, "일별 낙찰 공고 스캔 건너뜀 (이미 다른 스캔이 진행 중, 스케줄)");
        continue;
      }
      logger.error({ err: error, username: admin.username }, "일별 낙찰 공고 스캔 실패 (스케줄)");
    }
  }
}

// 요구사항: 매일 오전 7시(KST)에 자동 실행.
export function startDailyScanScheduler(): void {
  if (started) return;
  started = true;
  cron.schedule(
    "0 7 * * *",
    () => {
      runDailyScanForAllAdmins().catch((error) => {
        logger.error({ err: error }, "일별 낙찰 공고 스캔 실패 (스케줄, 계정 목록 조회 단계)");
      });
    },
    { timezone: KST_TIME_ZONE },
  );
  logger.info({ timezone: KST_TIME_ZONE }, "일별 낙찰 공고 스캔 스케줄러 등록 완료 (매일 07:00, 계정별 순차 실행)");
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
