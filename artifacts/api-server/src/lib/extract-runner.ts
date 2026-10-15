// 첨부파일 텍스트 추출을 워커 스레드에서 타임아웃을 걸고 실행한다.
//
// 장애 대응(2026-10-13 사고): 일별 스캔이 공고 R26BK01607506-000 처리 직후의
// 첨부파일 하나에서 텍스트 추출이 CPU를 1시간 27분 동안 붙잡았다(KST 09:38~11:05).
// 추출이 메인 스레드에서 돌았기 때문에 그동안 웹 요청이 하나도 처리되지 못해
// brog2b.com이 접속 불능이었다(전일에도 같은 증상). 원인은 .xlsx 셀 파싱
// 정규식의 O(N²) 동작(extract-core.ts extractXlsx 주석 참고)이었지만, 앞으로
// 어떤 손상/비정상 파일이 와도 서버가 멈추지 않도록 추출 자체를 격리한다:
//   - 파일마다 새 워커 스레드에서 추출 → 메인 스레드는 계속 요청 처리
//   - EXTRACT_TIMEOUT_MS(기본 120초)를 넘기면 워커를 강제 종료하고 에러를 던짐
//     → 호출부(일별 스캔/수동 검색)는 기존처럼 "추출 실패"로 그 파일만 건너뜀
//   - 오래 걸린 파일·시간 초과 파일은 파일명/크기와 함께 로그로 남겨 원인 파일을
//     바로 특정할 수 있게 함
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { extractSegmentsInProcess, type ExtractedSegment } from "./extract-core";
import { logger } from "./logger";

export const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS) || 120_000;
const SLOW_EXTRACT_LOG_MS = 15_000;
const WORKER_MAX_OLD_GEN_MB = Number(process.env.EXTRACT_WORKER_MAX_OLD_GEN_MB) || 1024;

// 빌드 산출물은 dist/index.mjs 옆에 dist/extract-worker.mjs로 나온다(build.mjs).
const WORKER_PATH = path.resolve(import.meta.dirname, "extract-worker.mjs");

export class ExtractTimeoutError extends Error {
  constructor(fileName: string, timeoutMs: number) {
    super(`첨부파일 텍스트 추출 시간 초과(${Math.round(timeoutMs / 1000)}초): ${fileName}`);
    this.name = "ExtractTimeoutError";
  }
}

function runInWorker(filePath: string, timeoutMs: number): Promise<ExtractedSegment[]> {
  return new Promise((resolve, reject) => {
    // 워커 힙 상한: 비정상 파일이 메모리를 폭주시켜도 워커만 죽고(ERR_WORKER_OUT_OF_MEMORY)
    // 웹 서버 프로세스 전체는 살아남게 한다.
    const worker = new Worker(WORKER_PATH, {
      workerData: { filePath },
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GEN_MB },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new ExtractTimeoutError(path.basename(filePath), timeoutMs)));
    }, timeoutMs);
    worker.once("message", (message: { ok: boolean; segments?: ExtractedSegment[]; message?: string }) => {
      finish(() =>
        message.ok ? resolve(message.segments ?? []) : reject(new Error(message.message ?? "추출 실패")),
      );
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      finish(() => reject(new Error(`추출 워커가 비정상 종료되었습니다(exit ${code}).`)));
    });
  });
}

export async function extractSegments(
  filePath: string,
  timeoutMs = EXTRACT_TIMEOUT_MS,
): Promise<ExtractedSegment[]> {
  // 로컬 개발 등 워커 번들이 없는 환경에서는 예전처럼 같은 스레드에서 추출한다.
  if (!existsSync(WORKER_PATH)) return extractSegmentsInProcess(filePath);

  const fileName = path.basename(filePath);
  const sizeBytes = await stat(filePath).then((info) => info.size, () => null);
  const startedAt = Date.now();
  // 장애 대응(2026-10-15): 프로세스가 로그 없이 죽으면 어떤 파일이 원인인지 알 수
  // 없었다. 추출 직전에 파일명을 남겨, 다음에 죽으면 마지막 줄로 원인 파일을 특정한다.
  logger.info({ fileName, sizeBytes }, "첨부파일 추출 시작");
  try {
    const segments = await runInWorker(filePath, timeoutMs);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= SLOW_EXTRACT_LOG_MS) {
      logger.warn({ fileName, sizeBytes, elapsedMs, segmentCount: segments.length }, "첨부파일 텍스트 추출이 오래 걸림");
    }
    return segments;
  } catch (error) {
    if (error instanceof ExtractTimeoutError) {
      logger.error({ fileName, sizeBytes, timeoutMs }, "첨부파일 텍스트 추출 시간 초과 — 워커 강제 종료, 이 파일은 건너뜀");
    } else {
      logger.warn({ fileName, sizeBytes, err: error }, "첨부파일 텍스트 추출 실패 — 이 파일은 건너뜀");
    }
    throw error;
  }
}
