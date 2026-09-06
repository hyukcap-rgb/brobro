import { Router, type IRouter } from "express";
import { GetScanParams, ListScansQueryParams } from "@workspace/api-zod";
import { getScanRun, listScanRuns } from "../lib/matches-store";
import { createPendingScanRun, executeScanRun } from "../lib/daily-scan";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function serializeRun(run: Awaited<ReturnType<typeof listScanRuns>>[number]) {
  return {
    ...run,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}

router.get("/scans", async (req, res) => {
  const params = ListScansQueryParams.safeParse(req.query);
  const limit = params.success ? params.data.limit : undefined;
  const scans = await listScanRuns(limit);
  res.json({ scans: scans.map(serializeRun) });
});

router.get("/scans/:id", async (req, res) => {
  const params = GetScanParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "실행 기록을 찾을 수 없습니다." });
    return;
  }
  const run = await getScanRun(params.data.id);
  if (!run) {
    res.status(404).json({ error: "실행 기록을 찾을 수 없습니다." });
    return;
  }
  res.json(serializeRun(run));
});

// 즉시 실행 요청은 실행 기록만 만들어 바로 202로 응답하고, 실제 스캔(첨부파일 다운로드/
// 파싱 포함, 수 분 소요 가능)은 백그라운드에서 진행한다. 진행 상황은 /scans 폴링으로 확인.
router.post("/scans/run", async (_req, res) => {
  try {
    const run = await createPendingScanRun("manual");
    void executeScanRun(run).catch((error) => {
      logger.error({ err: error, runId: run.id }, "Manual scan run failed");
    });
    res.status(202).json(serializeRun(run));
  } catch (error) {
    logger.error({ err: error }, "Could not start manual scan");
    res.status(500).json({ error: error instanceof Error ? error.message : "스캔을 시작하지 못했습니다." });
  }
});

export default router;
