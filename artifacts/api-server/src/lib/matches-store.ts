import { tmpdir } from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Response } from "express";
import { desc, eq } from "drizzle-orm";
import { db, awardedMatchesTable, dailyScanRunsTable, type AwardedMatch, type DailyScanRun } from "@workspace/db";
import { command } from "./bid-processing";

export async function listAwardedMatches(limit = 500): Promise<AwardedMatch[]> {
  return db
    .select()
    .from(awardedMatchesTable)
    .orderBy(desc(awardedMatchesTable.createdAt))
    .limit(Math.max(1, Math.min(5000, limit)));
}

export async function listScanRuns(limit = 60): Promise<DailyScanRun[]> {
  return db
    .select()
    .from(dailyScanRunsTable)
    .orderBy(desc(dailyScanRunsTable.startedAt))
    .limit(Math.max(1, Math.min(200, limit)));
}

export async function getScanRun(id: number): Promise<DailyScanRun | null> {
  const [run] = await db.select().from(dailyScanRunsTable).where(eq(dailyScanRunsTable.id, id)).limit(1);
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
export async function deleteAllScanData(): Promise<{ deletedMatches: number; deletedRuns: number }> {
  const matches = await db
    .select({ id: awardedMatchesTable.id, attachmentStoredPath: awardedMatchesTable.attachmentStoredPath })
    .from(awardedMatchesTable);
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
  const deletedMatches = await db.delete(awardedMatchesTable).returning({ id: awardedMatchesTable.id });
  const deletedRuns = await db.delete(dailyScanRunsTable).returning({ id: dailyScanRunsTable.id });
  return { deletedMatches: deletedMatches.length, deletedRuns: deletedRuns.length };
}

const MATCH_HEADERS = [
  "공고번호", "현장명(공고명)", "발주기관", "업무구분", "공종", "낙찰자", "사업자등록번호",
  "낙찰자 주소", "낙찰자 전화", "연락처 출처", "현장사무소", "부직포 수량",
  "추정가격", "예산금액", "낙찰금액", "낙찰일", "매칭 키워드", "첨부파일명", "확인시각",
];

const CONTACT_SOURCE_LABELS: Record<string, string> = {
  government: "정부 낙찰기록",
  attachment: "첨부파일에서 추출",
  registry: "조달청 등록정보 보강",
  portal: "포털 검색 보완",
  web: "웹 검색 추정(확인 필요)",
};

function matchRow(match: AwardedMatch): string[] {
  return [
    match.noticeNumber,
    match.siteName ?? match.noticeName ?? "",
    match.demandAgency ?? "",
    match.workCategory ?? "",
    match.workTypeName ?? "",
    match.bidderName ?? "",
    match.bidderBizno ?? "",
    match.bidderAddress ?? "",
    match.bidderPhone ?? "",
    (match.contactSource && CONTACT_SOURCE_LABELS[match.contactSource]) ?? "",
    match.siteOffice ?? "",
    match.quantityText ?? "",
    match.estimatedAmount != null ? String(match.estimatedAmount) : "",
    match.budgetAmount != null ? String(match.budgetAmount) : "",
    match.awardAmount != null ? String(match.awardAmount) : "",
    match.awardDate ?? "",
    match.matchedKeyword,
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

export async function buildMatchesXlsx(matches: AwardedMatch[]): Promise<string> {
  const rows = [MATCH_HEADERS, ...matches.map(matchRow)];
  const workbookDir = await mkdtemp(path.join(tmpdir(), "matches-xlsx-"));
  await mkdir(path.join(workbookDir, "_rels"), { recursive: true });
  await mkdir(path.join(workbookDir, "xl", "_rels"), { recursive: true });
  await mkdir(path.join(workbookDir, "xl", "worksheets"), { recursive: true });
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
  await writeFile(
    path.join(workbookDir, "[Content_Types].xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  await writeFile(
    path.join(workbookDir, "_rels", ".rels"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  await writeFile(
    path.join(workbookDir, "xl", "workbook.xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="누적결과" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  await writeFile(
    path.join(workbookDir, "xl", "_rels", "workbook.xml.rels"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  await writeFile(
    path.join(workbookDir, "xl", "worksheets", "sheet1.xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  );
  const output = path.join(workbookDir, "..", `누적_낙찰검색결과_${Date.now()}.xlsx`);
  await command("zip", ["-qr", output, "."], workbookDir);
  await rm(workbookDir, { recursive: true, force: true });
  return output;
}

export function sendDownload(res: Response, filePath: string, fileName: string): void {
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  createReadStream(filePath).pipe(res);
}
