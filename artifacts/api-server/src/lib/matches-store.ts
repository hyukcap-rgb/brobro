import { tmpdir } from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Response } from "express";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db, awardedMatchesTable, dailyScanRunsTable, type AwardedMatch, type DailyScanRun } from "@workspace/db";
import { command } from "./bid-processing";

// 요구사항(2026-09-18 사용자 요청: "admin 과 msjbro 는 별도의 독립적인 id
// 야. msjbro에는 admin 의 모든 정보를 공유하지않아... 두 아이디로 입력은
// 서로 영향을 미치지 않아"): 이 파일의 모든 조회/삭제는 adminUserId로
// 걸러서, 로그인한 계정 자신의 리드/스캔 기록만 보고 건드리게 한다.
// 요구사항(2026-09-23 사용자 요청: "내가 원하는 날짜의 매칭건수를 여러개
// 선택해서 다운로드 받을 수 있도록 수정해줘"): scanRunIds를 넘기면 그 실행
// 기록들에서 나온 매칭만 골라 반환한다. 생략하면(undefined) 기존과 동일하게
// 계정의 전체 누적 매칭을 반환한다 — 화면의 "엑셀 다운로드"가 필터 없을 때
// 지금까지와 똑같이 전체를 받도록 하기 위함.
export async function listAwardedMatches(
  adminUserId: number,
  limit = 500,
  scanRunIds?: number[],
): Promise<AwardedMatch[]> {
  const conditions = [eq(awardedMatchesTable.adminUserId, adminUserId)];
  if (scanRunIds && scanRunIds.length > 0) {
    conditions.push(inArray(awardedMatchesTable.scanRunId, scanRunIds));
  }
  return db
    .select()
    .from(awardedMatchesTable)
    .where(and(...conditions))
    .orderBy(desc(awardedMatchesTable.createdAt))
    .limit(Math.max(1, Math.min(5000, limit)));
}

// 요구사항(2026-09-13 사용자 요청: "히스토리는 계속 누적으로 남겨두고 다만
// 10개까지 보여주고 페이지를 넘기는 방식으로 수정하자"): 예전에는 서버가
// 최근 7건만 남기고 나머지를 자동삭제했었다(daily-scan.ts 참고, 지금은 제거).
// 이제는 기록을 전부 보존하고, 화면에서 offset/limit으로 페이지를 넘기며 볼
// 수 있도록 전체 건수(total)도 함께 반환한다.
export async function listScanRuns(
  adminUserId: number,
  limit = 60,
  offset = 0,
): Promise<{ scans: DailyScanRun[]; total: number }> {
  const [scans, [{ value: total }]] = await Promise.all([
    db
      .select()
      .from(dailyScanRunsTable)
      .where(eq(dailyScanRunsTable.adminUserId, adminUserId))
      .orderBy(desc(dailyScanRunsTable.startedAt))
      .limit(Math.max(1, Math.min(200, limit)))
      .offset(Math.max(0, offset)),
    db
      .select({ value: count() })
      .from(dailyScanRunsTable)
      .where(eq(dailyScanRunsTable.adminUserId, adminUserId)),
  ]);
  return { scans, total };
}

// adminUserId도 함께 걸러서, 다른 계정의 스캔 실행 id를 추측해 들여다보는
// 것을 막는다(예: /api/scans/123을 msjbro가 열어도 admin 소유면 404).
export async function getScanRun(adminUserId: number, id: number): Promise<DailyScanRun | null> {
  const [run] = await db
    .select()
    .from(dailyScanRunsTable)
    .where(and(eq(dailyScanRunsTable.id, id), eq(dailyScanRunsTable.adminUserId, adminUserId)))
    .limit(1);
  return run ?? null;
}

// 요구사항(2026-09-12 사용자 요청: "검색 결과가 있으면 해당 키워드가 있던
// 첨부파일도 함께 보내줘"): 매일 07시 자동 스캔이 끝난 뒤 그 실행에서 새로
// 찾은 매칭만 골라 이메일 본문/첨부파일 구성에 쓰기 위한 조회.
export async function listAwardedMatchesForRun(scanRunId: number): Promise<AwardedMatch[]> {
  return db
    .select()
    .from(awardedMatchesTable)
    .where(eq(awardedMatchesTable.scanRunId, scanRunId))
    .orderBy(desc(awardedMatchesTable.createdAt));
}

