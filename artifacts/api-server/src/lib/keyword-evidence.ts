// brog2b 이식(2026-11-17 사용자 요청 "옮겨"): narafile(brog2b-v2)의 keyword-evidence.ts를 그대로 가져오고
// 자동검색 소요량 판정용 confirmedRows()만 덧붙였다.
// 키워드가 "이 공사에 실제로 필요한 자재·공종"인지 행 근거로 판정한다(2026-10-30, 키워드 정밀 매칭 설계).
//
// 등급
//  A 확정   내역서·물량산출서 표의 품명 칸에 키워드, 수량 > 0 (공내역서는 금액이 비어 있어 수량만 본다)
//  B 연결   일위대가(호표) 안에만 있지만, 그 호표를 같은 파일의 내역서가 수량 > 0으로 쓴다
//  C 추정   표 구조는 못 풀었지만 같은 줄에 키워드 + 단위 + 숫자 2개 이상 / 내역서 연결을 확인 못 한 일위대가 /
//           공종 키워드의 공종 제목 행 / 파일 이름에 키워드
//  D 언급   시방서·공고문 등 본문에만 있음 → 알림에서 뺀다(회원 화면 "언급만" 필터로 볼 수 있게 남김)
//  X 제외   숨김 시트·행·열, 단가표·견적에만, 쓰이지 않는 호표, 다른 품목의 규격 칸, 수량 0·합계 행,
//           품명 앞에서 수식어로만 쓰임(다른 제품)
// 알림 대상 = A·B·C. 판정 근거(어느 파일·시트·행, 품명·규격·단위·수량·금액)를 함께 남긴다.
import { DOC_TYPE_LABEL, type DocRow, type DocType } from "./doc-rows";
import { normalizeForMatch } from "./keyword-text";

export type Level = "A" | "B" | "C" | "D" | "X";
export const NOTIFY_LEVELS: Level[] = ["A", "B", "C"];
const RANK: Record<Level, number> = { A: 5, B: 4, C: 3, D: 2, X: 1 };

export const LEVEL_LABEL: Record<Level, string> = { A: "확정", B: "연결 확정", C: "추정", D: "언급만", X: "제외" };

export interface Evidence {
  lv: Level;
  why: string;
  f?: string;
  dt?: DocType;
  sh?: string | null;
  r?: number;
  p?: number | null;
  item?: string;
  spec?: string;
  unit?: string;
  qty?: number | null;
  amt?: number | null;
  ho?: string;
  work?: "labor" | "lump"; // 단위가 노무(인·일)나 일식(식)
  n?: number; // 이 등급의 근거 행 수
}

// ---------- 글자 비교 ----------
const squash = (s: string) => normalizeForMatch(s).replace(/\s+/g, "");

export function makeMatcher(keyword: string): (text: string | undefined) => boolean {
  const needle = squash(keyword);
  return (text) => Boolean(text && needle && squash(text).includes(needle));
}

// ---------- 단위 ----------
const UNIT_TOKEN = /^(㎡|m2|m²|㎥|m3|m³|㎝|cm|mm|㎜|km|m|ton|톤|t|kg|㎏|g|ea|개|개소|본|매|롤|r\/l|set|세트|식|대|조|기|면|l|ℓ|ha|인|일|회|공|장|통|포|병|kw|kva|구|주|그루|주\(本\)|ls|lot|분|시간|hr|권|부|건)$/i;
const LABOR_UNIT = /^(인|일|공|시간|hr|man-?day|md)$/i;
const LUMP_UNIT = /^(식|ls|lot)$/i;

export function isUnit(text: string | undefined): boolean {
  return Boolean(text && UNIT_TOKEN.test(text.replace(/\s+/g, "").toLowerCase()));
}

function workKind(unit: string | undefined): Evidence["work"] {
  if (!unit) return undefined;
  const u = unit.replace(/\s+/g, "");
  if (LABOR_UNIT.test(u)) return "labor";
  if (LUMP_UNIT.test(u)) return "lump";
  return undefined;
}

