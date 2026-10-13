// 워커 스레드 엔트리: 첨부파일 하나의 텍스트를 추출해 부모에게 돌려준다.
// extract-runner.ts가 파일마다 새 워커를 띄우고, 시간 초과 시 terminate()로
// 강제 종료한다 — 그래서 여기서 무엇이 오래 걸리더라도 웹 서버(메인 스레드)는
// 멈추지 않는다.
import { parentPort, workerData } from "node:worker_threads";
import { extractSegmentsInProcess } from "./extract-core";

const { filePath } = workerData as { filePath: string };

extractSegmentsInProcess(filePath).then(
  (segments) => parentPort?.postMessage({ ok: true, segments }),
  (error: unknown) =>
    parentPort?.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }),
);