// 요구사항(2026-09-10 사용자 요청: "우선 지금 test로 되어있는 결과값들은 모두
// 삭제해줘"): 배포 확인차 수동으로 돌려본 스캔 실행 기록과 그로 인해 저장된
// 매칭 결과를 한 번에 정리하기 위한 전체 삭제. 실제 운영 데이터가 쌓이기 전,
// 일회성 초기화 용도이므로 화면에는 버튼을 따로 만들지 않는다.
// 요구사항(2026-09-18: 계정 독립): 이 전체삭제도 다른 계정 데이터까지 함께
// 지우면 "서로 영향을 미치지 않아야 한다"는 요구를 어기게 되므로, 호출한
// 계정 소유 데이터만 지운다.
export async function deleteAllScanData(
  adminUserId: number,
): Promise<{ deletedMatches: number; deletedRuns: number }> {
  const matches = await db
    .select({ id: awardedMatchesTable.id, attachmentStoredPath: awardedMatchesTable.attachmentStoredPath })
    .from(awardedMatchesTable)
    .where(eq(awardedMatchesTable.adminUserId, adminUserId));
  const { SCAN_ROOT } = await import("./scan-storage");
  for (const match of matches) {
    if (!match.attachmentStoredPath) continue;
    try {
      const filePath = path.resolve(SCAN_ROOT, match.attachmentStoredPath);
      await rm(filePath, { force: true });
    } catch {
      // 파일이 이미 없거나 삭제 실패해도 레코드 삭제는 계속 진행한다.
    }
  }
  const deletedMatches = await db
    .delete(awardedMatchesTable)
    .where(eq(awardedMatchesTable.adminUserId, adminUserId))
    .returning({ id: awardedMatchesTable.id });
  const deletedRuns = await db
    .delete(dailyScanRunsTable)
    .where(eq(dailyScanRunsTable.adminUserId, adminUserId))
    .returning({ id: dailyScanRunsTable.id });
  return { deletedMatches: deletedMatches.length, deletedRuns: deletedRuns.length };
}

// 요구사항(2026-09-18 사용자 지적: "조건2번째로 검색된 이곳에서 같은곳이
// 3개야. 같은곳이 없도록 해야지"): daily-scan.ts의 버그로, "사용자지정"(2차
// 키워드) 매칭은 예전에 공고 하나당 첨부파일 개수만큼 행을 만들어 화면에
// 같은 공고가 여러 번 중복으로 나왔다(버그 자체는 daily-scan.ts에서 이미
// 수정했지만, 이미 저장된 과거 데이터는 소급 갱신되지 않는다). 같은
// (source, noticeNumber) 조합의 "사용자지정" 행이 여러 개면 가장 먼저 저장된
// 것(id가 가장 작은 것) 하나만 남기고 나머지는 지운다. 관리자가 필요할 때
// 직접 호출하는 일회성 정리용이라 화면 버튼은 만들지 않는다.
// 공고를 식별하는 기준(같은 사이트 + 같은 공고번호)을 한 곳에 모은다.
// dedupeSecondaryMatches/groupMatchesByNotice 둘 다 같은 조합으로 "같은
// 공고"를 판단하므로(코드 중복 정리, 2026-09-24 최적화 검토), 문자열 조합
// 로직을 여기 하나로 합쳤다 — 두 함수가 선택하는 컬럼 집합은 서로 달라도
// (부분 조회 vs 전체 행) {source, noticeNumber}만 있으면 그대로 쓸 수 있다.
function noticeGroupKey(match: { source: string; noticeNumber: string }): string {
  return `${match.source}::${match.noticeNumber}`;
}