// ---------- 키워드가 품명의 본체인가, 다른 제품의 수식어인가 ----------
// "PE 부직포(4T)", "부직포 깔기", "부직포 포설공사" → 본체
// "부직포 부착형 배수판", "앵커볼트"(키워드 앵커) → 수식어(다른 제품)
const WORK_WORD = /^(깔기|설치|포설|시공|부설|부착|운반|작업|접합|보수|교체|철거|재료|자재|구입|구매|공사|공|품|제품|포함|별도|등|외|기타|타설|포장|도포|도장|붙임|마감|보강|덮기|씌우기|감기|두께|규격|사급|관급|할증|손료|가공|조립|제작|매설|설치비|시공비|재료비|운반비|자재비|및)$/;
const WORK_SUFFIX = /(공사|작업|설치|시공|깔기|포설|부설|운반|설치비|시공비|재료비|자재비)$/;
const ATTRIBUTE_SUFFIX = /(색|형|용|식|급|성|질|겸)$/;

export function isModifier(item: string, keyword: string): boolean {
  const it = normalizeForMatch(item);
  const k = normalizeForMatch(keyword).trim();
  let idx = it.lastIndexOf(k);
  let len = k.length;
  if (idx < 0) {
    // 띄어쓰기가 다른 경우: 공백을 뺀 글에서 찾는다.
    const flat = it.replace(/\s+/g, "");
    const fk = k.replace(/\s+/g, "");
    const fi = flat.lastIndexOf(fk);
    if (fi < 0) return false;
    return restIsOtherProduct(flat.slice(fi + fk.length));
  }
  return restIsOtherProduct(it.slice(idx + len));
}

function restIsOtherProduct(restRaw: string): boolean {
  const rest = restRaw.replace(/\([^)]*\)|\[[^\]]*\]|<[^>]*>|\{[^}]*\}/g, " ");
  const words = rest.match(/[가-힣]{2,}/g) ?? [];
  if (!words.length) return false;
  const last = words[words.length - 1]!;
  if (WORK_WORD.test(last) || WORK_SUFFIX.test(last) || ATTRIBUTE_SUFFIX.test(last)) return false;
  return true;
}

// 공종 키워드(도장공사, 방수공사 …)는 내역서의 공종 제목 행에서도 의미가 있다.
export function isWorkKeyword(keyword: string): boolean {
  return /(공사|공)$/.test(keyword.replace(/\s+/g, ""));
}

// ---------- 행 하나 판정 ----------
function numbersIn(row: DocRow): number {
  return (row.t.match(/(?:^|[\s|])-?\d[\d,]*(?:\.\d+)?(?=$|[\s|])/g) ?? []).length;
}

function unitInLine(row: DocRow): string | undefined {
  for (const part of row.t.split(/\s*\|\s*|\s{1,}/)) if (isUnit(part)) return part;
  return undefined;
}

function rowEvidence(row: DocRow, lv: Level, why: string): Evidence {
  const ev: Evidence = { lv, why, f: row.f, dt: row.dt, sh: row.sh, r: row.r };
  if (row.p) ev.p = row.p;
  if (row.item) ev.item = row.item;
  if (row.spec) ev.spec = row.spec;
  if (row.unit) ev.unit = row.unit;
  if (row.qty !== undefined) ev.qty = row.qty;
  if (row.amt !== undefined) ev.amt = row.amt;
  if (row.ho) ev.ho = row.ho;
  const w = workKind(row.unit);
  if (w) ev.work = w;
  return ev;
}

function lineRule(row: DocRow, hit: (s: string | undefined) => boolean): Evidence {
  const unit = row.unit ?? unitInLine(row);
  if (unit && numbersIn(row) >= 2 && hit(row.t)) {
    const ev = rowEvidence(row, "C", "같은 줄에 단위·수량이 있음");
    if (!ev.unit) ev.unit = unit;
    return ev;
  }
  return rowEvidence(row, "D", `${DOC_TYPE_LABEL[row.dt]} 본문에만 언급`);
}

