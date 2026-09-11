import path from "node:path";
import { Router, type IRouter } from "express";
import {
  GetBidCollectionStatusParams,
  GetBidCollectionStatusResponse,
  StartBidCollectionBody,
  StartBidCollectionResponse,
} from "@workspace/api-zod";
import {
  buildArchive,
  buildCsv,
  buildXlsx,
  createCollectionJob,
  deleteAllJobs,
  getCollectionJob,
  listRecentJobs,
  parseNoticeUpload,
  resolveAttachmentFile,
  retryFailedCollectionJob,
  sendDownload,
} from "../lib/bid-processing";

const router: IRouter = Router();

router.post("/bids/collect", async (req, res) => {
  const input = StartBidCollectionBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: "공고번호 목록 형식을 확인해 주세요." });
    return;
  }
  try {
    const job = await createCollectionJob(input.data.noticeNumbers, input.data.keywords);
    const response = StartBidCollectionResponse.parse({
      jobId: job.jobId,
      status: job.status,
      totalCount: job.totalCount,
      completedCount: job.completedCount,
    });
    res.status(202).json(response);
  } catch (error) {
    req.log.warn({ err: error }, "Could not start bid collection");
    res.status(400).json({
      error: error instanceof Error ? error.message : "수집 작업을 시작하지 못했습니다.",
    });
  }
});

router.post("/bids/import", async (req, res) => {
  const { fileName, contentBase64 } = req.body as { fileName?: string; contentBase64?: string };
  if (!fileName || !contentBase64) {
    res.status(400).json({ error: "업로드 파일이 필요합니다." });
    return;
  }
  try {
    res.json(await parseNoticeUpload(fileName, contentBase64));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "업로드 파일을 읽지 못했습니다." });
  }
});

// 요구사항(2026-09-10 사용자 요청: "우선 지금 test로 되어있는 결과값들은 모두
// 삭제해줘"): 배포 확인용으로 만들었던 검색 작업들을 한 번에 정리하는 일회성
// 전체 삭제. 화면 버튼은 만들지 않고 관리자가 필요할 때 직접 호출한다.
router.delete("/bids/jobs", async (req, res) => {
  try {
    const result = await deleteAllJobs();
    res.json(result);
  } catch (error) {
    req.log.error({ err: error }, "Could not delete search history");
    res.status(500).json({ error: "검색 기록을 삭제하지 못했습니다." });
  }
});

router.get("/bids/jobs", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 30;
    const jobs = await listRecentJobs(limit);
    res.json({ jobs });
  } catch (error) {
    req.log.error({ err: error }, "Could not list search history");
    res.status(500).json({ error: "검색 기록을 불러오지 못했습니다." });
  }
});

router.get("/bids/jobs/:jobId/file", async (req, res) => {
  const notice = typeof req.query.notice === "string" ? req.query.notice : "";
  const relativePath = typeof req.query.path === "string" ? req.query.path : "";
  if (!notice || !relativePath) {
    res.status(400).json({ error: "notice, path 쿼리 값이 필요합니다." });
    return;
  }
  try {
    const filePath = await resolveAttachmentFile(req.params.jobId, notice, relativePath);
    // 요구사항(2026-09-11 사용자 요청: "첨부파일을 클릭하면 파일 이름이
    // 이상해. 나라장터에 올라온 파일명 그대로 다운로드 시켜줘"): res.sendFile만
    // 쓰면 Content-Disposition이 없어, 브라우저가 열 수 없는 형식(예: hwp)은
    // 미리보기 대신 자동 다운로드되면서 URL 경로("file")를 저장 파일명으로
    // 써버려 확장자까지 사라진다("이상한 파일"로 보이는 원인). 디스크에 저장된
    // 파일명(나라장터 원본 파일명을 sanitizeName만 거친 것)을 그대로 저장
    // 파일명으로 지정하되, PDF 등 미리보기 가능한 형식은 계속 새 탭에서 바로
    // 열리도록 inline을 쓴다.
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
    );
    res.sendFile(filePath);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "파일을 찾을 수 없습니다." });
  }
});

router.post("/bids/jobs/:jobId/retry", async (req, res) => {
  try {
    const job = await retryFailedCollectionJob(req.params.jobId);
    res.status(202).json({
      jobId: job.jobId, status: job.status, totalCount: job.totalCount, completedCount: job.completedCount,
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "실패 공고를 재처리하지 못했습니다." });
  }
});

router.get("/bids/jobs/:jobId", async (req, res) => {
  const params = GetBidCollectionStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "작업을 찾을 수 없습니다." });
    return;
  }
  const job = await getCollectionJob(params.data.jobId);
  if (!job) {
    res.status(404).json({ error: "작업을 찾을 수 없습니다." });
    return;
  }
  res.json(GetBidCollectionStatusResponse.parse(job));
});

router.get("/bids/jobs/:jobId/archive", async (req, res) => {
  const job = await getCollectionJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "작업을 찾을 수 없습니다." });
    return;
  }
  try {
    const archivePath = await buildArchive(job);
    res.type("application/zip");
    sendDownload(res, archivePath, "나라장터_공고첨부파일.zip");
  } catch (error) {
    req.log.error({ err: error, jobId: job.jobId }, "Could not build bid archive");
    res.status(500).json({ error: "첨부파일 ZIP을 만들지 못했습니다." });
  }
});

router.get("/bids/jobs/:jobId/results.csv", async (req, res) => {
  const job = await getCollectionJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "작업을 찾을 수 없습니다." });
    return;
  }
  res.type("text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent("나라장터_키워드검색결과.csv")}`,
  );
  res.send(buildCsv(job));
});

router.get("/bids/jobs/:jobId/results.xlsx/status", async (req, res) => {
  const job = await getCollectionJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ ready: false, error: "작업을 찾을 수 없습니다." });
    return;
  }
  try {
    await buildXlsx(job);
    res.json({ ready: true, error: null });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "알 수 없는 파일 생성 오류";
    req.log.error({ err: error, jobId: job.jobId }, "Could not prepare result workbook");
    res.status(500).json({ ready: false, error: `검색 결과 XLSX 생성 실패: ${reason}` });
  }
});

router.get("/bids/jobs/:jobId/results.xlsx", async (req, res) => {
  const job = await getCollectionJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "작업을 찾을 수 없습니다." });
    return;
  }
  try {
    const xlsxPath = await buildXlsx(job);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    sendDownload(res, xlsxPath, "나라장터_키워드검색결과.xlsx");
  } catch (error) {
    req.log.error({ err: error, jobId: job.jobId }, "Could not build result workbook");
    res.status(500).json({ error: "검색 결과 XLSX를 만들지 못했습니다." });
  }
});

export default router;
