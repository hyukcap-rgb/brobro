import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, awardedMatchesTable, dailyScanRunsTable, noticeDetailCacheTable } from "@workspace/db";
import {
  collectAttachments,
  downloadAttachment,
  extractSegments,
  extractZipRecursively,
  withRetry,
} from "./bid-processing";
import { extractConstructionPeriod, extractConstructionPeriodFromDetail, type ConstructionPeriod } from "./construction-period";
import { logger } from "./logger";

// 요구사항(2026-10-19 사용자 요청: "공사 기간이 정해져 있는데 검색리스트에 "일"로
// 표시해줘"): 이 기능 이전에 쌓인 리드에도 공사기간을 채운다. 캐시된 공고
// 상세(notice_detail_cache)의 첨부파일 목록으로 문서를 다시 받아 공사기간을 찾는다.
// 서버 부팅 후 백그라운드에서 공고 하나씩 천천히 처리하고, 검색(스캔)이 돌고
// 있으면 끝날 때까지 기다린다. 찾지 못한 공고는 construction_period_text를 빈
// 문자열로 남겨 다음 부팅 때 다시 시도하지 않는다.

const START_DELAY_MS = 2 * 60_000;
const SCAN_WAIT_MS = 60_000;
const TEXT_CAP = 300_000;

// 공사기간은 내역서보다 공고문·현장설명서·시방서·과업지시서에 적혀 있는 경우가
// 많아 그런 파일을 먼저 본다.
function periodPriority(name: string): number {
  if (/공고|입찰|현장\s*설명|과업|시방|특기|설계\s*설명|계약/.test(name)) return 0;
  if (/내역|단가|산출|도면/.test(name)) return 2;
  return 1;
}

async function scanRunning(): Promise<boolean> {
  const rows = await db
    .select({ id: dailyScanRunsTable.id })
    .from(dailyScanRunsTable)
    .where(eq(dailyScanRunsTable.status, "running"))
    .limit(1);
  return rows.length > 0;
}

async function findPeriodForNotice(detail: Record<string, unknown>): Promise<ConstructionPeriod | null> {
  const fromDetail = extractConstructionPeriodFromDetail(detail);
  if (fromDetail) return fromDetail;
  const fromTitle = extractConstructionPeriod(String(detail.bidNtceNm ?? ""));

  const attachments = collectAttachments(detail).sort((a, b) => periodPriority(a.name) - periodPriority(b.name));
  const scratchDir = await mkdtemp(path.join(tmpdir(), "period-backfill-"));
  try {
    for (const attachment of attachments) {
      let downloadedPath: string;
      try {
        downloadedPath = (await withRetry(() => downloadAttachment(attachment.url, scratchDir, attachment.name), 2)).value;
      } catch {
        continue;
      }
      let roots = [downloadedPath];
      if (path.extname(downloadedPath).toLowerCase() === ".zip") {
        try {
          roots = await extractZipRecursively(downloadedPath);
        } catch {
          continue;
        }
      }
      for (const filePath of roots) {
        if (path.extname(filePath).toLowerCase() === ".zip") continue;
        try {
          if ((await stat(filePath)).isDirectory()) continue;
          const segments = await extractSegments(filePath);
          let text = "";
          for (const segment of segments) {
            text += "\n" + (segment.itemContext ?? segment.text ?? "");
            if (text.length >= TEXT_CAP) break;
          }
          const found = extractConstructionPeriod(text.slice(0, TEXT_CAP));
          if (found) return found;
        } catch {
          // 이 파일만 건너뛴다.
        }
      }
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
  return fromTitle;
}

export async function backfillConstructionPeriods(): Promise<void> {
  const pending = await db
    .select({ noticeNumber: awardedMatchesTable.noticeNumber })
    .from(awardedMatchesTable)
    .where(and(isNull(awardedMatchesTable.constructionPeriodText), eq(awardedMatchesTable.source, "나라장터")))
    .groupBy(awardedMatchesTable.noticeNumber)
    .orderBy(sql`max(${awardedMatchesTable.id}) desc`);
  if (pending.length === 0) return;
  logger.info({ notices: pending.length }, "공사기간 보충 시작");

  let found = 0;
  let processed = 0;
  for (const { noticeNumber } of pending) {
    while (await scanRunning()) {
      await new Promise((resolve) => setTimeout(resolve, SCAN_WAIT_MS));
    }
    let period: ConstructionPeriod | null = null;
    try {
      const cached = await db
        .select({ detailJson: noticeDetailCacheTable.detailJson })
        .from(noticeDetailCacheTable)
        .where(eq(noticeDetailCacheTable.noticeNumber, noticeNumber))
        .limit(1);
      if (cached[0]) period = await findPeriodForNotice(cached[0].detailJson);
    } catch (error) {
      logger.warn({ err: error, noticeNumber }, "공사기간 보충 실패 (이 공고만 건너뜀)");
    }
    await db
      .update(awardedMatchesTable)
      .set({ constructionDays: period?.days ?? null, constructionPeriodText: period?.text ?? "" })
      .where(
        and(
          inArray(awardedMatchesTable.noticeNumber, [noticeNumber]),
          isNull(awardedMatchesTable.constructionPeriodText),
        ),
      );
    processed += 1;
    if (period) found += 1;
    if (processed % 20 === 0) logger.info({ processed, found, total: pending.length }, "공사기간 보충 진행");
  }
  logger.info({ processed, found }, "공사기간 보충 완료");
}

export function startConstructionPeriodBackfill(): void {
  setTimeout(() => {
    backfillConstructionPeriods().catch((error: unknown) => {
      logger.error({ err: error }, "공사기간 보충 중단");
    });
  }, START_DELAY_MS).unref();
}