function classifyRow(row: DocRow, keyword: string, hit: (s: string | undefined) => boolean, refs: Map<string, Set<string>>): Evidence {
  const inVisible = hit(row.t) || hit(row.item) || hit(row.spec);
  if (!inVisible && hit(row.ht)) return rowEvidence(row, "X", "숨김 열에만 있음");
  if (row.hid) return rowEvidence(row, "X", "숨김 시트·행");
  if (row.hd) return rowEvidence(row, "X", "표 머리행");
  if (row.dt === "price") return rowEvidence(row, "X", "단가표·견적 자료에만 있음");

  if (row.dt === "ilwi") {
    if (row.k === "row" && row.item && !hit(row.item) && hit(row.spec)) return rowEvidence(row, "X", "다른 품목의 규격 칸");
    if (row.k === "row" && row.item && hit(row.item) && isModifier(row.item, keyword)) return rowEvidence(row, "X", "다른 제품 이름의 일부");
    const fileRefs = refs.get(row.f);
    if (!row.ho) return rowEvidence(row, "C", "일위대가(호표 번호 확인 못 함)");
    if (fileRefs?.has(row.ho)) return rowEvidence(row, "B", `${row.ho.replace(/^호/, "제")}${row.ho.startsWith("호") ? "호표" : "(산근)"}를 내역서가 사용`);
    if (fileRefs && fileRefs.size) return rowEvidence(row, "X", "내역서에서 쓰지 않는 호표");
    return rowEvidence(row, "C", "일위대가(내역서 연결 확인 못 함)");
  }

  if ((row.dt === "boq" || row.dt === "qty") && row.k === "row" && row.item !== undefined) {
    if (row.sum) return rowEvidence(row, "X", "소계·합계 행");
    if (!hit(row.item)) {
      if (hit(row.spec)) return rowEvidence(row, "X", "다른 품목의 규격 칸");
      return rowEvidence(row, "D", "내역 비고·기타 칸에만 있음");
    }
    if (isModifier(row.item, keyword)) return rowEvidence(row, "X", "다른 제품 이름의 일부");
    if ((row.qty ?? 0) > 0) return rowEvidence(row, "A", `${DOC_TYPE_LABEL[row.dt]} 품명·수량 확인`);
    if (isWorkKeyword(keyword)) return rowEvidence(row, "C", "공종 제목 행");
    return rowEvidence(row, "X", "수량 없음(0 또는 빈 칸)");
  }

  // 머리행을 못 찾은 표·시방서·공고문·도면 등
  if (row.k === "row" && row.item !== undefined) {
    if (!hit(row.item) && hit(row.spec)) return rowEvidence(row, "X", "다른 품목의 규격 칸");
    if (hit(row.item) && isModifier(row.item, keyword)) return rowEvidence(row, "X", "다른 제품 이름의 일부");
    if (hit(row.item) && (row.qty ?? 0) > 0) return rowEvidence(row, "C", `${DOC_TYPE_LABEL[row.dt]} 표의 품명·수량`);
  }
  return lineRule(row, hit);
}

function better(a: Evidence | null, b: Evidence): Evidence {
  if (!a) return b;
  if (RANK[b.lv] !== RANK[a.lv]) return RANK[b.lv] > RANK[a.lv] ? b : a;
  return (b.qty ?? 0) > (a.qty ?? 0) ? b : a;
}

/** 내역서 행이 수량 > 0으로 가리키는 호표(파일별). */
export function referencedHo(rows: DocRow[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.ref?.length || row.hid || row.dt === "ilwi" || row.dt === "price") continue;
    if (row.k === "row" && !((row.qty ?? 0) > 0)) continue;
    const set = out.get(row.f) ?? new Set<string>();
    for (const h of row.ref) set.add(h);
    out.set(row.f, set);
  }
  return out;
}

/**
 * 파일 하나(압축이면 안의 파일 전부)의 행으로 키워드를 판정한다.
 * fileName: 첨부 이름. rows가 비었으면(추출 실패) null을 돌려준다 — 호출하는 쪽이 본문 글로 판정한다.
 */
