// 요구사항(2026-11-04 사용자 지적: "부직포 1 m 은 그 공사에 필요한 부직포가 1 이란 뜻이
// 아니야. 진짜 그 공사에 부직포가 필요한지, 필요하면 얼마나 필요한지를 찾아내는 게 너의
// 역할이야"): 예전 매칭은 첨부파일 어디든(시방서 문장 포함) 키워드와 "숫자+단위"가 한 줄에
// 있으면 리드로 잡았다 — "부직포는 1m 이상 겹쳐 시공한다" 같은 시방서 문장이 "부직포 1 m"
// 리드가 됐다. 이 모듈은 "실제로 이 공사에서 그 자재를 얼마나 쓰는가"를 판정한다.
//
// 판정 원칙
// 1) 수량의 근거는 내역서(공내역서·설계내역서·물량내역서·산출서 등 BOQ)뿐이다.
//    시방서·공고문·설명서·과업지시서는 "이렇게 시공하라"는 일반 기준이라 자재가 실제로
//    들어가는지, 얼마나 들어가는지를 말해주지 않는다 → 수량 근거로 쓰지 않는다.
// 2) 내역서 안에서도 "한 행 = 품명 | 규격 | 단위 | 수량" 구조여야 한다. 키워드는 품명/규격
//    칸에 있어야 하고, 수량은 단위와 짝을 이룬 별도 숫자여야 한다. 규격 속 치수
//    ("B1.5m", "H=4m", "폭1.2m", "300g/㎡")는 수량이 아니다.
// 3) 문장형 텍스트(…한다, …할 것, 이상/이하/겹침 등)는 내역서 안에 있어도 버린다.
// 4) 같은 공고의 유효 행을 모아 총 소요량(㎡ 환산 가능하면 ㎡)을 계산한다.

export type DocKind = "boq" | "spec" | "unknown";

const BOQ_NAME = /(내역|산출|물량|수량|boq|단가|원가계산|견적서|설계서)/i;
const SPEC_NAME = /(시방|공고|설명서|과업|지시서|지침|안내|유의|도면|계약|서약|청렴|양식|제안|평가|현장설명|특기)/;
const BOQ_HEADER_TOKENS = [/(품\s*명|공\s*종|명\s*칭|공종명|품목)/, /규\s*격/, /단\s*위/, /수\s*량/];

// 파일 이름(ZIP 안 파일이면 압축파일 이름도 함께)과 내용으로 문서 종류를 정한다.
export function classifyDocument(fileNames: string[], segmentTexts: Iterable<string>): DocKind {
  const names = fileNames.join(" ");
  if (BOQ_NAME.test(names) && !/시방/.test(names)) return "boq";
  if (SPEC_NAME.test(names) && !BOQ_NAME.test(names)) return "spec";
  // 이름만으로 모르면 내용에 "품명/규격/단위/수량" 머리행이 있는지 본다.
  let scanned = 0;
  for (const text of segmentTexts) {
    if (BOQ_HEADER_TOKENS.every((token) => token.test(text))) return "boq";
    if (++scanned > 3000) break;
  }
  return SPEC_NAME.test(names) ? "spec" : "unknown";
}

type UnitKind = "area" | "length" | "roll" | "weight" | "count" | "lump";

const UNIT_TABLE: { pattern: RegExp; kind: UnitKind; label: string }[] = [
  { pattern: /^(?:㎡|m²|m2|sqm)$/i, kind: "area", label: "㎡" },
  { pattern: /^(?:m|M|미터)$/, kind: "length", label: "m" },
  { pattern: /^(?:롤|ROLL|Roll|roll|R|권)$/, kind: "roll", label: "롤" },
  { pattern: /^(?:kg|KG|Kg|ton|TON|Ton|톤|t)$/, kind: "weight", label: "" },
  { pattern: /^(?:매|EA|ea|개|장)$/, kind: "count", label: "" },
  { pattern: /^(?:식|LS|ls|L\.S)$/, kind: "lump", label: "식" },
];

function unitOf(token: string): { kind: UnitKind; label: string } | null {
  const trimmed = token.trim();
  for (const entry of UNIT_TABLE) {
    if (entry.pattern.test(trimmed)) return { kind: entry.kind, label: entry.label || trimmed };
  }
  return null;
}

const NUMERIC = /^[0-9][0-9,]*(?:\.[0-9]+)?$/;
// 문장(시방 기준·지시문)임을 드러내는 표현.
const SENTENCE_MARKERS =
  /(한다|하여야|해야|할\s*것|하며|하고|된다|있다|없다|바랍니다|합니다|이상\s*겹|겹침|겹쳐|이음|이격|간격|이내|이상으로|이하로|시공\s*시|경우)/;
