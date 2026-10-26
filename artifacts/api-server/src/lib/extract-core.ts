// 첨부파일 텍스트 추출(순수 함수 모음, DB 의존성 없음).
//
// 장애 대응(2026-10-13 사고: 일별 스캔 중 특정 첨부파일 추출이 메인 스레드를
// 약 1시간 27분 동안 붙잡아 brog2b.com 전체가 응답 불능 — 전일에도 동일 증상).
// 이 모듈은 extract-worker.ts가 별도 워커 스레드에서 실행하며, 메인 스레드는
// extract-runner.ts를 통해 타임아웃을 걸고 호출한다. 그래서 이 파일은 DB/로거
// 등 서버 상태에 의존하면 안 된다.
import { execFile } from "node:child_process";
import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as unzipper from "unzipper";

const execFileAsync = promisify(execFile);

// 외부 명령(pdftotext, python 파서, antiword, strings, zip)이 손상 파일에서
// 끝나지 않는 경우를 막는 상한. 시간을 넘기면 SIGKILL로 강제 종료된다.
export const COMMAND_TIMEOUT_MS = 60_000;

// 엑셀 한 행의 문맥(itemContext) 최대 길이 — extractXlsx 주석 참고.
const MAX_ITEM_CONTEXT_CHARS = 4_000;

export interface ExtractedSegment {
  text: string;
  itemContext?: string;
  sheet: string | null;
  page: number | null;
  location: string;
  // 요구사항(2026-09-18 사용자 요청: "관급자재 에 키워드가 있는경우 검색하지
  // 않아도 됨 ... 이건 우리가 영업을 하지 못해"): 이 항목이 "관급자재"(발주기관이
  // 직접 공급 — 영업 대상 아님) 또는 "사급자재"(시공사가 직접 구매 — 영업 대상)
  // 구분 아래에 있는지. tagMaterialSections()가 문서 순서를 따라가며 채운다.
  section?: "관급자재" | "사급자재" | null;
}

export function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function stripXml(xml: string): string {
  return decodeXml(
    xml
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/(?:w:p|hp:p|p)>/g, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export async function command(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
  return result.stdout;
}

// 최적화(2026-09-22, 순수 리팩터링 — 동작 변화 없음): decodeText는 첨부파일
// 텍스트를 읽을 때마다 호출되는데, 매번 TextDecoder를 새로 만들 필요가 없다.
// 여기서는 { stream: true } 없이 매 호출을 완결된 단일 decode()로 쓰므로
// 인스턴스에 스트리밍 상태가 남지 않아 재사용해도 결과는 이전과 동일하다.
const UTF8_TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });
const EUCKR_TEXT_DECODER = new TextDecoder("euc-kr", { fatal: false });

function decodeText(bytes: Buffer): string {
  const utf8 = UTF8_TEXT_DECODER.decode(bytes);
  const replacementRatio = (utf8.match(/\uFFFD/g)?.length ?? 0) / Math.max(utf8.length, 1);
  if (replacementRatio < 0.01) return utf8;
  try {
    return EUCKR_TEXT_DECODER.decode(bytes);
  } catch {
    return utf8;
  }
}

const MAX_ZIP_ENTRY_BYTES = Number(process.env.MAX_ZIP_ENTRY_BYTES) || 200 * 1024 * 1024;

