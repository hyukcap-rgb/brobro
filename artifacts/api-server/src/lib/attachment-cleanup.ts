import path from "node:path";
import { rm, readdir, rmdir } from "node:fs/promises";
import { and, eq, isNull, isNotNull, lt } from "drizzle-orm";
import { db, awardedMatchesTable } from "@workspace/db";
import { SCAN_ROOT } from "./scan-storage";
import { logger } from "./logger";

// 요구사항(첨부파일 보관, 2026-09-09): 다운로드된 첨부파일은 나라장터 API 재호출을
// 피하기 위한 캐시일 뿐이므로, 최대 5개월(약 150일)만 디스크에 보관하고 이후
// 자동 삭제한다. 매칭 레코드(리드 정보) 자체는 삭제하지 않고 attachmentDeletedAt만
// 채워서 "파일은 삭제됐지만 리드는 남아있음"을 표시한다.
export const ATTACHMENT_RETENTION_DAYS = 150;

// 삭제 후 비어버린 공고번호 디렉터리를 정리한다(디렉터리당 파일이 보통 1개뿐이라
// 대부분 매번 비게 된다). 실패해도 치명적이지 않으므로 조용히 무시한다.
async function removeIfEmptyDir(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir);
    if (entries.length === 0) await rmdir(dir);
  } catch {
    // 이미 없거나 동시성 문제로 비어있지 않은 경우 등 — 다음 실행에서 다시 시도됨.
  }
}

export async function runAttachmentCleanup(): Promise<{ deletedCount: number; failedCount: number }> {
  const cutoff = new Date(Date.now() - ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const targets = await db
    .select({
      id: awardedMatchesTable.id,
      noticeNumber: awardedMatchesTable.noticeNumber,
      attachmentStoredPath: awardedMatchesTable.attachmentStoredPath,
    })
    .from(awardedMatchesTable)
    .where(
      and(
        isNotNull(awardedMatchesTable.attachmentStoredPath),
        isNull(awardedMatchesTable.attachmentDeletedAt),
        lt(awardedMatchesTable.createdAt, cutoff),
      ),
    );

  let deletedCount = 0;
  let failedCount = 0;

  for (const target of targets) {
    if (!target.attachmentStoredPath) continue;
    try {
      const filePath = path.resolve(SCAN_ROOT, target.attachmentStoredPath);
      await rm(filePath, { force: true });
      await removeIfEmptyDir(path.dirname(filePath));

      await db
        .update(awardedMatchesTable)
        .set({ attachmentDeletedAt: new Date() })
        .where(eq(awardedMatchesTable.id, target.id));

      deletedCount += 1;
    } catch (error) {
      failedCount += 1;
      logger.warn(
        { err: error, matchId: target.id, noticeNumber: target.noticeNumber },
        "첨부파일 보관기간 만료 자동삭제 실패",
      );
    }
  }

  logger.info(
    { deletedCount, failedCount, retentionDays: ATTACHMENT_RETENTION_DAYS },
    "첨부파일 보관기간(5개월) 만료 자동삭제 완료",
  );

  return { deletedCount, failedCount };
}

