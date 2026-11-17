// brog2b 이식(2026-11-17 사용자 요청 "옮겨"): narafile(brog2b-v2)의 doc-rows.ts를 그대로 가져왔다.
// 표의 머리행(품명·규격·단위·수량)으로 칸을 정해 행을 읽는다 — 자동검색 소요량 판정에 쓴다.
// 첨부파일을 "행" 단위로 읽는다(2026-10-30, 키워드 정밀 매칭 설계).
//
// 예전에는 첨부를 텍스트로 통째로 풀고 글자만 찾았다. 그래서 숨김 시트의 표준 일위대가, 단가표, 쓰이지 않는
// 호표, 시방서의 일반 조항, 다른 품목의 규격 칸까지 모두 "키워드 있음"이 됐다(사용자 지적: "첨부파일에 있다고
// 다 걸러내는 건 정말 불필요"). 여기서는 내역서의 행(품명·규격·단위·수량·금액)을 살려서 뽑고,
// keyword-evidence.ts가 그 행으로 "이 공사에 실제로 들어가는가"를 판정한다.
//
// 이 파일은 자식 프로세스(extract-child)에서 돈다 — DB·로거에 의존하지 않는다.
import { execFile } from "node:child_process";
import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as unzipper from "unzipper";
import { decodeXml, extractSegmentsInProcess, stripXml } from "./extract-core";

const execFileAsync = promisify(execFile);

export type DocType = "boq" | "qty" | "ilwi" | "price" | "spec" | "notice" | "drawing" | "other";

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  boq: "내역서",
  qty: "물량산출서",
  ilwi: "일위대가",
  price: "단가표",
  spec: "시방서·과업",
  notice: "공고·서식",
  drawing: "도면",
  other: "기타",
};

export interface DocRow {
  f: string; // 압축 안 파일 이름(압축이 아니면 첨부 이름)
  dt: DocType;
  sh: string | null; // 시트·표 이름
  r: number; // 행·줄 번호(1부터)
  p?: number | null; // PDF 쪽
  k: "row" | "line"; // row = 머리행으로 열을 대응시킨 표 행, line = 문단·줄
  t: string; // 보이는 칸을 이은 글(최대 400자)
  ht?: string; // 숨김 열에만 있는 글
  hid?: 1; // 숨김 시트·숨김 행
  item?: string;
  spec?: string;
  unit?: string;
  qty?: number | null;
  amt?: number | null;
  ho?: string; // 일위대가: 이 행이 속한 호표(예: "호12", "산3")
  ref?: string[]; // 내역서: 이 행이 가리키는 호표
  sum?: 1; // 소계·합계 행
  hd?: 1; // 머리행
}

// ---------- 문서 종류 ----------
const DOC_PATTERNS: [DocType, RegExp][] = [
  ["qty", /수량\s*산출|물량\s*산출|자재\s*집계|수량\s*집계|물량\s*집계|수량\s*총괄|산출\s*조서|물량\s*내역/],
  ["ilwi", /일\s*위|호\s*표|산\s*근|단가\s*산출|산출\s*근거/],
  ["price", /단\s*가|견\s*적|재료비|유가|운반\s*거리|노\s*임|기계\s*경비|자재\s*표|자재\s*목록|시중\s*가|조사\s*가격|가격\s*조사/],
  ["boq", /내\s*역|설계서|원가|총\s*괄|공종|공사비|도급|산출\s*내역|BOQ|boq/],
  ["spec", /시\s*방|과업|지\s*침|규격|사양|명세|설명서|제안\s*요청|요구\s*사항|기술\s*기준/],
  ["notice", /공\s*고|유의|입찰|계약|안\s*내|서\s*식|청렴|확약|각서|신청서|제출|약관/],
  ["drawing", /도\s*면|평면도|단면도|상세도|배치도|\.dwg|\.dxf/i],
];

export function docTypeOf(name: string): DocType | null {
  for (const [dt, re] of DOC_PATTERNS) if (re.test(name)) return dt;
  return null;
}

