import { tmpdir } from "node:os";
import path from "node:path";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, dailyScanRunsTable, awardedMatchesTable, type DailyScanRun } from "@workspace/db";
import {
  requestBuffer,
  formatServiceKey,
  normalizeItems,
  collectAttachments,
  isPriorityAttachment,
  sanitizeName,
  downloadAttachment,
  extractZipRecursively,
  extractSegments,
  searchSegments,
  withRetry,
  describeError,
  extractItemFields,
} from "./bid-processing";
import { getAppSettings } from "./settings";
import { kstToday, shiftKstDate, isKoreanHoliday, type KstDate } from "./kr-holidays";
import { SCAN_ROOT } from "./scan-storage";
import { logger } from "./logger";

const AWARD_LIST_URL = "https://apis.data.go.kr/1230000/as/ScsbidInfoService/getScsbidListSttusCnstwk";
const NOTICE_DETAIL_URL = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoCnstwk";

// 요구사항 1, 2: 기본은 "전일" 낙찰 공고만 검색하고, 오늘이 월요일이거나 공휴일이면
// 전일 + 전전일 둘 다 검색한다 (주말/공휴일에는 낙찰 공고가 거의 올라오지 않기 때문).
export function computeTargetDates(instant: Date = new Date()): KstDate[] {
  const today = kstToday(instant);
  const yesterday = shiftKstDate(today, -1);
  const dayBeforeYesterday = shiftKstDate(today, -2);
  if (today.weekday === 1 || isKoreanHoliday(today)) {
    return [yesterday, dayBeforeYesterday];
  }
  return [yesterday];
}

async function fetchAwardsForDate(date: KstDate): Promise<Record<string, unknown>[]> {
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key) throw new Error("DATA_GO_KR_SERVICE_KEY가 설정되지 않았습니다.");
  const items: Record<string, unknown>[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const query = [
      `serviceKey=${formatServiceKey(key)}`,
      `pageNo=${page}`,
      "numOfRows=999",
      "inqryDiv=2",
      `inqryBgnDt=${date.compact}0000`,
      `inqryEndDt=${date.compact}2359`,
      "type=json",
    ].join("&");
    const response = await requestBuffer(`${AWARD_LIST_URL}?${query}`);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`낙찰 목록 조회 실패 (HTTP ${response.status}, ${date.key})`);
    }
    const payload = JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
    const body = ((payload.response as Record<string, unknown>)?.body ?? {}) as Record<string, unknown>;
    items.push(...normalizeItems(payload));
    totalPages = Math.max(1, Math.ceil(Number(body.totalCount ?? 0) / 999));
    page += 1;
  } while (page <= totalPages);
  return items;
}

async function fetchNoticeDetail(
  bidNtceNo: string,
  bidNtceOrd: string,
): Promise<Record<string, unknown> | null> {
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key) throw new Error("DATA_GO_KR_SERVICE_KEY가 설정되지 않았습니다.");
  const query = [
    `serviceKey=${formatServiceKey(key)}`,
    "pageNo=1",
    "numOfRows=100",
    "inqryDiv=2",
    `bidNtceNo=${encodeURIComponent(bidNtceNo)}`,
    "type=json",
  ].join("&");
  const response = await requestBuffer(`${NOTICE_DETAIL_URL}?${query}`);
  if (response.status < 200 || response.status >= 300) return null;
  const payload = JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
  const items = normalizeItems(payload);
  const wanted = Number.parseInt(bidNtceOrd, 10);
  return items.find((item) => Number(item.bidNtceOrd) === wanted) ?? items[0] ?? null;
}

// 요구사항 1: "업무구분"(공종) 필터. 나라장터 상세 API의 주공종명/부공종명 필드는
// 실제로 비어있는 경우가 많아, 채워져 있으면 그것으로 판단하고 비어 있으면 공고명 등
// 텍스트에서 설정된 공종 키워드를 찾는 방식으로 대체한다(하이브리드).
function classifyWorkType(
  detail: Record<string, unknown>,
  workTypeKeywords: string[],
): { matched: boolean; workTypeName: string | null } {
  if (workTypeKeywords.length === 0) return { matched: true, workTypeName: null };
  const subTypes = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map((index) => String(detail[`subsiCnsttyNm${index}`] ?? "").trim())
    .filter(Boolean);
  const mainType = String(detail.mainCnsttyNm ?? "").trim();
  const declaredTypes = [mainType, ...subTypes].filter(Boolean);
  if (declaredTypes.length > 0) {
    const hit = declaredTypes.find((type) => workTypeKeywords.some((keyword) => type.includes(keyword)));
    return hit ? { matched: true, workTypeName: hit } : { matched: false, workTypeName: declaredTypes.join(", ") };
  }
  const haystack = `${String(detail.bidNtceNm ?? "")} ${String(detail.mtltyAdvcPsblYnCnstwkNm ?? "")}`;
  const hit = workTypeKeywords.find((keyword) => haystack.includes(keyword));
  return { matched: Boolean(hit), workTypeName: hit ?? null };
}

