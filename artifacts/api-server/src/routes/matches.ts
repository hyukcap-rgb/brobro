import path from "node:path";
import { Router, type IRouter } from "express";
import { DownloadMatchAttachmentParams, ListMatchesQueryParams } from "@workspace/api-zod";
import { buildMatchesXlsx, listAwardedMatches, sendDownload } from "../lib/matches-store";
import { resolveMatchAttachmentPath } from "../lib/scan-storage";
import { searchBusinessContactOnPortal, searchBusinessContactOnWeb } from "../lib/bid-processing";
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
  return {
    ...match,
    createdAt: match.createdAt.toISOString(),
    // 요구사항(2026-09-10 사용자 요청 2: "서버에 저장된 파일을 열어볼 수 있도록
    // 링크를 만들어줘"): 화면에서 다운로드 링크를 보여줄지 판단할 수 있도록
    // 보관기간(5개월) 경과 삭제 여부도 함께 내려준다.
    attachmentDeletedAt: match.attachmentDeletedAt ? match.attachmentDeletedAt.toISOString() : null,
  };
}

router.get("/matches", async (req, res) => {
  const params = ListMatchesQueryParams.safeParse(req.query);
  const limit = params.success ? params.data.limit : undefined;
  const matches = await listAwardedMatches(limit);
  res.json({ matches: matches.map(serializeMatch) });
});

// 요구사항(2026-09-10 사용자 요청: "csv 다운로드는 없어도 돼. 헷갈려"): 엑셀
// 다운로드 하나만 남기고 CSV 다운로드는 제거한다.
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
  // 요구사항(전화번호 정확도 보완, 2026-09-09 사용자 리포트: "회사이름과
  // 주소를 교차검증하면 전화번호를 정확히 찾을 수 있을 것 같아"): 이미
  // 알고 있는 주소가 있으면 검색에 지역명을 더하고 결과 주소와 교차검증해
  // 동명의 다른 업체를 걸러낸다.
  const found = await searchBusinessContactOnPortal(match.bidderName, match.bidderAddress);
  const patch: { bidderPhone?: string; bidderAddress?: string; contactSource: string } = { contactSource: "portal" };
  if (!phoneUsable && found?.phone) patch.bidderPhone = found.phone;
  if (!match.bidderAddress && found?.address) patch.bidderAddress = found.address;

  // 요구사항(전화번호 검색 보완, 2026-09-09 사용자 리포트: "너가 생각했을 때
  // 내가 전화번호를 찾아내고 싶어. 방법을 만들어봐"): 네이버 지역검색은
  // "스마트플레이스" 등록 업체만 색인해서 협동조합·비영리단체 등은 못 찾는
  // 경우가 있다(명문사회적협동조합 사례로 확인됨). 전화번호를 여전히 못 찾았
  // 으면 더 넓게 색인된 네이버 웹문서/블로그 검색으로 한 번 더 시도한다.
  if (!patch.bidderPhone && !phoneUsable) {
    const fromWeb = await searchBusinessContactOnWeb(match.bidderName, match.bidderAddress ?? patch.bidderAddress);
    if (fromWeb?.phone) {
      patch.bidderPhone = fromWeb.phone;
      patch.contactSource = "web";
    }
  }

  if (!patch.bidderPhone && !patch.bidderAddress) {
    res.json({ updated: false, reason: "네이버 검색에서 연락처를 찾지 못했습니다." });
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
    // 요구사항(2026-09-11 사용자 요청: "첨부파일을 클릭하면 파일 이름이
    // 이상해. 나라장터에 올라온 파일명 그대로 다운로드 시켜줘"): res.sendFile만
    // 쓰면 Content-Disposition이 없어, 파일 확장자로 열 수 없는 형식(예: hwp)의
    // 경우 브라우저가 URL 경로("attachment")를 저장 파일명으로 써버려 확장자
    // 까지 사라진다("이상한 파일"로 보이는 원인). 나라장터 원본 파일명
    // (match.attachmentFileName)을 그대로 저장 파일명으로 지정하되, PDF 등
    // 미리보기 가능한 형식은 계속 새 탭에서 바로 열리도록 inline을 쓴다.
    const downloadName = match.attachmentFileName || path.basename(filePath);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
    res.sendFile(filePath);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "파일을 찾을 수 없습니다." });
  }
});

export default router;