// ---------- 머리행·열 대응 ----------
const compact = (s: string) => s.replace(/\s+/g, "");
const ITEM_H = /^(품명|공종|명칭|품목|공종명|공종명칭|공사명|항목|자재명|품명및규격|공종및규격|세부공종|작업명|공정|내용|공종및품명|품명규격|종목|구분)$/;
const SPEC_H = /^(규격|사양|규격및사양|형식|규격\(사양\)|치수|규격치수)$/;
const UNIT_H = /^(단위|단위\(.*\))$/;
const QTY_H = /^(수량|물량|설계수량|수량\(.*\)|산출수량|총수량|계약수량)$/;
const MONEY_H = /금액|합계|재료비|노무비|경비|단가|공급가|소계|계$/;
const REF_H = /비고|코드|호표|산출근거|일위대가|산근|근거/;
const SUM_ITEM = /^(\[?소계\]?|\[?합계\]?|계|총계|누계|직접공사비|순공사비|공사원가|총공사비|도급액|부가가치세|일반관리비|이윤)$/;

interface Cell {
  c: number; // 열 번호(엑셀) 또는 글자 위치(PDF)
  e?: number; // PDF: 끝 글자 위치
  text: string;
  hidden?: boolean;
}
interface GridRow {
  r: number;
  cells: Cell[];
  hidden?: boolean;
  page?: number | null;
  groups?: Cell[]; // PDF: 두 칸 이상 띄어 쓴 덩어리(머리행 판정용)
}
interface Grid {
  f: string;
  sheet: string | null;
  dt: DocType;
  hidden?: boolean;
  approx?: boolean; // PDF: 글자 위치로 가장 가까운 머리 칸에 대응
  rows: GridRow[];
}

interface Mapping {
  item: number;
  spec?: number;
  unit?: number;
  qty?: number;
  money: number[];
  ref?: number;
  centers: { c: number; e: number; role: string }[];
}

function headerOf(row: GridRow): Mapping | null {
  let item: number | undefined;
  let spec: number | undefined;
  let unit: number | undefined;
  let qty: number | undefined;
  for (const cell of row.groups ?? row.cells) {
    const t = compact(cell.text);
    if (!t || t.length > 12) continue;
    if (item === undefined && ITEM_H.test(t)) item = cell.c;
    else if (spec === undefined && SPEC_H.test(t)) spec = cell.c;
    else if (unit === undefined && UNIT_H.test(t)) unit = cell.c;
    else if (qty === undefined && QTY_H.test(t)) qty = cell.c;
  }
  if (item === undefined || (unit === undefined && qty === undefined)) return null;
  return { item, spec, unit, qty, money: [], centers: [] };
}

function completeMapping(m: Mapping, header: GridRow, next: GridRow | undefined, approx: boolean): Mapping {
  const fixed = new Set([m.item, m.spec, m.unit, m.qty].filter((x): x is number => x !== undefined));
  const spans: { c: number; e: number; role: string }[] = [];
  const endOf = (row: GridRow, c: number) => (row.groups ?? row.cells).find((x) => x.c === c)?.e ?? c;
  spans.push({ c: m.item, e: endOf(header, m.item), role: "item" });
  if (m.spec !== undefined) spans.push({ c: m.spec, e: endOf(header, m.spec), role: "spec" });
  if (m.unit !== undefined) spans.push({ c: m.unit, e: endOf(header, m.unit), role: "unit" });
  if (m.qty !== undefined) spans.push({ c: m.qty, e: endOf(header, m.qty), role: "qty" });
  if (approx) {
    // PDF: 두 줄 머리(재료비 / 단가 금액)의 각 덩어리를 그대로 금액 칸으로 쓴다.
    for (const row of [header, next]) {
      if (!row) continue;
      for (const cell of row.groups ?? row.cells) {
        if (row === header && fixed.has(cell.c)) continue;
        const t = compact(cell.text);
        if (t.length > 20) continue;
        if (MONEY_H.test(t)) spans.push({ c: cell.c, e: cell.e ?? cell.c, role: "money" });
        else if (REF_H.test(t)) spans.push({ c: cell.c, e: cell.e ?? cell.c, role: "ref" });
      }
    }
  } else {
    // 두 줄 머리(재료비 / 단가·금액)를 열마다 합쳐 금액 칸을 찾는다.
    const texts = new Map<number, string>();
    for (const row of [header, next]) {
      if (!row) continue;
      for (const cell of row.cells) texts.set(cell.c, `${texts.get(cell.c) ?? ""}${compact(cell.text)}`);
    }
    for (const [c, t] of texts) {
      if (fixed.has(c) || t.length > 20) continue;
      if (MONEY_H.test(t)) spans.push({ c, e: c, role: "money" });
      else if (!spans.some((x) => x.role === "ref") && REF_H.test(t)) spans.push({ c, e: c, role: "ref" });
    }
  }
  m.money = spans.filter((x) => x.role === "money").map((x) => x.c);
  m.ref = spans.find((x) => x.role === "ref")?.c;
  m.centers = spans.sort((a, b) => a.c - b.c);
  return m;
}