const SITE_OFFICE_PATTERN =
  /(현장\s*사무소|현장\s*사무실|현장\s*대리인|공사\s*감독관)\s*[:：]?\s*([^\n\r|]{2,60})/;

function guessSiteOffice(text: string): string | null {
  const match = SITE_OFFICE_PATTERN.exec(text);
  return match ? match[2].trim() : null;
}

// 스캔 실행 기록만 즉시 만들어 반환한다 (수동 트리거 API가 바로 202로 응답할 수
// 있도록). 실제 스캔은 executeScanRun에서 진행되며 몇 분씩 걸릴 수 있다.
export async function createPendingScanRun(triggerType: "schedule" | "manual"): Promise<DailyScanRun> {
  const targetDates = computeTargetDates();
  const [run] = await db
    .insert(dailyScanRunsTable)
    .values({ targetDates: targetDates.map((d) => d.key), status: "running", triggerType })
    .returning();
  if (!run) throw new Error("스캔 작업을 생성하지 못했습니다.");
  return run;
}

export async function executeScanRun(run: DailyScanRun): Promise<DailyScanRun> {
  const settings = await getAppSettings();
  const targetDates = run.targetDates.map((key) => {
    const [year, month, day] = key.split("-").map(Number);
    return { key, compact: key.replaceAll("-", ""), year, month, day, weekday: 0 } as KstDate;
  });

  let awardsFound = 0;
  let candidatesChecked = 0;
  let matchesFound = 0;

  try {
    const awardItems: Record<string, unknown>[] = [];
    for (const date of targetDates) {
      awardItems.push(...(await fetchAwardsForDate(date)));
    }
    // 요구사항 1: 최종 낙찰자가 확정된 공고만.
    const confirmedAwards = awardItems.filter((item) => String(item.bidwinnrNm ?? "").trim().length > 0);
    awardsFound = confirmedAwards.length;

    // 예산(공사 규모) 사전 필터: 상세 조회는 비용이 크므로, 낙찰금액(통상 예산의
    // 80~90%)으로 먼저 걸러낸다. 정확한 기준(bdgtAmt)은 상세 조회 후 다시 확인한다.
    const cheapCandidates = confirmedAwards.filter((item) => {
      const bidAmount = Number(item.sucsfbidAmt ?? 0);
      if (!bidAmount) return true;
      return bidAmount >= settings.minBudgetAmount * 0.5;
    });

    for (const award of cheapCandidates) {
      const bidNtceNo = String(award.bidNtceNo ?? "").trim();
      const bidNtceOrd = String(award.bidNtceOrd ?? "").trim();
      if (!bidNtceNo || !bidNtceOrd) continue;
      const noticeNumber = `${bidNtceNo}-${bidNtceOrd.padStart(3, "0")}`;
      candidatesChecked += 1;

      let detail: Record<string, unknown> | null = null;
      try {
        const lookup = await withRetry(() => fetchNoticeDetail(bidNtceNo, bidNtceOrd), 2);
        detail = lookup.value;
      } catch (error) {
        logger.warn({ err: error, noticeNumber }, "일별 스캔: 공고 상세 조회 실패");
        continue;
      }
      if (!detail) continue;

      // 요구사항 3: 공사 규모 필터 (최종 확인).
      const budgetAmount = Number(detail.bdgtAmt ?? 0) || Number(award.sucsfbidAmt ?? 0);
      if (budgetAmount < settings.minBudgetAmount) continue;

      // 요구사항 1: 업무구분(공종) 필터.
      const { matched: workTypeMatched, workTypeName } = classifyWorkType(detail, settings.workTypeKeywords);
      if (!workTypeMatched) continue;

      // 요구사항 4, 5: 공사 내역/요청서 첨부파일에서 키워드 검색.
      const attachments = collectAttachments(detail).sort(
        (a, b) => Number(isPriorityAttachment(b.name)) - Number(isPriorityAttachment(a.name)),
      );
      if (attachments.length === 0) continue;

      const scratchDir = await mkdtemp(path.join(tmpdir(), "daily-scan-"));
      try {
        for (const attachment of attachments) {
          let downloadedPath: string;
          try {
            const download = await withRetry(
              () => downloadAttachment(attachment.url, scratchDir, attachment.name),
              2,
            );
            downloadedPath = download.value;
          } catch (error) {
            logger.warn({ err: error, noticeNumber, fileName: attachment.name }, "일별 스캔: 첨부파일 다운로드 실패");
            continue;
          }

          let searchRoots = [downloadedPath];
          if (path.extname(downloadedPath).toLowerCase() === ".zip") {
            try {
              searchRoots = await extractZipRecursively(downloadedPath);
            } catch (error) {
              logger.warn({ err: error, noticeNumber, fileName: attachment.name }, "일별 스캔: ZIP 압축 해제 실패");
              continue;
            }
          }

          for (const searchablePath of searchRoots) {
            if (path.extname(searchablePath).toLowerCase() === ".zip") continue;
            if ((await stat(searchablePath)).isDirectory()) continue;
            let segments;
            try {
              segments = await extractSegments(searchablePath);
            } catch {
              continue;
            }
            // 요구사항 4: 설정된 키워드(기본 "부직포")가 있는 공고만.
            const matches = searchSegments(segments, settings.matchKeywords);
            if (matches.length === 0) continue;

            // 요구사항 6: 매칭된 첨부파일을 영구 저장(볼륨)한다.
            const matchedFileName = sanitizeName(attachment.name);
            const storedDir = path.join(SCAN_ROOT, noticeNumber);
            await mkdir(storedDir, { recursive: true });
            const storedPath = path.join(storedDir, path.basename(searchablePath));
            await copyFile(searchablePath, storedPath).catch(() => {});

            for (const match of matches) {
              const matchedKeyword = match.foundKeywords[0] ?? settings.matchKeywords[0] ?? "";
              const itemFields = extractItemFields(match.originalText, settings.matchKeywords);
              const quantityText =
                [itemFields.itemQuantity, itemFields.itemUnit]
                  .filter((value) => value && value !== "미공개/확인불가")
                  .join(" ") || null;
              // 요구사항 8: 현장명 / 현장사무소 / 수량.
              const siteOffice =
                guessSiteOffice(match.surroundingText) ??
                guessSiteOffice(match.originalText) ??
                (detail.dminsttNm ? `${String(detail.dminsttNm)} (발주기관 문의)` : null);

              try {
                const inserted = await db
                  .insert(awardedMatchesTable)
                  .values({
                    scanRunId: run.id,
                    noticeNumber,
                    noticeName: String(detail.bidNtceNm ?? "").trim() || null,
                    siteName: String(detail.bidNtceNm ?? "").trim() || null,
                    siteOffice,
                    workTypeName,
                    demandAgency: String(detail.dminsttNm ?? award.dminsttNm ?? "").trim() || null,
                    bidderName: String(award.bidwinnrNm ?? "").trim() || null,
                    bidderBizno: String(award.bidwinnrBizno ?? "").trim() || null,
                    bidderAddress: String(award.bidwinnrAdrs ?? "").trim() || null,
                    bidderPhone: String(award.bidwinnrTelNo ?? "").trim() || null,
                    budgetAmount: budgetAmount || null,
                    awardAmount: Number(award.sucsfbidAmt ?? 0) || null,
                    awardDate: String(award.fnlSucsfDate ?? award.rlOpengDt ?? "").trim() || null,
                    matchedKeyword,
                    quantityText,
                    surroundingText: match.surroundingText,
                    attachmentFileName: matchedFileName,
                    attachmentStoredPath: path.relative(SCAN_ROOT, storedPath),
                  })
                  .onConflictDoNothing()
                  .returning({ id: awardedMatchesTable.id });
                if (inserted.length > 0) matchesFound += 1;
              } catch (error) {
                logger.warn({ err: error, noticeNumber }, "일별 스캔: 매칭 결과 저장 실패");
              }
            }
          }
        }
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    }

    const [completed] = await db
      .update(dailyScanRunsTable)
      .set({ status: "completed", awardsFound, candidatesChecked, matchesFound, finishedAt: new Date() })
      .where(eq(dailyScanRunsTable.id, run.id))
      .returning();
    return completed ?? run;
  } catch (error) {
    const message = describeError(error);
    logger.error({ err: error, runId: run.id }, "일별 스캔 실패");
    const [failed] = await db
      .update(dailyScanRunsTable)
      .set({
        status: "failed",
        awardsFound,
        candidatesChecked,
        matchesFound,
        errorMessage: message,
        finishedAt: new Date(),
      })
      .where(eq(dailyScanRunsTable.id, run.id))
      .returning();
    return failed ?? run;
  }
}

// Convenience wrapper for callers that want to await the whole thing (the
// cron scheduler). The manual-trigger HTTP endpoint instead calls
// createPendingScanRun + executeScanRun separately so it can respond 202
// immediately while the scan keeps running in the background.
export async function runDailyScan(triggerType: "schedule" | "manual" = "schedule"): Promise<DailyScanRun> {
  const run = await createPendingScanRun(triggerType);
  return executeScanRun(run);
}
