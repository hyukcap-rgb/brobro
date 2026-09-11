import { Router, type IRouter } from "express";
import { GetScanParams, ListScansQueryParams, TriggerScanBody } from "@workspace/api-zod";
import { deleteAllScanData, getScanRun, listScanRuns } from "../lib/matches-store";
import { createPendingScanRun, executeScanRun, ScanAlreadyRunningError } from "../lib/daily-scan";
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

// 요구사항(2026-09-10 사용자 요청: "우선 지금 test로 되어있는 결과값들은 모두
// 삭제해줘"): 배포 확인용으로 수동 실행했던 스캔 기록 + 그로 인한 매칭 결과를
// 한 번에 정리하는 일회성 전체 삭제. 화면 버튼은 만들지 않고 관리자가 필요할
// 때 직접 호출한다.
router.delete("/scans", async (_req, res) => {
  const result = await deleteAllScanData();
  res.json(result);
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
// 요구사항(기간 검색, 2026-09-09 사용자 요청: "이날짜로 검색은 검색 기간을
// 내가 설정하는거야"): body.startDate(YYYY-MM-DD)만 주면 그 하루만, startDate+
// endDate를 함께 주면 그 기간(포함) 전체를 정확히 재검색한다. 둘 다 생략하면
// 기존 자동 로직(전일 기준 + 미완료 구간 자동 보충)을 그대로 사용한다.
const MAX_MANUAL_RANGE_DAYS = 31;

function daysInclusive(startKey: string, endKey: string): number {
  const start = new Date(`${startKey}T00:00:00Z`);
  const end = new Date(`${endKey}T00:00:00Z`);
  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

router.post("/scans/run", async (req, res) => {
  const input = TriggerScanBody.safeParse(req.body ?? {});
  if (!input.success) {
    res.status(400).json({ error: "날짜 형식을 확인해 주세요 (YYYY-MM-DD)." });
    return;
  }
  const { startDate, endDate } = input.data;
  let explicitRange: { start: string; end: string } | undefined;
  if (startDate) {
    const rangeEnd = endDate || startDate;
    if (rangeEnd < startDate) {
      res.status(400).json({ error: "종료일이 시작일보다 빠를 수 없습니다." });
      return;
    }
    if (daysInclusive(startDate, rangeEnd) > MAX_MANUAL_RANGE_DAYS) {
      res.status(400).json({ error: `검색 기간은 최대 ${MAX_MANUAL_RANGE_DAYS}일까지 지정할 수 있습니다.` });
      return;
    }
    explicitRange = { start: startDate, end: rangeEnd };
  }
  try {
    const run = await createPendingScanRun("manual", explicitRange);
    // 요구사항(2026-09-11 사용자 지적: 나라장터 "검색유형=최종낙찰자" 화면도
    // 개찰일자로 조회한다 — "최종낙찰자가 있는 건 중 개찰일을 기준으로 검색하면
    // 모든게 해결되잖아... 모든것의 기준이야"): "지금 실행"과 "이 기간으로 검색"
    // 모두 개찰일 기준 조회 + 낙찰자 확정 건만 남기는 동일한 기준을 쓰므로 더 이상
    // 옵션을 분기하지 않는다(daily-scan.ts executeScanRun 참고).
    void executeScanRun(run).catch((error) => {
      logger.error({ err: error, runId: run.id }, "Manual scan run failed");
    });
    res.status(202).json(serializeRun(run));
  } catch (error) {
    if (error instanceof ScanAlreadyRunningError) {
      // 요구사항(2026-09-11): 동시 실행을 API 호출 낭비 없이 막았다는 신호이지
      // 서버 오류가 아니므로 500이 아닌 409(Conflict)로 명확히 구분한다.
      res.status(409).json({ error: "이미 다른 스캔이 진행 중입니다. 완료된 후 다시 시도해 주세요." });
      return;
    }
    logger.error({ err: error }, "Could not start manual scan");
    res.status(500).json({ error: error instanceof Error ? error.message : "스캔을 시작하지 못했습니다." });
  }
});

export default router;