export function parseNumber(text: string | undefined): number | null {
  if (!text) return null;
  const t = text.replace(/[,\s원]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const HO_PATTERNS: [RegExp, string][] = [
  [/제\s*(\d{1,4})\s*호\s*표?/, "호"],
  [/(\d{1,4})\s*호\s*표/, "호"],
  [/호\s*표\s*[-:]?\s*(\d{1,4})/, "호"],
  [/일\s*위\s*[-:]?\s*(\d{1,4})/, "호"],
  [/산\s*근\s*[-:]?\s*(\d{1,4})/, "산"],
];

export function hoKeys(text: string): string[] {
  const out: string[] = [];
  for (const [re, prefix] of HO_PATTERNS) {
    const g = new RegExp(re.source, "g");
    for (const m of text.matchAll(g)) out.push(`${prefix}${Number(m[1])}`);
  }
  return [...new Set(out)];
}

function cellAt(row: GridRow, m: Mapping, approx: boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const cell of row.cells) {
    if (cell.hidden) continue;
    let role: string | undefined;
    if (!approx) {
      role = m.centers.find((x) => x.c === cell.c)?.role;
    } else {
      // 글자 구간이 가까운 머리 칸(8글자 안)에 대응한다. PDF는 칸이 좁아 숫자가 옆 칸 머리에 더 가까울 때가 있어,
      // 글의 종류가 맞는 칸(숫자 → 수량·금액, 단위 → 단위, 글 → 품명·규격)을 먼저 고른다.
      // 글 토막은 두 칸 이상 띄어 쓴 덩어리째로(시작 위치 기준) 대응한다 — "PE 부직포 4T" 같은 품명이 규격 칸으로 쪼개지지 않게.
      const kind = parseNumber(cell.text) !== null ? "num" : UNIT_LIKE.test(cell.text) ? "unit" : "text";
      const group = kind === "text" ? row.groups?.find((g) => g.c <= cell.c && (g.e ?? g.c) >= (cell.e ?? cell.c)) : undefined;
      const start = group ? group.c : cell.c;
      const end = group ? Math.min(group.e ?? group.c, group.c + 4) : (cell.e ?? cell.c + cell.text.length);
      const fits = (r: string) =>
        kind === "num" ? r === "qty" || r === "money" || r === "ref" : kind === "unit" ? r === "unit" : r === "item" || r === "spec" || r === "ref" || r === "unit";
      let best: { d: number; role: string; fit: boolean } | null = null;
      for (const x of m.centers) {
        const d = Math.max(0, x.c - end, start - x.e);
        if (d > 8) continue;
        const fit = fits(x.role);
        if (!best || (fit && !best.fit) || (fit === best.fit && d < best.d)) best = { d, role: x.role, fit };
      }
      role = best?.role;
    }
    if (!role) continue;
    const list = out.get(role) ?? [];
    list.push(cell.text);
    out.set(role, list);
  }
  return out;
}

const MAX_T = 400;
const UNIT_LIKE = /^(㎡|m2|m²|㎥|m3|m³|㎝|cm|mm|㎜|km|m|ton|톤|kg|㎏|ea|개|개소|본|매|롤|r\/l|set|식|대|조|기|면|ℓ|l|인|일|회|공|장|통|포|ls)$/i;

function mapGrid(grid: Grid): DocRow[] {
  const out: DocRow[] = [];
  let mapping: Mapping | null = null;
  let currentHo: string | undefined;
  let curDt: DocType = grid.dt;
  for (let i = 0; i < grid.rows.length; i++) {
    const row = grid.rows[i]!;
    const visible = row.cells.filter((c) => !c.hidden && c.text.trim());
    const hiddenText = row.cells.filter((c) => c.hidden && c.text.trim()).map((c) => c.text).join(" | ");
    if (!visible.length && !hiddenText) continue;
    const t = (row.groups ?? visible).map((c) => c.text).join(" | ").slice(0, MAX_T);
    const base: DocRow = { f: grid.f, dt: grid.dt, sh: grid.sheet, r: row.r, k: "line", t };
    if (row.page) base.p = row.page;
    if (hiddenText) base.ht = hiddenText.slice(0, MAX_T);
    if (grid.hidden || row.hidden) base.hid = 1;

    // 문서(PDF·한글) 안의 제목 줄로 문서 종류가 바뀐다(예: 내역서 뒤에 붙은 "일위대가표").
    const groupsN = (row.groups ?? visible).length;
    if (!grid.sheet && t.length <= 30 && groupsN <= 2 && !headerOf(row) && visible.filter((c) => parseNumber(c.text) !== null).length <= 1) {
      const dt = docTypeOf(t);
      if (dt && dt !== curDt && !(dt === "ilwi" && curDt === "ilwi")) {
        curDt = dt;
        if (dt !== "ilwi") currentHo = undefined;
      }
    }
    base.dt = curDt;
    const ilwi = curDt === "ilwi";
    const header = headerOf(row);
    if (header) {
      mapping = completeMapping(header, row, grid.rows[i + 1], Boolean(grid.approx));
      base.hd = 1;
      out.push(base);
      continue;
    }
    if (ilwi) {
      const hos = hoKeys(t);
      // 블록 머리(제12호표 …)는 숫자가 거의 없다 — 그런 줄에서만 현재 호표를 바꾼다.
      if (hos.length && visible.filter((c) => parseNumber(c.text) !== null).length <= 2) currentHo = hos[0];
      if (currentHo) base.ho = currentHo;
    }
    if (mapping) {
      const cells = cellAt(row, mapping, Boolean(grid.approx));
      const item = cells.get("item")?.join(" ").trim();
      if (item) {
        base.k = "row";
        base.item = item.slice(0, 200);
        const spec = cells.get("spec")?.join(" ").trim();
        if (spec) base.spec = spec.slice(0, 200);
        const unit = cells.get("unit")?.join(" ").trim();
        if (unit) base.unit = unit.slice(0, 20);
        const qtyText = cells.get("qty")?.[0];
        base.qty = parseNumber(qtyText);
        const money = (cells.get("money") ?? []).map(parseNumber).filter((n): n is number => n !== null);
        base.amt = money.length ? Math.max(...money) : null;
        if (SUM_ITEM.test(compact(item)) || /소\s*계|합\s*계/.test(item)) base.sum = 1;
        if (!ilwi) {
          const refs = hoKeys([cells.get("ref")?.join(" ") ?? "", item].join(" "));
          if (refs.length) base.ref = refs;
        }
      }
    }
    if (!ilwi && base.k === "line") {
      const refs = hoKeys(t);
      if (refs.length) base.ref = refs;
    }
    out.push(base);
  }
  return out;
}

// 시트에 머리행이 있고 수량 칸이 있으면, 시트 이름이 흔한 이름(Sheet1)이어도 내역서로 본다.
function sheetType(sheetName: string | null, fileType: DocType, rows: GridRow[]): DocType {
  const byName = sheetName ? docTypeOf(sheetName) : null;
  if (byName) return byName;
  if (fileType !== "other") return fileType;
  for (const row of rows.slice(0, 80)) if (headerOf(row)) return "boq";
  return fileType;
}

// ---------- XLSX ----------
function colIndex(address: string): number {
  const letters = /^([A-Z]+)/.exec(address)?.[1] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

async function unzipText(archive: unzipper.CentralDirectory, entryPath: string): Promise<string> {
  const entry = archive.files.find((e) => e.path === entryPath);
  if (!entry || entry.type === "Directory") return "";
  if (Number(entry.uncompressedSize ?? 0) > 200 * 1024 * 1024) return "";
  return (await entry.buffer()).toString("utf8");
}

async function xlsxGrids(filePath: string, f: string, fileType: DocType): Promise<Grid[]> {
  const archive = await unzipper.Open.file(filePath);
  const sharedXml = await unzipText(archive, "xl/sharedStrings.xml");
  const shared = [...sharedXml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => (m[1] === undefined ? "" : stripXml(m[1])));
  const relsXml = await unzipText(archive, "xl/_rels/workbook.xml.rels");
  const ridTarget = new Map<string, string>();
  for (const rel of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = /\bId="([^"]+)"/.exec(rel[1]!)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(rel[1]!)?.[1];
    if (id && target) ridTarget.set(id, target);
  }
  const workbookXml = await unzipText(archive, "xl/workbook.xml");
  const sheets: { name: string; entry: string; hidden: boolean }[] = [];
  for (const tag of workbookXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = tag[1]!;
    const name = decodeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1];
    const state = /\bstate="([^"]+)"/.exec(attrs)?.[1] ?? "visible";
    const target = rid ? ridTarget.get(rid) : undefined;
    if (!target) continue;
    const entry = target.replace(/^\/?(xl\/)?/, "xl/");
    sheets.push({ name, entry, hidden: state !== "visible" });
  }
  if (!sheets.length) {
    for (const e of archive.files.map((x) => x.path).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p))) {
      sheets.push({ name: path.basename(e, ".xml"), entry: e, hidden: false });
    }
  }
  const grids: Grid[] = [];
  for (const sheet of sheets) {
    const xml = await unzipText(archive, sheet.entry);
    if (!xml) continue;
    const hiddenCols = new Set<number>();
    for (const col of xml.matchAll(/<col\b([^>]*)\/>/g)) {
      const a = col[1]!;
      if (!/\bhidden="(1|true)"/.test(a)) continue;
      const min = Number(/\bmin="(\d+)"/.exec(a)?.[1] ?? 0);
      const max = Number(/\bmax="(\d+)"/.exec(a)?.[1] ?? 0);
      for (let c = min; c <= Math.min(max, min + 200); c++) hiddenCols.add(c);
    }
    const rows: GridRow[] = [];
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (row[2] === undefined) continue;
      const r = Number(/\br="(\d+)"/.exec(row[1]!)?.[1] ?? rows.length + 1);
      const hidden = /\bhidden="(1|true)"/.test(row[1]!);
      const cells: Cell[] = [];
      for (const cell of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const body = cell[2];
        if (body === undefined) continue;
        const address = /\br="([^"]+)"/.exec(cell[1]!)?.[1] ?? "A";
        const type = /\bt="([^"]+)"/.exec(cell[1]!)?.[1] ?? "";
        let text = "";
        if (type === "s") text = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? -1)] ?? "";
        else if (type === "inlineStr") text = stripXml(body);
        else text = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "").trim();
        if (!text) continue;
        const c = colIndex(address);
        cells.push({ c, text, hidden: hiddenCols.has(c) || undefined });
      }
      if (cells.length) rows.push({ r, cells, hidden });
    }
    grids.push({ f, sheet: sheet.name, dt: sheetType(sheet.name, fileType, rows), hidden: sheet.hidden, rows });
  }
  return grids;
}

