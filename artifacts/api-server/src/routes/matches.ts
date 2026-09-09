import { Router, type IRouter } from "express";
import { DownloadMatchAttachmentParams, ListMatchesQueryParams } from "@workspace/api-zod";
import { buildMatchesCsv, buildMatchesXlsx, listAwardedMatches, sendDownload } from "../lib/matches-store";
import { resolveMatchAttachmentPath } from "../lib/scan-storage";
import { searchBusinessContactOnPortal } from "../lib/bid-processing";
import { db, awardedMatchesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// 요구사항(전화번호 검색, 2026-09-09 사용자 리포트: "전화번호를 검색해서
// 보여줘"): daily-scan.ts를 고쳐도 이미 저장된 기존 리드는 소급 갱신되지
// 않는다(같은 공고/키워드/첨부파일 조합은 onConflictDoNothing으로 재삽입되지
// 않음). 그래서 사용자가 화면에서 직접 "다시 찾기"를 눌러 그 자리에서
// 재검색할 수 있는 버튼을 붙였다 — 아래가 그 버튼이 호출하는 API.
function isUsablePhone(value: string | null | undefined): boolean {
  return Boolean(value && !value.includes("*"));
}

const router: IRouter = Router();

function serializeMatch(match: Awaited<ReturnType<typeof listAwardedMatches>>[number]) {
  return { ...match, createdAt: match.createdAt.toISOString() };
}

router.get("/matches", async (req, res) => {
  const params = ListMatchesQueryParams.safeParse(req.query);
  const limit = params.success ? params.data.limit : undefined;
  const matches = await listAwardedMatches(limit);
  res.json({ matches: matches.map(serializeMatch) });
});

router.get("/matches/export.csv", async (_req, res) => {
  const matches = await listAwardedMatches(5000);
  res.type("text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent("누적_낙찰검색결과.csv")}`,
  );
  res.send(buildMatchesCsv(matches));
});

router.get("/matches/export.xlsx", async (_req, res) => {
  try {
    const matches = await listAwardedMatches(5000);
    const xlsxPath = await buildMatchesXlsx(matches);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    sendDownload(res, xlsxPath, "누적_낙찰검색결과.xlsx");
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "엑셀 파일을 만들지 못했습니다." });
  }
});

router.post("/matches/:id/refresh-contact", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: "리드를 찾을 수 없습니다." });
    return;
  }
  const [match] = await db.select().from(awardedMatchesTable).where(eq(awardedMatchesTable.id, id)).limit(1);
  if (!match) {
    res.status(404).json({ error: "리드를 찾을 수 없습니다." });
    return;
  }
  if (!match.bidderName) {
    res.status(400).json({ error: "낙찰자명이 없어 검색할 수 없습니다." });
    return;
  }
  const phoneUsable = isUsablePhone(match.bidderPhone);
  if (phoneUsable && match.bidderAddress) {
    res.json({ updated: false, reason: "이미 유효한 연락처가 있습니다.", bidderPhone: match.bidderPhone, bidderAddress: match.bidderAddress });
    return;
  }
  const found = await searchBusinessContactOnPortal(match.bidderName);
  if (!found || (!found.phone && !found.address)) {
    res.json({ updated: false, reason: "네이버 검색에서 연락처를 찾지 못했습니다." });
    return;
  }
  const patch: { bidderPhone?: string; bidderAddress?: string; contactSource: string } = { contactSource: "portal" };
  if (!phoneUsable && found.phone) patch.bidderPhone = found.phone;
  if (!match.bidderAddress && found.address) patch.bidderAddress = found.address;
  if (!patch.bidderPhone && !patch.bidderAddress) {
    res.json({ updated: false, reason: "새로 찾은 연락처가 없습니다." });
    return;
  }
  const [updated] = await db
    .update(awardedMatchesTable)
    .set(patch)
    .where(eq(awardedMatchesTable.id, id))
    .returning();
  res.json({ updated: true, bidderPhone: updated.bidderPhone, bidderAddress: updated.bidderAddress, contactSource: updated.contactSource });
});

router.get("/matches/:id/attachment", async (req, res) => {
  const params = DownloadMatchAttachmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "파일을 찾을 수 없습니다." });
    return;
  }
  const [match] = await db
    .select()
    .from(awardedMatchesTable)
    .where(eq(awardedMatchesTable.id, params.data.id))
    .limit(1);
  if (!match?.attachmentStoredPath) {
    res.status(404).json({ error: "저장된 첨부파일이 없습니다." });
    return;
  }
  // 요구사항(첨부파일 보관, 2026-09-09): 5개월 보관기간이 지나 자동삭제된 경우
  // resolveMatchAttachmentPath가 던지는 일반 "파일을 찾을 수 없습니다" 대신
  // 사유를 명확히 안내한다.
  if (match.attachmentDeletedAt) {
    res.status(410).json({ error: "보관기간(5개월)이 지나 첨부파일이 자동 삭제되었습니다." });
    return;
  }
  try {
    const filePath = await resolveMatchAttachmentPath(match.attachmentStoredPath);
    res.sendFile(filePath);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "파일을 찾을 수 없습니다." });
  }
});

export default router;
