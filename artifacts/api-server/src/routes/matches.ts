import { Router, type IRouter } from "express";
import { DownloadMatchAttachmentParams, ListMatchesQueryParams } from "@workspace/api-zod";
import { buildMatchesCsv, buildMatchesXlsx, listAwardedMatches, sendDownload } from "../lib/matches-store";
import { resolveMatchAttachmentPath } from "../lib/scan-storage";
import { db, awardedMatchesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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