// ---------- XLS(파이썬 xlrd) ----------
async function xlsGrids(filePath: string, f: string, fileType: DocType): Promise<Grid[]> {
  const script = path.resolve(import.meta.dirname, "..", "scripts", "extract-xls-rows.py");
  const { stdout } = await execFileAsync("python3", [script, filePath], {
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 128 * 1024 * 1024,
    encoding: "utf8",
  });
  const data = JSON.parse(stdout) as { name: string; hidden: boolean; hiddenCols: number[]; rows: { r: number; hidden: boolean; cells: [number, string][] }[] }[];
  return data.map((s) => {
    const hc = new Set(s.hiddenCols);
    const rows: GridRow[] = s.rows.map((x) => ({ r: x.r, hidden: x.hidden, cells: x.cells.map(([c, text]) => ({ c, text, hidden: hc.has(c) || undefined })) }));
    return { f, sheet: s.name, dt: sheetType(s.name, fileType, rows), hidden: s.hidden, rows };
  });
}

// ---------- PDF(pdftotext -layout, 글자 위치로 열 복원) ----------
async function pdfGrids(filePath: string, f: string, fileType: DocType): Promise<Grid[]> {
  const target = `${filePath}.rows.txt`;
  await execFileAsync("pdftotext", ["-layout", filePath, target], { timeout: 60_000, killSignal: "SIGKILL" });
  let text: string;
  try {
    text = (await readFile(target)).toString("utf8");
  } finally {
    await rm(target, { force: true });
  }
  const rows: GridRow[] = [];
  let n = 0;
  text.split("\f").forEach((pageText, pageIndex) => {
    for (const line of pageText.split(/\r?\n/)) {
      n += 1;
      if (!line.trim()) continue;
      const cells: Cell[] = [];
      for (const m of line.matchAll(/\S+/g)) cells.push({ c: m.index ?? 0, e: (m.index ?? 0) + m[0].length, text: m[0] });
      const groups: Cell[] = [];
      for (const m of line.matchAll(/\S+(?: \S+)*/g)) groups.push({ c: m.index ?? 0, e: (m.index ?? 0) + m[0].length, text: m[0] });
      rows.push({ r: n, cells, groups, page: pageIndex + 1 });
    }
  });
  return [{ f, sheet: null, dt: sheetType(null, fileType, rows), approx: true, rows }];
}