// 규격 치수 앞에 붙는 표기(B=폭, W, H, L, T, Φ, D, 폭/높이/길이/두께, "=" 등).
const DIMENSION_PREFIX = /(?:[BWHLTDΦφØ]\s*=?\s*|폭\s*=?\s*|높이\s*=?\s*|길이\s*=?\s*|두께\s*=?\s*|=\s*|[x×*]\s*)$/;

export interface QualifiedRow {
  ok: true;
  itemName: string;
  specification: string | null;
  quantity: number;
  unitLabel: string;
  unitKind: UnitKind;
  /** ㎡로 환산한 소요량(면적 단위이거나, 길이 × 규격의 폭으로 환산 가능할 때). */
  areaSqm: number | null;
  quantityText: string;
}

export interface RejectedRow {
  ok: false;
  reason: string;
}

function splitCells(text: string): string[] {
  const parts = text.includes("|") ? text.split("|") : text.split(/\t+|\s{2,}/);
  return parts.map((part) => part.trim().replace(/^[A-Z]{1,3}\d+=/, "").trim()).filter(Boolean);
}

function parseNumber(value: string): number {
  return Number(value.replace(/,/g, ""));
}

// 규격 문자열에서 폭(m)을 찾는다: "B1.5m", "W=2.0m", "폭 1.2m", "1.5m×50m"(롤 규격) 등.
function widthMetersOf(spec: string): number | null {
  const explicit = /(?:\bB|\bW|폭)\s*=?\s*([0-9]+(?:\.[0-9]+)?)\s*(m|M|mm)\b/.exec(spec);
  if (explicit) {
    const value = Number(explicit[1]);
    return explicit[2] === "mm" ? value / 1000 : value;
  }
  return null;
}

function formatNumber(value: number): string {
  return Math.trunc(value).toLocaleString("ko-KR");
}

// 내역서의 한 행(엑셀은 "A1=.. | B1=.." 형태, PDF는 탭/공백 구분 한 줄)을 판정한다.
export function qualifyBoqRow(rowText: string, keywords: readonly string[]): QualifiedRow | RejectedRow {
  const cells = splitCells(rowText);
  if (cells.length === 0) return { ok: false, reason: "빈 행" };
  const lowerKeywords = keywords.map((keyword) => keyword.toLowerCase().replace(/\s+/g, "")).filter(Boolean);
  const keywordIndex = cells.findIndex((cell) => {
    const normalized = cell.toLowerCase().replace(/\s+/g, "");
    return lowerKeywords.some((keyword) => normalized.includes(keyword));
  });
  if (keywordIndex < 0) return { ok: false, reason: "키워드가 품명/규격 칸에 없음" };
  const nameCell = cells[keywordIndex];
  if (nameCell.length > 60 || SENTENCE_MARKERS.test(nameCell)) {
    return { ok: false, reason: "문장형 텍스트(시방 기준 문구)" };
  }

  // ① 칸이 나뉜 경우: 정확히 단위만 있는 칸 + 그 옆의 정확히 숫자만 있는 칸.
  let quantity: number | null = null;
  let unit: { kind: UnitKind; label: string } | null = null;
  let unitCellIndex = -1;
  if (cells.length >= 3) {
    for (let index = keywordIndex + 1; index < cells.length; index += 1) {
      const candidateUnit = unitOf(cells[index]);
      if (!candidateUnit) continue;
      const after = cells[index + 1];
      const before = cells[index - 1];
      if (after !== undefined && NUMERIC.test(after)) {
        quantity = parseNumber(after);
      } else if (index - 1 > keywordIndex && before !== undefined && NUMERIC.test(before)) {
        quantity = parseNumber(before);
      }
      if (quantity !== null) {
        unit = candidateUnit;
        unitCellIndex = index;
        break;
      }
    }
  }

  // ② 칸 구분이 없는 PDF 한 줄: "임시보행로 설치 및 해체 부직포 B1.5m 350 M".
  //    치수 표기(B1.5m, H=4m, 85m*1.2m 등)는 건너뛰고, 행 끝쪽의 "수량 단위" 쌍을 쓴다.
  if (quantity === null) {
    const line = cells.join(" ");
    const pairs = [...line.matchAll(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*(㎡|m²|m2|M2|m|M|롤|ROLL|R|kg|KG|ton|톤|매|EA|개|식)(?![0-9A-Za-z가-힣/²])/g)];
    for (let index = pairs.length - 1; index >= 0; index -= 1) {
      const pair = pairs[index];
      const start = pair.index ?? 0;
      const prefix = line.slice(Math.max(0, start - 6), start);
      if (DIMENSION_PREFIX.test(prefix)) continue;
      // 숫자 바로 뒤에 다른 치수가 곱해지는 경우("85m*1.2m")도 치수.
      if (/^\s*[x×*]/.test(line.slice(start + pair[0].length))) continue;
      // 숫자와 단위 사이 공백이 없고(1.5m) 앞에 영문자가 붙어 있으면 규격 표기로 본다.
      if (/[A-Za-z]$/.test(prefix)) continue;
      const candidateUnit = unitOf(pair[2]);
      if (!candidateUnit) continue;
      quantity = parseNumber(pair[1]);
      unit = candidateUnit;
      break;
    }
  }

  if (quantity === null || unit === null || !Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, reason: "단위와 짝을 이룬 수량 칸이 없음" };
  }
  if (unit.kind === "lump") {
    return { ok: false, reason: "1식(일괄) 표기라 소요량을 알 수 없음" };
  }

  const specCells = cells.slice(keywordIndex + 1, unitCellIndex > 0 ? unitCellIndex : undefined).filter(
    (cell) => !NUMERIC.test(cell) && !unitOf(cell),
  );
  const specification = specCells[0] ?? null;
  const specSource = [nameCell, ...specCells].join(" ");

  let areaSqm: number | null = null;
  if (unit.kind === "area") areaSqm = quantity;
  else if (unit.kind === "length") {
    const width = widthMetersOf(specSource);
    if (width && width > 0 && width <= 10) areaSqm = quantity * width;
    // 폭을 모르는 길이 수량이 아주 작으면(예: "1 m") 소요량이라기보다 규격·기준값일
    // 가능성이 높다 — 리드로 보지 않는다.
    else if (quantity < 10) return { ok: false, reason: "폭을 알 수 없는 소량 길이 표기" };
  } else if (unit.kind === "roll") {
    // 롤 규격 "4m×50m", "4M*50M" → 롤당 면적 × 롤 수.
    const dims = /([0-9]+(?:\.[0-9]+)?)\s*m\s*[x×*]\s*([0-9]+(?:\.[0-9]+)?)\s*m/i.exec(specSource);
    if (dims) areaSqm = quantity * Number(dims[1]) * Number(dims[2]);
  }

  const base = `${formatNumber(quantity)} ${unit.label}`;
  const quantityText = areaSqm !== null && unit.kind !== "area" ? `${base} (약 ${formatNumber(areaSqm)}㎡)` : base;
  return {
    ok: true,
    itemName: nameCell,
    specification,
    quantity,
    unitLabel: unit.label,
    unitKind: unit.kind,
    areaSqm,
    quantityText,
  };
}

