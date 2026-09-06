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

const MATCH_HEADERS = [
  "공고번호", "현장명(공고명)", "발주기관", "업무구분", "공종", "낙찰자", "사업자등록번호",
  "낙찰자 주소", "낙찰자 전화", "연락처 출처", "현장사무소", "부직포 수량",
  "추정가격", "예산금액", "낙찰금액", "낙찰일", "매칭 키워드", "첨부파일명", "확인시각",
];

const CONTACT_SOURCE_LABELS: Record<string, string> = {
  government: "정부 낙찰기록",
  attachment: "첨부파일에서 추출",
  portal: "포털 검색 보완",
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

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function buildMatchesCsv(matches: AwardedMatch[]): string {
  const rows = [MATCH_HEADERS, ...matches.map(matchRow)];
  return `﻿${rows.map((row) => row.map(csvEscape).join(",")).join("\r\n")}`;
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