// ---------- DOCX / HWPX 표 ----------
async function xmlTableGrids(filePath: string, f: string, fileType: DocType, entryRe: RegExp, rowTag: string, cellTag: string): Promise<Grid[]> {
  const archive = await unzipper.Open.file(filePath);
  const grids: Grid[] = [];
  for (const entry of archive.files.map((e) => e.path).filter((p) => entryRe.test(p))) {
    const xml = await unzipText(archive, entry);
    const rows: GridRow[] = [];
    let r = 0;
    // 표 행은 칸으로, 표 밖 문단은 한 칸짜리 행으로 둔다(문서 순서 유지).
    const re = new RegExp(`<${rowTag}\\b[\\s\\S]*?</${rowTag}>|<(?:w:p|hp:p)\\b[\\s\\S]*?</(?:w:p|hp:p)>`, "g");
    for (const m of xml.matchAll(re)) {
      r += 1;
      const chunk = m[0];
      if (chunk.startsWith(`<${rowTag}`)) {
        const cells: Cell[] = [];
        let c = 0;
        for (const cell of chunk.matchAll(new RegExp(`<${cellTag}\\b[\\s\\S]*?</${cellTag}>`, "g"))) {
          c += 1;
          const text = stripXml(cell[0]);
          if (text) cells.push({ c, text });
        }
        if (cells.length) rows.push({ r, cells });
      } else {
        const text = stripXml(chunk);
        if (text) rows.push({ r, cells: [{ c: 1, text }] });
      }
    }
    grids.push({ f, sheet: null, dt: sheetType(null, fileType, rows), rows });
  }
  return grids;
}