// 같은 공고에서 찾은 유효 행들을 합쳐 총 소요량을 낸다. 같은 행이 공내역서·설계내역서
// 양쪽에 중복으로 들어 있는 경우가 많아 (품명, 규격, 수량, 단위)가 같으면 한 번만 센다.
export function summarizeNeed(rows: QualifiedRow[]): { totalAreaSqm: number | null; text: string } {
  const unique = new Map<string, QualifiedRow>();
  for (const row of rows) {
    unique.set(`${row.itemName}|${row.specification ?? ""}|${row.quantity}|${row.unitLabel}`, row);
  }
  const list = [...unique.values()];
  const areaRows = list.filter((row) => row.areaSqm !== null);
  const totalAreaSqm = areaRows.length > 0 ? areaRows.reduce((sum, row) => sum + (row.areaSqm ?? 0), 0) : null;
  const text =
    totalAreaSqm !== null
      ? `총 약 ${formatNumber(totalAreaSqm)}㎡ (내역서 ${list.length}개 항목)`
      : `내역서 ${list.length}개 항목`;
  return { totalAreaSqm, text };
}

// 내역서 파일 안의 일위대가표·단가산출서는 "단위(㎡·m)당 자재 소요량"(예: 부직포 1.05)을
// 적은 표라 공사 전체 소요량이 아니다. 엑셀은 시트 이름으로, PDF/HWP는 문서 순서상
// 제목(일위대가표/단가산출서 ↔ 내역서/집계표)으로 구간을 나눠 그 구간을 뺀다.
const UNIT_PRICE_SECTION = /(일\s*위\s*대\s*가|단\s*가\s*산\s*출|산\s*출\s*근\s*거|호\s*표|자\s*재\s*단\s*가|노\s*임\s*단\s*가|중\s*기\s*단\s*가|장\s*비\s*단\s*가)/;
const QUANTITY_SECTION = /(내\s*역\s*서|집\s*계\s*표|물\s*량\s*표|수\s*량\s*표)/;

export function dropUnitPriceSections<T extends { text: string; sheet: string | null }>(segments: T[]): T[] {
  let inUnitPrice = false;
  return segments.filter((segment) => {
    if (segment.sheet) return !UNIT_PRICE_SECTION.test(segment.sheet);
    const heading = segment.text.trim();
    if (heading.length <= 30) {
      if (UNIT_PRICE_SECTION.test(heading)) inUnitPrice = true;
      else if (QUANTITY_SECTION.test(heading)) inUnitPrice = false;
    }
    return !inUnitPrice;
  });
}