async function openZip(filePath: string): Promise<unzipper.CentralDirectory> {
  try {
    return await unzipper.Open.file(filePath);
  } catch (error) {
    throw new Error(
      `ZIP 컨테이너를 읽지 못했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
    );
  }
}

async function unzipText(
  archive: unzipper.CentralDirectory,
  entryPath: string,
): Promise<string> {
  const entry = archive.files.find((candidate) => candidate.path === entryPath);
  if (!entry || entry.type === "Directory") return "";
  // 장애 대응(2026-10-15): 7/15~16 기간 재검색 중 서버 프로세스가 오류 로그 없이
  // 두 번 죽었다(같은 지점, 메모리 지표상 순간 급증 의심). 압축 해제 후 크기가
  // 비정상적으로 큰 항목(압축 폭탄·손상 파일)을 통째로 메모리에 풀지 않고 건너뛴다.
  const uncompressedSize = Number(entry.uncompressedSize ?? 0);
  if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
    throw new Error(
      `압축 해제 크기가 너무 큰 항목이라 건너뜀: ${entryPath} (${Math.round(uncompressedSize / 1024 / 1024)}MB)`,
    );
  }
  return decodeText(await entry.buffer());
}

// 요구사항(2026-09-26 사용자 리포트: "부직포" 키워드가 이 공사에 실제로는
// 쓰이지 않는데도 매칭됨 — "여기 키워드 말고 2200이 검색되었다고 하는데.
// 파일에는 내용이 없다고. 어디에 있는거야?"): 실제로는 2200이라는 값이
// 파일 안에 있었지만("재료비" 시트 D29 셀), 그건 이 공사의 실제 물량이
// 아니라 "700g/㎡ 사면보호용 부직포의 단가가 ㎡당 2,200원"이라는 뜻의
// 참고용 자재 단가 정보였다(시멘트 40kg/포=6,500원, ㎏ 단위=162.5원처럼
// 단가 환산이 맞아떨어지는 것으로 확인). 설계내역서 엑셀에는 이런 식으로
// "재료비/단가표" 성격의 참고용 시트가 항상 딸려 나오는 경우가 많은데,
// 이 시트들은 이 공사에서 실제로 쓰는 자재와 무관하게 표준 단가 데이터베이스
// 전체를 나열해두기 때문에, 여기서 키워드가 매칭되면 "실제로는 안 쓰는
// 자재인데 리드로 뜨는" 오탐이 생긴다. 사용자 확인(AskUserQuestion, 2026-09-26
// "재료비/단가표 시트는 매칭에서 제외") 후, 시트 이름으로 이런 참고용 단가
// 시트를 걸러낸다. 내부 파일명(xl/worksheets/sheetN.xml)은 실제 시트 이름을
// 담지 않으므로, xl/workbook.xml + xl/_rels/workbook.xml.rels를 함께 읽어
// 실제 시트 이름을 구한다(덤으로 위치 표시도 "sheet16!D29" 대신
// "재료비!D29"처럼 사람이 읽을 수 있게 개선된다).
//
// 추가 사례(2026-10-26 사용자 리포트: "부직포 사이즈가 다 똑같은데 왜
// 그런거야" — 전국 20개 지역 "주거환경개선공사" 낙찰 건이 전부 부직포
// "3324 M2"로 동일하게 나옴): 이번엔 "일위대가"/"일위대가목록"이라는 숨김
// 시트가 원인이었다. "일위대가"는 "이 공법(예: 도배(본드))을 쓰면 단위(M2)당
// 단가가 얼마"라는 표준 단가 산출 근거표라서, 실제 이 공사의 물량과 무관하게
// 전국 어디서나 같은 숫자가 나온다 — 실제로 확인해보니 이 공사는 부직포를
// 아예 쓰지 않았다(공종별내역서의 실제 수량·금액 칸이 0). 시트 이름에
// "일위대가"를 추가로 거른다.
const EXCLUDED_REFERENCE_SHEET_PATTERN = /단가|재료비|유가정보|운반거리조견표|일위대가/;

// 요구사항(2026-10-26, 위와 같은 리포트): 같은 파일의 "공종별내역서"라는
// 시트(제목 셀이 스스로 "[ 원가 분석용 자료 ]"라고 밝히고 있다)는 이름만으로는
// 위 패턴에 걸리지 않는다 — 적산 프로그램마다 이런 참고용 시트 이름이
// 제각각이라(설계사무소/발주기관별로 템플릿이 다름) 이름 목록을 무한정 늘리는
// 데는 한계가 있다. 그래서 이름 패턴과 별개로, 시트 맨 앞 몇 행에 "원가
// 분석용 자료" 같은 자기선언 문구가 있으면(실제 제출용 물량내역서에는 이런
// 문구가 없다) 시트 이름과 무관하게 그 시트 전체를 건너뛴다 — 더 일반적인
// 안전장치다. 앞부분 몇 행만 보는 건 성능 때문(위 2026-10-13/19 장애 대응
// 주석 참고 — 행마다 빈 셀이 수천~수만 개인 엑셀도 다뤄야 한다).
const REFERENCE_ONLY_CONTENT_MARKER_PATTERN = /원가\s*분석용\s*자료/;
const CONTENT_MARKER_SCAN_ROW_LIMIT = 5;

function isReferenceOnlyContentSheet(
  rowMatches: RegExpMatchArray[],
  sharedStrings: string[],
): boolean {
  for (const row of rowMatches.slice(0, CONTENT_MARKER_SCAN_ROW_LIMIT)) {
    if (row[1] === undefined) continue;
    for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = cell[2];
      if (body === undefined) continue;
      const type = /\bt="([^"]+)"/.exec(cell[1])?.[1] ?? "";
      let text = "";
      if (type === "s") {
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? -1);
        text = sharedStrings[index] ?? "";
      } else if (type === "inlineStr") {
        text = stripXml(body);
      }
      if (text && REFERENCE_ONLY_CONTENT_MARKER_PATTERN.test(text)) return true;
    }
  }
  return false;
}

async function resolveSheetNames(archive: unzipper.CentralDirectory): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const relsXml = await unzipText(archive, "xl/_rels/workbook.xml.rels");
    const ridToTarget = new Map<string, string>();
    for (const rel of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
      const attrs = rel[1];
      const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
      const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
      if (id && target) ridToTarget.set(id, target);
    }
    const workbookXml = await unzipText(archive, "xl/workbook.xml");
    for (const sheetTag of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
      const attrs = sheetTag[1];
      const name = /\bname="([^"]*)"/.exec(attrs)?.[1];
      const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1];
      if (!name || !rid) continue;
      const target = ridToTarget.get(rid);
      if (!target) continue;
      // target은 보통 "worksheets/sheet16.xml"(가끔 앞에 "/xl/"가 붙음)
      // 형태다 — 내부 파일명("sheet16")만 뽑아 매핑 키로 쓴다.
      const internalName = path.basename(target, ".xml");
      map.set(internalName, decodeXml(name));
    }
  } catch {
    // workbook.xml 파싱에 실패해도 전체 추출이 막히면 안 되므로 빈 맵으로
    // 넘어간다 — 이 경우 시트 이름 대신 내부 파일명("sheet1")이 쓰이고,
    // 참고용 단가 시트 제외 필터도 적용되지 않는다(기존 동작과 동일, 안전한
    // 폴백).
  }
  return map;
}

async function extractXlsx(filePath: string): Promise<ExtractedSegment[]> {
  const archive = await openZip(filePath);
  const entries = archive.files.map((entry) => entry.path);
  const sharedXml = await unzipText(archive, "xl/sharedStrings.xml");
  // 빈 공유 문자열(<si/>)도 인덱스 하나를 차지하므로 건너뛰지 않고 ""로 둔다.
  const sharedStrings = [...sharedXml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((match) =>
    match[1] === undefined ? "" : stripXml(match[1]),
  );
  const sheetNameMap = await resolveSheetNames(archive);
  const sheets = entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry));
  const segments: ExtractedSegment[] = [];
  for (const sheetEntry of sheets) {
    const internalSheetName = path.basename(sheetEntry, ".xml");
    const sheetName = sheetNameMap.get(internalSheetName) ?? internalSheetName;
    if (EXCLUDED_REFERENCE_SHEET_PATTERN.test(sheetName)) continue;
    const xml = await unzipText(archive, sheetEntry);
    // 빈 행도 <row r="5" s="2" customFormat="1"/>처럼 자체 닫힘으로 나온다 —
    // 예전 패턴은 이걸 다음 행 내용과 한 행으로 묶어버렸다(아래 셀 패턴과 같은 원인).
    const rowMatches = [...xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)];
    if (isReferenceOnlyContentSheet(rowMatches, sharedStrings)) continue;
    for (const row of rowMatches) {
      if (row[1] === undefined) continue;
      const cells: { address: string; text: string }[] = [];
      // 장애 대응(2026-10-13): 예전 패턴 /<c\b([^>]*)>([\s\S]*?)<\/c>/ 는 빈 서식
      // 셀(<c r="A1" s="5"/>, 자체 닫힘)을 처리하지 못해 매 셀마다 행 끝까지 다음
      // "</c>"를 찾아 훑었다 — 행에 빈 셀이 N개면 O(N²). 열 전체(XFD까지)에 서식이
      // 걸린 내역서 엑셀은 행마다 빈 셀이 수천~1만 개라 한 행에 1초 이상, 시트
      // 전체로는 수십 분~수 시간 동안 CPU를 붙잡아 서버가 멈췄다(실측: 빈 셀
      // 16,000개짜리 한 행에 1,031ms → 수정 후 5ms). 자체 닫힘 셀을 별도
      // 대안으로 받아 선형 시간에 끝나게 한다. 덤으로, 빈 셀 뒤의 실제 셀이
      // 앞의 빈 셀 주소로 잘못 묶이던 문제도 함께 사라진다.
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const body = cell[2];
        if (body === undefined) continue;
        const address = /\br="([^"]+)"/.exec(cell[1])?.[1] ?? "셀";
        const type = /\bt="([^"]+)"/.exec(cell[1])?.[1] ?? "";
        let text = "";
        if (type === "s") {
          const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? -1);
          text = sharedStrings[index] ?? "";
        } else if (type === "inlineStr") {
          text = stripXml(body);
        } else {
          text = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "").trim();
        }
        if (text) cells.push({ address, text });
      }
      // 장애 대응(2026-10-19): 행 문맥(itemContext)은 그 행의 셀마다 같은 문자열을
      // 붙이는데, 워커→메인으로 넘길 때 셀 개수만큼 복사된다. 칸이 수백~수천 개
      // 채워진 넓은 행이면 (행 길이 × 셀 수)로 불어나 메인 힙 4GB를 넘겨 서버가
      // 죽었다. 행 문맥은 표시·주변 글 용도라 앞부분이면 충분하므로 길이를 자른다.
      const fullContext = cells.map((cell) => `${cell.address}=${cell.text}`).join(" | ");
      const itemContext =
        fullContext.length > MAX_ITEM_CONTEXT_CHARS ? fullContext.slice(0, MAX_ITEM_CONTEXT_CHARS) : fullContext;
      for (const cell of cells) {
        segments.push({
          text: cell.text,
          itemContext,
          sheet: sheetName,
          page: null,
          location: `${sheetName}!${cell.address}`,
        });
      }
    }
  }
  return segments;
}

async function extractOfficeXml(
  filePath: string,
  matcher: RegExp,
  label: string,
): Promise<ExtractedSegment[]> {
  const archive = await openZip(filePath);
  const entries = archive.files.map((entry) => entry.path).filter((entry) => matcher.test(entry));
  const segments: ExtractedSegment[] = [];
  for (const entry of entries) {
    const xml = await unzipText(archive, entry);
    const paragraphs = xml
      .split(/<\/(?:w:p|hp:p|p)>/i)
      .map(stripXml)
      .filter(Boolean);
    paragraphs.forEach((text, index) => {
      segments.push({
        text,
        sheet: null,
        page: null,
        location: `${label} ${path.basename(entry)} 문단 ${index + 1}`,
      });
    });
  }
  return segments;
}

async function extractPdf(filePath: string): Promise<ExtractedSegment[]> {
  const handle = await open(filePath, "r");
  const header = Buffer.alloc(8);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    const printableHeader = header.toString("ascii").replace(/[^\x20-\x7e]/g, ".");
    throw new Error(
      `PDF 확장자이나 실제 파일 헤더가 PDF(%PDF-)가 아닙니다 (헤더: ${printableHeader}).`,
    );
  }
  const target = `${filePath}.txt`;
  await command("pdftotext", ["-layout", filePath, target]);
  // 최적화(2026-09-22, 순수 리팩터링 — 동작 변화 없음): readFile이 실패하면
  // 아래 rm이 실행되지 않아 임시 .txt 파일이 남는 누수가 있었다. try/finally로
  // 감싸 성공/실패 어느 경우에도 항상 정리되게 했다 — 성공 경로의 반환값은
  // 이전과 동일하다.
  let text: string;
  try {
    text = decodeText(await readFile(target));
  } finally {
    await rm(target, { force: true });
  }
  return text.split("\f").flatMap((pageText, pageIndex) =>
    pageText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, lineIndex) => ({
        text: line,
        sheet: null,
        page: pageIndex + 1,
        location: `${pageIndex + 1}페이지 ${lineIndex + 1}행`,
      })),
  );
}

async function extractLegacy(filePath: string, extension: string): Promise<ExtractedSegment[]> {
  if (extension === ".xls") {
    // Resolved relative to this module's own location (not process.cwd(), which
    // is the container WORKDIR and does not match where this file lives once
    // bundled) so the script is found regardless of the process start directory.
    const scriptPath = path.resolve(import.meta.dirname, "..", "scripts", "extract-xls.py");
    try {
      return JSON.parse(await command("python3", [scriptPath, filePath])) as ExtractedSegment[];
    } catch (error) {
      throw new Error(`XLS 셀 파싱 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const outputs: string[] = [];
  if (extension === ".doc") {
    try {
      outputs.push(await command("antiword", [filePath]));
    } catch {
      // Fall through to strings extraction.
    }
  }
  for (const args of [["-a", filePath], ["-a", "-el", filePath]]) {
    try {
      outputs.push(await command("strings", args));
    } catch {
      // A partial extraction is still useful.
    }
  }
  return outputs
    .join("\n")
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter((text) => text.length > 1)
    .map((text, index) => ({
      text,
      sheet: null,
      page: null,
      location: `추출 문자열 ${index + 1}`,
    }));
}

type ContainerKind = "ole" | "zip" | "pdf" | "other";

// 확장자가 아니라 파일 앞 8바이트로 실제 컨테이너 종류를 판별한다.
// 실측(2026-09-13, 국가철도공단 공고 2026-03-000199 첨부): 확장자가 .hwpx인데
// 내용은 HWP 5.0 OLE 바이너리인 파일이 존재한다. 확장자만 믿으면 이런 파일을
// ZIP으로 열려다 BadZipFile로 실패해 본문이 통째로 검색에서 빠진다. 기관 사이트가
// Content-Type을 application/x-msdownload로 내려주는 경우도 흔해 MIME도 믿을 수
// 없다 — 신뢰할 수 있는 건 파일 내용뿐이다.
async function sniffContainer(filePath: string): Promise<ContainerKind> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, 8, 0);
    if (bytesRead >= 4) {
      if (buffer.readUInt32BE(0) === 0xd0cf11e0) return "ole";
      if (buffer[0] === 0x50 && buffer[1] === 0x4b) return "zip";
      if (buffer.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
    }
    return "other";
  } finally {
    await handle.close();
  }
}