// ---------- 그 밖(HWP5 등): 문단 줄 ----------
async function lineGrids(filePath: string, f: string, fileType: DocType): Promise<Grid[]> {
  const segments = await extractSegmentsInProcess(filePath);
  const rows: GridRow[] = segments.map((s, i) => ({ r: i + 1, cells: [{ c: 1, text: s.text }], page: s.page }));
  return [{ f, sheet: null, dt: fileType, rows }];
}

async function sniff(filePath: string): Promise<"ole" | "zip" | "pdf" | "other"> {
  const handle = await open(filePath, "r");
  const buffer = Buffer.alloc(8);
  try {
    await handle.read(buffer, 0, 8, 0);
  } finally {
    await handle.close();
  }
  {
    if (buffer.readUInt32BE(0) === 0xd0cf11e0) return "ole";
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return "zip";
    if (buffer.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  }
  return "other";
}

// 압축 안의 찌꺼기 파일(맥 리소스 포크, 엑셀 잠금 파일, 썸네일 캐시)
export function isJunkEntry(name: string): boolean {
  const parts = name.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? "";
  return parts.includes("__MACOSX") || base.startsWith("._") || base.startsWith("~$") || /^(\.ds_store|thumbs\.db|desktop\.ini)$/i.test(base);
}

/** 파일 하나를 행 목록으로. displayName은 압축 안 경로 또는 첨부 이름(문서 종류 판정에 씀). */
export async function fileRows(filePath: string, displayName: string): Promise<DocRow[]> {
  if (isJunkEntry(displayName)) return [];
  const ext = path.extname(displayName || filePath).toLowerCase();
  const fileType = docTypeOf(displayName) ?? "other";
  const kind = await sniff(filePath);
  let grids: Grid[] = [];
  if (kind === "pdf") grids = await pdfGrids(filePath, displayName, fileType);
  else if (kind === "ole" && ext === ".xls") grids = await xlsGrids(filePath, displayName, fileType);
  else if (kind === "zip" && [".xlsx", ".xlsm"].includes(ext)) grids = await xlsxGrids(filePath, displayName, fileType);
  else if (kind === "zip" && ext === ".docx") grids = await xmlTableGrids(filePath, displayName, fileType, /^word\/document\.xml$/i, "w:tr", "w:tc");
  else if (kind === "zip" && ext === ".zip") grids = [];
  else if (kind === "zip") grids = await xmlTableGrids(filePath, displayName, fileType, /^(?:Contents|contents)\/section\d+\.xml$/, "hp:tr", "hp:tc");
  if (!grids.some((g) => g.rows.length) && !(kind === "zip" && ext === ".zip")) grids = await lineGrids(filePath, displayName, fileType);
  const out: DocRow[] = [];
  for (const g of grids) out.push(...mapGrid(g));
  return out;
}