export async function dedupeSecondaryMatches(adminUserId: number): Promise<{ deletedCount: number }> {
  const rows = await db
    .select({
      id: awardedMatchesTable.id,
      source: awardedMatchesTable.source,
      noticeNumber: awardedMatchesTable.noticeNumber,
    })
    .from(awardedMatchesTable)
    .where(
      and(eq(awardedMatchesTable.matchedKeyword, "사용자지정"), eq(awardedMatchesTable.adminUserId, adminUserId)),
    )
    .orderBy(awardedMatchesTable.id);

  const seen = new Set<string>();
  const idsToDelete: number[] = [];
  for (const row of rows) {
    const key = noticeGroupKey(row);
    if (seen.has(key)) {
      idsToDelete.push(row.id);
    } else {
      seen.add(key);
    }
  }
  if (idsToDelete.length === 0) return { deletedCount: 0 };
  const deleted = await db
    .delete(awardedMatchesTable)
    .where(inArray(awardedMatchesTable.id, idsToDelete))
    .returning({ id: awardedMatchesTable.id });
  return { deletedCount: deleted.length };
}

// 요구사항(2026-09-24 사용자 요청: "엑셀다운로드, 메일발송에도 하나의
// 공고에 여러개의 키워드라면 그냥 하나의 공고와 여러개 키워드 몇개가
// 나왔는지만 표현해줘"): 화면(matches.tsx)에서는 같은 공고(같은
// source+noticeNumber)의 여러 키워드 매칭을 한 행 + "외N건"으로 묶어
// 보여주는데, 엑셀 다운로드·메일 발송은 여전히 매칭마다 별도 행/안내로
// 나가고 있었다. 화면과 동일한 기준으로 매칭을 공고 단위로 묶어 대표 매칭
// 1건과 총 매칭 건수(그리고 "내역서" 첨부 여부 판정 등에 쓰이는 전체
// 구성원)를 함께 반환한다. matches는 보통 listAwardedMatches/
// listAwardedMatchesForRun(둘 다 desc createdAt)로 넘어오므로, 같은 공고의
// 첫 등장이 가장 최근 매칭이고 그것을 대표로 삼는다.
export interface MatchNoticeGroup {
  key: string;
  representative: AwardedMatch;
  count: number;
  members: AwardedMatch[];
}

export function groupMatchesByNotice(matches: AwardedMatch[]): MatchNoticeGroup[] {
  const groups: MatchNoticeGroup[] = [];
  const indexByKey = new Map<string, number>();
  for (const match of matches) {
    const key = noticeGroupKey(match);
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, groups.length);
      groups.push({ key, representative: match, count: 1, members: [match] });
    } else {
      const group = groups[existingIndex];
      group.count += 1;
      group.members.push(match);
    }
  }
  return groups;
}

// 대표 매칭의 키워드에, 같은 공고에서 매칭이 더 있으면 "외N건"을 덧붙인다
// (matches.tsx 화면 표시와 동일한 문구).
function formatMatchedKeywordCell(representative: AwardedMatch, count: number): string {
  return count > 1 ? `${representative.matchedKeyword} 외${count - 1}건` : representative.matchedKeyword;
}

const MATCH_HEADERS = [
  "공고번호", "현장명(공고명)", "발주기관", "업무구분", "공종", "낙찰자", "사업자등록번호",
  // 요구사항(2026-09-13: 사업자 주소와 실제 공사현장 주소를 둘 다 보여줌).
  "사업자 주소", "현장 주소", "낙찰자 전화", "연락처 출처", "현장사무소", "부직포 수량",
  "추정가격", "예산금액", "낙찰금액", "낙찰일", "매칭 키워드", "첨부파일명", "확인시각",
];

const CONTACT_SOURCE_LABELS: Record<string, string> = {
  government: "정부 낙찰기록",
  attachment: "첨부파일에서 추출",
  registry: "조달청 등록정보 보강",
  portal: "포털 검색 보완",
  web: "웹 검색 추정(확인 필요)",
};

function matchRow(match: AwardedMatch, keywordCount = 1): string[] {
  return [
    match.noticeNumber,
    match.siteName ?? match.noticeName ?? "",
    match.demandAgency ?? "",
    match.workCategory ?? "",
    match.workTypeName ?? "",
    match.bidderName ?? "",
    match.bidderBizno ?? "",
    match.bidderAddress ?? "",
    match.siteAddress ?? "",
    match.bidderPhone ?? "",
    (match.contactSource && CONTACT_SOURCE_LABELS[match.contactSource]) ?? "",
    match.siteOffice ?? "",
    match.quantityText ?? "",
    match.estimatedAmount != null ? String(match.estimatedAmount) : "",
    match.budgetAmount != null ? String(match.budgetAmount) : "",
    match.awardAmount != null ? String(match.awardAmount) : "",
    match.awardDate ?? "",
    formatMatchedKeywordCell(match, keywordCount),
    match.attachmentFileName ?? "",
    match.createdAt.toISOString(),
  ];
}

function xmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function excelColumn(index: number): string {
  let result = "";
  let value = index + 1;
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

// 요구사항(2026-09-18 사용자 요청: "결과값을 2개의 시트로 나눠서 엑셀을 받을
// 수 있도록 해줘 - 1.지금처럼 결과값이 나오는 시트 2.결과값이 나온 시트 중
// 키워드2 와 키워드1 중 공내역서 첨부파일이 없는 공고"): 매칭된 리드는 항상
// 1차 키워드(matchKeywords) 아니면 2차 키워드("사용자지정") 둘 중 하나로
// 잡히므로, "1차/2차 키워드 중"은 곧 1번 시트 전체를 뜻한다. 그중 매칭된
// 첨부파일명 어디에도 "내역서"라는 글자가 없는 공고만 2번째 시트로 추린다
// (AskUserQuestion으로 확인: 파일명에 "내역서" 포함 여부로 판단, 같은 공고가
// 여러 매칭 행으로 나오면 공고 하나당 대표 행 하나만).
const BILL_OF_QUANTITIES_MARKER = "내역서";

function hasBillOfQuantitiesAttachment(matchesForNotice: AwardedMatch[]): boolean {
  return matchesForNotice.some((match) => (match.attachmentFileName ?? "").includes(BILL_OF_QUANTITIES_MARKER));
}

function buildSheetXml(rows: string[][]): string {
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map(
          (value, columnIndex) =>
            `<c r="${excelColumn(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`,
        )
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
}

export async function buildMatchesXlsx(matches: AwardedMatch[]): Promise<string> {
  // 요구사항(2026-09-24: 엑셀도 공고 단위로 한 행 + "외N건"): 시트1(누적결과)은
  // 공고 단위로 묶은 모든 그룹, 시트2("내역서 없는 공고")는 그중 매칭된
  // 첨부파일 어디에도 "내역서"가 없는 공고만 추린다(2026-09-18 요구사항과
  // 동일한 기준 — 판정은 그룹 안의 모든 매칭 첨부파일명을 본다).
  const noticeGroups = groupMatchesByNotice(matches);
  const sheet1Rows = [MATCH_HEADERS, ...noticeGroups.map((group) => matchRow(group.representative, group.count))];
  const sheet2Groups = noticeGroups.filter((group) => !hasBillOfQuantitiesAttachment(group.members));
  const sheet2Rows = [MATCH_HEADERS, ...sheet2Groups.map((group) => matchRow(group.representative, group.count))];
  const workbookDir = await mkdtemp(path.join(tmpdir(), "matches-xlsx-"));
  await mkdir(path.join(workbookDir, "_rels"), { recursive: true });
  await mkdir(path.join(workbookDir, "xl", "_rels"), { recursive: true });
  await mkdir(path.join(workbookDir, "xl", "worksheets"), { recursive: true });
  await writeFile(
    path.join(workbookDir, "[Content_Types].xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  await writeFile(
    path.join(workbookDir, "_rels", ".rels"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  await writeFile(
    path.join(workbookDir, "xl", "workbook.xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="누적결과" sheetId="1" r:id="rId1"/><sheet name="내역서 없는 공고" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  );
  await writeFile(
    path.join(workbookDir, "xl", "_rels", "workbook.xml.rels"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
  );
  await writeFile(path.join(workbookDir, "xl", "worksheets", "sheet1.xml"), buildSheetXml(sheet1Rows));
  await writeFile(path.join(workbookDir, "xl", "worksheets", "sheet2.xml"), buildSheetXml(sheet2Rows));
  const output = path.join(workbookDir, "..", `누적_낙찰검색결과_${Date.now()}.xlsx`);
  await command("zip", ["-qr", output, "."], workbookDir);
  await rm(workbookDir, { recursive: true, force: true });
  return output;
}

export function sendDownload(res: Response, filePath: string, fileName: string): void {
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  createReadStream(filePath).pipe(res);
}