// HWP 5.0은 본문(BodyText)이 zlib(raw deflate)으로 압축된 OLE 스트림이라,
// extractLegacy의 `strings` 방식으로는 스트림 이름과 목차 번호 정도만 나온다
// (실측: 4,468자짜리 구매시방서에서 strings 출력은 88줄 전부 무의미한 문자열).
// 부직포 같은 자재명은 대부분 시방서·내역서 본문과 표 안에 있으므로, HWP 첨부만
// 있는 공고는 이 구조에서 매칭이 원천적으로 불가능했다. olefile로 BodyText를
// 풀어 문단 단위로 추출한다.
async function extractHwp5(filePath: string): Promise<ExtractedSegment[]> {
  const scriptPath = path.resolve(import.meta.dirname, "..", "scripts", "extract-hwp.py");
  try {
    return JSON.parse(await command("python3", [scriptPath, filePath])) as ExtractedSegment[];
  } catch (error) {
    throw new Error(`HWP 본문 파싱 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 요구사항(2026-09-18 사용자 요청: "관급자제 에 키워드가 있는경우 검색하지
// 않아도 됨. 키워드가 관급자제 아래 검색하려는 키워드가 있는경우 삭제
// 해줘.이건 우리가 영업을 하지 못해"): 내역서(엑셀 행, PDF/HWP/DOCX 표나 문단)는
// 보통 "관급자재"/"사급자재" 같은 구분 행(또는 그 줄만 단독으로 있는 라벨)이
// 나오고 그 아래로 여러 항목이 이어지는 구조다. extractXxx가 만드는 segments는
// 항상 문서에 나온 순서 그대로이므로(엑셀은 시트 안에서 행 순서, PDF/HWP/DOCX는
// 문단/줄 순서), 그 순서를 따라가며 "지금 어느 구분 아래인지"를 갱신하면 별도
// 포맷별 파싱 없이도 전체 포맷에 동일하게 적용할 수 있다. 시트가 바뀌면(새
// 내역서/새 표) 상태를 초기화한다.
function tagMaterialSections(segments: ExtractedSegment[]): void {
  let current: "관급자재" | "사급자재" | null = null;
  let currentSheet: string | null | undefined;
  let sheetSeen = false;
  for (const segment of segments) {
    if (!sheetSeen || segment.sheet !== currentSheet) {
      current = null;
      currentSheet = segment.sheet;
      sheetSeen = true;
    }
    const label = segment.text.trim().replace(/[:：]\s*$/, "");
    if (label === "관급자재" || label === "관급") {
      current = "관급자재";
    } else if (label === "사급자재" || label === "사급") {
      current = "사급자재";
    }
    segment.section = current;
  }
}

async function extractSegmentsImpl(filePath: string): Promise<ExtractedSegment[]> {
  const extension = path.extname(filePath).toLowerCase();
  // 컨테이너 종류를 먼저 보고, 확장자는 같은 컨테이너 안에서 포맷을 고르는
  // 용도로만 쓴다 (sniffContainer 주석 참고).
  const container = await sniffContainer(filePath);

  if (container === "pdf") return extractPdf(filePath);

  if (container === "ole") {
    if (extension === ".xls") return extractLegacy(filePath, ".xls");
    if (extension === ".doc") return extractLegacy(filePath, ".doc");
    // .hwp / .hwpx / 확장자가 엉뚱한 경우까지 전부 HWP 5.0으로 본다.
    try {
      return await extractHwp5(filePath);
    } catch {
      // 암호화된 HWP 등 파서가 못 여는 경우에도 최소한 문자열은 건진다.
      return extractLegacy(filePath, ".hwp");
    }
  }

  if (container === "zip") {
    // 묶음 ZIP은 extractZipRecursively가 먼저 풀어 개별 파일로 들어온다.
    if (extension === ".zip") return [];
    if ([".xlsx", ".xlsm"].includes(extension)) return extractXlsx(filePath);
    if (extension === ".docx") {
      return extractOfficeXml(filePath, /^word\/document\.xml$/i, "DOCX");
    }
    return extractOfficeXml(filePath, /^(?:Contents|contents)\/section\d+\.xml$/, "HWPX");
  }

  if ([".csv", ".txt", ".xml"].includes(extension)) {
    const text = decodeText(await readFile(filePath));
    return text.split(/\r?\n/).map((line, index) => ({
      text: line,
      sheet: extension === ".csv" ? "CSV" : null,
      page: null,
      location: `${index + 1}행`,
    }));
  }
  return [];
}

export async function extractSegmentsInProcess(filePath: string): Promise<ExtractedSegment[]> {
  const segments = await extractSegmentsImpl(filePath);
  tagMaterialSections(segments);
  return segments;
}
