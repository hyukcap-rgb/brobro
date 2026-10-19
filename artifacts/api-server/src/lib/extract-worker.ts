// 워커 스레드 엔트리: 첨부파일 하나의 텍스트를 추출해 부모에게 돌려준다.
// extract-runner.ts가 파일마다 새 워커를 띄우고, 시간 초과 시 terminate()로
// 강제 종료한다 — 그래서 여기서 무엇이 오래 걸리더라도 웹 서버(메인 스레드)는
// 멈추지 않는다.
import { parentPort, workerData } from "node:worker_threads";
import { extractSegmentsInProcess, type ExtractedSegment } from "./extract-core";

const { filePath, maxTextChars, maxSegments } = workerData as {
  filePath: string;
  maxTextChars: number;
  maxSegments: number;
};

// 장애 대응(2026-10-19): 7/21~22 기간 재검색이 연속 3번 "서버 재시작"으로 실패.
// 원인은 넓은 엑셀 행 때문이었다: 행 문맥(itemContext)은 그 행의 셀마다 같은
// 문자열을 가리키지만, postMessage는 문자열을 셀 개수만큼 따로 복사한다. 칸이
// 수천 개인 행이면 (행 길이 × 셀 수)로 불어나, 메인 스레드가 결과를 풀다가 메인 힙
// 4GB를 넘겨 프로세스 전체가 OOM으로 죽었다(로그: ValueDeserializer → heap out of memory).
// 워커 힙 상한은 워커 안의 메모리만 막을 뿐 메인으로 넘어오는 결과 크기는 막지 못한다.
// → 행 문맥은 한 번씩만 보내고(contexts 배열 + 번호) 메인에서 같은 문자열을 다시
//   연결한다. 그래도 남는 비정상적으로 큰 결과는 글자 수·세그먼트 수 상한으로 자른다.
type WireSegment = Omit<ExtractedSegment, "itemContext"> & { ctx?: number };

function pack(segments: ExtractedSegment[]) {
  const contexts: string[] = [];
  const contextIndex = new Map<string, number>();
  const wire: WireSegment[] = [];
  let used = 0;
  let truncated = false;
  let originalChars = 0;
  for (const segment of segments) originalChars += segment.text.length;
  for (const { itemContext, ...rest } of segments) {
    if (wire.length >= maxSegments || used >= maxTextChars) {
      truncated = true;
      break;
    }
    let cost = rest.text.length;
    let ctx: number | undefined;
    if (itemContext !== undefined) {
      ctx = contextIndex.get(itemContext);
      if (ctx === undefined) {
        cost += itemContext.length;
        if (used + cost > maxTextChars) {
          truncated = true;
          break;
        }
        ctx = contexts.push(itemContext) - 1;
        contextIndex.set(itemContext, ctx);
      }
    }
    if (used + cost > maxTextChars) {
      wire.push({ ...rest, text: rest.text.slice(0, Math.max(0, maxTextChars - used)) });
      truncated = true;
      break;
    }
    used += cost;
    wire.push(ctx === undefined ? rest : { ...rest, ctx });
  }
  return { segments: wire, contexts, truncated, originalSegments: segments.length, originalChars };
}

extractSegmentsInProcess(filePath).then(
  (segments) => parentPort?.postMessage({ ok: true, ...pack(segments) }),
  (error: unknown) =>
    parentPort?.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }),
);