export function classifyKeyword(rows: DocRow[], keyword: string, fileName: string, refs = referencedHo(rows)): Evidence | null {
  const hit = makeMatcher(keyword);
  let best: Evidence | null = null;
  const counts: Partial<Record<Level, number>> = {};
  for (const row of rows) {
    if (!hit(row.t) && !hit(row.ht) && !hit(row.item) && !hit(row.spec)) continue;
    const ev = classifyRow(row, keyword, hit, refs);
    counts[ev.lv] = (counts[ev.lv] ?? 0) + 1;
    best = better(best, ev);
  }
  if (hit(fileName) && (!best || RANK[best.lv] < RANK.C)) {
    best = { lv: "C", why: "첨부 이름에 키워드", f: fileName };
  }
  if (best) best.n = counts[best.lv] ?? 1;
  return best;
}

/** 행 정보가 없을 때(원본·행 파일 없음) 본문 글만으로 판정: 같은 줄에 단위·숫자가 있으면 C, 아니면 D. */
export function classifyFromText(text: string, keyword: string, fileName: string): Evidence | null {
  const hit = makeMatcher(keyword);
  let best: Evidence | null = null;
  let r = 0;
  for (const line of text.split(/\r?\n/)) {
    r += 1;
    if (!hit(line)) continue;
    const row: DocRow = { f: fileName, dt: "other", sh: null, r, k: "line", t: line.slice(0, 400) };
    const ev = lineRule(row, hit);
    ev.why = ev.lv === "C" ? "본문 줄에 단위·수량이 있음(원본 구조 없음)" : "본문에만 언급(원본 구조 없음)";
    best = better(best, ev);
  }
  if (hit(fileName) && (!best || RANK[best.lv] < RANK.C)) best = { lv: "C", why: "첨부 이름에 키워드", f: fileName };
  return best;
}

export function levelRank(lv: string | null | undefined): number {
  return lv && lv in RANK ? RANK[lv as Level] : 0;
}

const fmtNum = (n: number) => (Number.isInteger(n) ? n.toLocaleString("ko-KR") : n.toLocaleString("ko-KR", { maximumFractionDigits: 2 }));

/** 메일·화면용 한 줄: "부직포 · 4T · 1,250㎡ · 3,125,000원 (공종별내역서 2행)" */
export function evidenceLine(keyword: string, ev: Evidence): string {
  const parts: string[] = [];
  parts.push(ev.item ? ev.item : keyword);
  if (ev.spec) parts.push(ev.spec);
  if (ev.qty !== undefined && ev.qty !== null && ev.qty > 0) parts.push(`${fmtNum(ev.qty)}${ev.unit ?? ""}`);
  else if (ev.unit) parts.push(ev.unit);
  if (ev.amt) parts.push(`${fmtNum(ev.amt)}원`);
  const where = [ev.sh || (ev.f ? ev.f.split(/[\\/]/).pop() : ""), ev.r ? `${ev.r}행` : ""].filter(Boolean).join(" ");
  const work = ev.work === "labor" ? " · 설치 노무" : ev.work === "lump" ? " · 일식" : "";
  return `${parts.join(" · ")}${work}${where ? ` (${where})` : ""}`;
}

/**
 * brog2b 자동검색 소요량 판정용(2026-11-17): 내역서·물량산출서 표에서 머리행으로 확인한
 * "품명 칸에 키워드 + 수량 칸 숫자 > 0" 행(A 확정)만 전부 돌려준다. 일위대가(단위당 소요량),
 * 합계·소계, 숨김 시트·행, 단가표, 다른 제품의 수식어로만 쓰인 경우는 빠진다.
 */
export function confirmedRows(rows: DocRow[], keyword: string): DocRow[] {
  const hit = makeMatcher(keyword);
  const refs = referencedHo(rows);
  const out: DocRow[] = [];
  for (const row of rows) {
    if (!hit(row.item)) continue;
    if (classifyRow(row, keyword, hit, refs).lv === "A") out.push(row);
  }
  return out;
}
