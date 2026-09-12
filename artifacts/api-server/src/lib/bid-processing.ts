import { execFile } from "node:child_process";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import type { Response } from "express";
import { HttpsProxyAgent } from "https-proxy-agent";
import * as unzipper from "unzipper";
import { eq } from "drizzle-orm";
import { db, businessContactCacheTable, govCorpCacheTable } from "@workspace/db";
import { logger } from "./logger";
import { kstToday } from "./kr-holidays";

const execFileAsync = promisify(execFile);
const API_BASE =
  "https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoCnstwk";
// Prefer a mounted persistent volume when available (e.g. Railway's
// RAILWAY_VOLUME_MOUNT_PATH) so job state and downloaded attachments survive
// restarts/redeploys; fall back to the OS temp dir otherwise (e.g. local dev,
// or Replit where the single VM's local disk is what persists).
const JOB_ROOT = path.join(
  process.env.RAILWAY_VOLUME_MOUNT_PATH || tmpdir(),
  "bid-attachment-jobs",
);
export const DEFAULT_KEYWORDS = [
  "부직포",
  "토목용 부직포",
  "PET 부직포",
  "PP 부직포",
  "부직포깔기",
  "필터용 부직포",
  "필터매트",
] as const;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 5 * 60_000;
const networkCircuit = { consecutiveFailures: 0, openUntil: 0, lastError: "" };

class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & {
    code?: string;
    hostname?: string;
    syscall?: string;
    address?: string;
    port?: number;
    phase?: string;
    elapsedMs?: number;
    errors?: unknown[];
    cause?: unknown;
  };
  const cause = details.cause as {
    code?: string;
    hostname?: string;
    syscall?: string;
    address?: string;
    port?: number;
    phase?: string;
    elapsedMs?: number;
    message?: string;
  } | undefined;
  const aggregateErrors = details.errors?.map((nested) => {
    const item = nested as Error & {
      code?: string;
      address?: string;
      port?: number;
      syscall?: string;
    };
    return [
      item.name && item.message ? `${item.name}: ${item.message}` : String(nested),
      item.code ? `code=${item.code}` : "",
      item.syscall ? `syscall=${item.syscall}` : "",
      item.address ? `address=${item.address}` : "",
      item.port ? `port=${item.port}` : "",
    ].filter(Boolean).join(", ");
  }).join(" / ");
  return [
    `${details.name}: ${details.message}`,
    details.code || cause?.code ? `code=${details.code ?? cause?.code}` : "",
    details.hostname || cause?.hostname ? `hostname=${details.hostname ?? cause?.hostname}` : "",
    details.syscall || cause?.syscall ? `syscall=${details.syscall ?? cause?.syscall}` : "",
    details.address || cause?.address ? `address=${details.address ?? cause?.address}` : "",
    details.port || cause?.port ? `port=${details.port ?? cause?.port}` : "",
    details.phase || cause?.phase ? `phase=${details.phase ?? cause?.phase}` : "",
    details.elapsedMs || cause?.elapsedMs ? `elapsedMs=${details.elapsedMs ?? cause?.elapsedMs}` : "",
    cause?.message && cause.message !== details.message ? `cause=${cause.message}` : "",
    aggregateErrors ? `attempts=${aggregateErrors}` : "",
  ].filter(Boolean).join(", ");
}

function assertCircuitAvailable(): void {
  if (networkCircuit.openUntil > Date.now()) {
    throw new CircuitOpenError(
      `나라장터 외부 연결 회로가 일시 중지되었습니다 (${new Date(networkCircuit.openUntil).toISOString()}까지). 마지막 오류: ${networkCircuit.lastError}`,
    );
  }
  if (networkCircuit.openUntil) {
    networkCircuit.openUntil = 0;
    networkCircuit.consecutiveFailures = 0;
  }
}

function recordNetworkFailure(error: unknown): never {
  const detail = describeError(error);
  networkCircuit.consecutiveFailures += 1;
  networkCircuit.lastError = detail;
  if (networkCircuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    networkCircuit.openUntil = Date.now() + CIRCUIT_OPEN_MS;
    logger.error(
      { networkError: detail, circuitOpenUntil: new Date(networkCircuit.openUntil).toISOString() },
      "Government API network circuit opened",
    );
    throw new CircuitOpenError(
      `나라장터 외부 연결 장애로 회로를 일시 중지했습니다. ${detail}`,
    );
  }
  throw new Error(detail);
}

function recordNetworkSuccess(): void {
  networkCircuit.consecutiveFailures = 0;
  networkCircuit.openUntil = 0;
  networkCircuit.lastError = "";
}

// 요구사항(2026-09-11 사용자 지적: "api 는 호출량이 있고... 이런식으로 하면
// 손해배상청구 소송"): 네이버 오픈API(지역검색/웹문서/블로그)는 나라장터
// API와 별개로 자체 일일 호출 한도가 있다. 낙찰 건마다(스캔당 최대 수십~
// 수백 건) 회사 연락처를 찾으려고 호출하므로, 장애/한도초과 시 무한정 계속
// 두들기지 않도록 나라장터용 networkCircuit과 같은 패턴의 회로차단기를 따로
// 두고, 하루 호출량 자체도 상한을 둬 예산을 초과하면 그날은 더 부르지 않는다.
const NAVER_DAILY_CALL_BUDGET = 20_000;
const NAVER_CIRCUIT_FAILURE_THRESHOLD = 3;
const NAVER_CIRCUIT_OPEN_MS = 10 * 60_000;
const naverGuard = {
  dayKey: "",
  callCount: 0,
  consecutiveFailures: 0,
  openUntil: 0,
  lastError: "",
};

function naverGuardResetIfNewDay(): void {
  const todayKey = kstToday().key;
  if (naverGuard.dayKey !== todayKey) {
    naverGuard.dayKey = todayKey;
    naverGuard.callCount = 0;
  }
}

// 실제 호출 전에 먼저 확인: 오늘 예산을 다 썼거나 회로가 열려 있으면 호출 자체를
// 건너뛴다(결과는 "못 찾음"으로 취급 — 캐시에는 남기지 않아 나중에 다시 시도됨).
function naverGuardAllow(): boolean {
  naverGuardResetIfNewDay();
  if (naverGuard.openUntil > Date.now()) return false;
  if (naverGuard.openUntil) {
    naverGuard.openUntil = 0;
    naverGuard.consecutiveFailures = 0;
  }
  if (naverGuard.callCount >= NAVER_DAILY_CALL_BUDGET) {
    logger.warn({ callCount: naverGuard.callCount }, "Naver API daily call budget reached; skipping further calls today");
    return false;
  }
  return true;
}

function naverGuardRecordCall(): void {
  naverGuardResetIfNewDay();
  naverGuard.callCount += 1;
}

function naverGuardRecordFailure(detail: string): void {
  naverGuard.consecutiveFailures += 1;
  naverGuard.lastError = detail;
  if (naverGuard.consecutiveFailures >= NAVER_CIRCUIT_FAILURE_THRESHOLD) {
    naverGuard.openUntil = Date.now() + NAVER_CIRCUIT_OPEN_MS;
    logger.error(
      { naverError: detail, circuitOpenUntil: new Date(naverGuard.openUntil).toISOString() },
      "Naver API circuit opened",
    );
  }
}

function naverGuardRecordSuccess(): void {
  naverGuard.consecutiveFailures = 0;
  naverGuard.openUntil = 0;
  naverGuard.lastError = "";
}

// 회사명(+지역) 단위 영구 캐시. 지역검색(portal)과 웹/블로그검색(web)은 서로
// 다른 API이므로 각각 조회 여부를 따로 두고, 이미 조회했던(못 찾은 경우 포함)
// 회사는 API를 다시 부르지 않는다.
async function getCachedPortalContact(
  cacheKey: string,
): Promise<{ checked: boolean; address?: string; phone?: string }> {
  const [row] = await db
    .select()
    .from(businessContactCacheTable)
    .where(eq(businessContactCacheTable.cacheKey, cacheKey))
    .limit(1);
  if (!row || !row.portalChecked) return { checked: false };
  return {
    checked: true,
    address: row.portalAddress ?? undefined,
    phone: row.portalPhone ?? undefined,
  };
}

async function cachePortalContact(
  cacheKey: string,
  result: { address?: string; phone?: string } | null,
): Promise<void> {
  await db
    .insert(businessContactCacheTable)
    .values({
      cacheKey,
      portalChecked: true,
      portalAddress: result?.address ?? null,
      portalPhone: result?.phone ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: businessContactCacheTable.cacheKey,
      set: {
        portalChecked: true,
        portalAddress: result?.address ?? null,
        portalPhone: result?.phone ?? null,
        updatedAt: new Date(),
      },
    });
}

async function getCachedWebContact(cacheKey: string): Promise<{ checked: boolean; phone?: string }> {
  const [row] = await db
    .select()
    .from(businessContactCacheTable)
    .where(eq(businessContactCacheTable.cacheKey, cacheKey))
    .limit(1);
  if (!row || !row.webChecked) return { checked: false };
  return { checked: true, phone: row.webPhone ?? undefined };
}

async function cacheWebContact(cacheKey: string, phone: string | null): Promise<void> {
  await db
    .insert(businessContactCacheTable)
    .values({
      cacheKey,
      webChecked: true,
      webPhone: phone,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: businessContactCacheTable.cacheKey,
      set: {
        webChecked: true,
        webPhone: phone,
        updatedAt: new Date(),
      },
    });
}

// 요구사항(2026-09-11 사용자 요청: 조달청 "조달업체 등록 내역" 공공데이터를
// 알려주며 낙찰자 연락처 보강에 써달라고 요청 → "기존 낙찰자 정보를 이 API로
// 보강" 선택): 이미 알고 있는 낙찰자 사업자등록번호(bizno)로 조달청 "나라
// 장터 사용자정보 서비스"(조달업체 기본정보 조회, getPrcrmntCorpBasicInfo02)
// API에서 정식 등록된 주소/전화번호를 조회한다. 네이버 검색(회사명 텍스트
// 매칭이라 동명업체 오류 가능)보다 사업자등록번호 정확 매칭이 훨씬 신뢰도가
// 높으므로 resolveBidderContact에서 Naver 포털/웹 검색보다 먼저 시도한다.
// 이 서비스도 data.go.kr 계정의 별도 일일 트래픽 한도(안내 페이지 기준
// 운영계정 기본 신청량 10,000/일, 서비스가 다르면 별도 집계)가 있으므로
// Naver 가드와 같은 패턴으로 일일 호출 상한 + 연속실패 서킷브레이커를 둔다.
// 같은 bizno는 평생 한 번만 조회하고 결과(못 찾은 경우 포함)를 영구 캐시한다.
const GOV_REGISTRY_DAILY_CALL_BUDGET = Number(process.env.GOV_REGISTRY_DAILY_CALL_BUDGET) || 3000;
const GOV_REGISTRY_CIRCUIT_FAILURE_THRESHOLD = 3;
const GOV_REGISTRY_CIRCUIT_OPEN_MS = 10 * 60_000;
const govRegistryGuard = {
  dayKey: "",
  callCount: 0,
  consecutiveFailures: 0,
  openUntil: 0,
  lastError: "",
  // inqryDiv("조회구분")의 정확한 허용값이 공식 Swagger 명세에 값 목록 없이
  // "조회구분"이라고만 나와 있어(2026-09-11 확인), 최초 조회 때 후보값을
  // 순서대로 시도해 성공한 값을 기억해두고 이후에는 바로 그 값부터 쓴다.
  resolvedInqryDiv: null as string | null,
};

function govRegistryGuardResetIfNewDay(): void {
  const todayKey = kstToday().key;
  if (govRegistryGuard.dayKey !== todayKey) {
    govRegistryGuard.dayKey = todayKey;
    govRegistryGuard.callCount = 0;
  }
}

function govRegistryGuardAllow(): boolean {
  govRegistryGuardResetIfNewDay();
  if (govRegistryGuard.openUntil > Date.now()) return false;
  if (govRegistryGuard.openUntil) {
    govRegistryGuard.openUntil = 0;
    govRegistryGuard.consecutiveFailures = 0;
  }
  if (govRegistryGuard.callCount >= GOV_REGISTRY_DAILY_CALL_BUDGET) {
    logger.warn(
      { callCount: govRegistryGuard.callCount },
      "조달청 사용자정보 API 일일 호출 한도 도달; 오늘은 더 호출하지 않음",
    );
    return false;
  }
  return true;
}

function govRegistryGuardRecordCall(): void {
  govRegistryGuardResetIfNewDay();
  govRegistryGuard.callCount += 1;
}

function govRegistryGuardRecordFailure(detail: string): void {
  govRegistryGuard.consecutiveFailures += 1;
  govRegistryGuard.lastError = detail;
  if (govRegistryGuard.consecutiveFailures >= GOV_REGISTRY_CIRCUIT_FAILURE_THRESHOLD) {
    govRegistryGuard.openUntil = Date.now() + GOV_REGISTRY_CIRCUIT_OPEN_MS;
    logger.error(
      { govRegistryError: detail, circuitOpenUntil: new Date(govRegistryGuard.openUntil).toISOString() },
      "조달청 사용자정보 API 회로 차단",
    );
  }
}

function govRegistryGuardRecordSuccess(): void {
  govRegistryGuard.consecutiveFailures = 0;
  govRegistryGuard.openUntil = 0;
  govRegistryGuard.lastError = "";
}

// bizno 단위 영구 캐시 — 이미 조회했던 적이 있으면(못 찾은 경우 포함) 캐시된
// 값을 그대로 쓰고 API를 다시 부르지 않는다.
async function getCachedGovCorpInfo(
  bizno: string,
): Promise<{ checked: boolean; address?: string; phone?: string }> {
  const [row] = await db
    .select()
    .from(govCorpCacheTable)
    .where(eq(govCorpCacheTable.bizno, bizno))
    .limit(1);
  if (!row || !row.checked) return { checked: false };
  return {
    checked: true,
    address: row.address ?? undefined,
    phone: row.phone ?? undefined,
  };
}

async function cacheGovCorpInfo(
  bizno: string,
  result: { address?: string; phone?: string } | null,
): Promise<void> {
  await db
    .insert(govCorpCacheTable)
    .values({
      bizno,
      checked: true,
      address: result?.address ?? null,
      phone: result?.phone ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: govCorpCacheTable.bizno,
      set: {
        checked: true,
        address: result?.address ?? null,
        phone: result?.phone ?? null,
        updatedAt: new Date(),
      },
    });
}

function isGovApiQuotaOrAuthError(detail: string): boolean {
  return /LIMIT|PERMISSION|ACCESS_DENIED|SERVICE_KEY|BLACKLIST|DEADLINE_HAS_EXPIRED/i.test(detail);
}

// data.go.kr 공통 오류 응답 형태(OpenAPI_ServiceResponse/response 래핑,
// XML/JSON 혼재)에서 사람이 읽을 원인 메시지를 최대한 뽑아낸다.
function extractGovApiErrorDetail(raw: string): string | null {
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const envelope = (json.OpenAPI_ServiceResponse ?? json.response ?? json) as Record<string, unknown>;
    const header = (envelope.cmmMsgHeader ?? envelope.header ?? json.header ?? envelope) as Record<
      string,
      unknown
    >;
    const authMsg = String(header.returnAuthMsg ?? "").trim();
    const generalMsg = String(header.resultMsg ?? header.errMsg ?? header.message ?? "").trim();
    const reasonCode = String(header.returnReasonCode ?? "").trim();
    const detail = [authMsg || generalMsg, reasonCode ? `코드 ${reasonCode}` : ""].filter(Boolean).join(", ");
    return detail || null;
  } catch {
    return tagValue(raw, "resultMsg") || tagValue(raw, "errMsg") || stripXml(raw).slice(0, 240) || null;
  }
}

// getPrcrmntCorpBasicInfo02 1회 호출. inqryDiv 값 하나를 시도해 성공하면
// item 배열(0건일 수 있음)을, 파라미터/한도/인증 오류면 ok:false를 반환한다
// (예외를 던지지 않음 — 호출부에서 다음 inqryDiv 후보로 넘어가거나 중단할지
// 판단한다).
async function callGovCorpApi(
  bizno: string,
  inqryDiv: string,
  key: string,
): Promise<{
  ok: boolean;
  quotaExceeded: boolean;
  items: Record<string, unknown>[];
  errorDetail?: string;
}> {
  const query = [
    `serviceKey=${formatServiceKey(key)}`,
    "pageNo=1",
    "numOfRows=10",
    `inqryDiv=${inqryDiv}`,
    `bizno=${encodeURIComponent(bizno)}`,
    "type=json",
  ].join("&");
  const response = await requestBuffer(
    `https://apis.data.go.kr/1230000/ao/UsrInfoService02/getPrcrmntCorpBasicInfo02?${query}`,
  );
  const raw = response.body.toString("utf8");
  if (response.status < 200 || response.status >= 300) {
    const detail = extractGovApiErrorDetail(raw) ?? `HTTP ${response.status}`;
    return { ok: false, quotaExceeded: isGovApiQuotaOrAuthError(detail), items: [], errorDetail: detail };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, quotaExceeded: false, items: [], errorDetail: stripXml(raw).slice(0, 240) };
  }
  const envelope = (payload.OpenAPI_ServiceResponse ?? payload.response ?? payload) as Record<string, unknown>;
  const header = (envelope.cmmMsgHeader ?? envelope.header ?? payload.header) as
    | Record<string, unknown>
    | undefined;
  const resultCode = header?.resultCode != null ? String(header.resultCode).trim() : null;
  if (resultCode && resultCode !== "00" && resultCode !== "0") {
    const detail = String(header?.resultMsg ?? header?.errMsg ?? `resultCode=${resultCode}`).trim();
    return { ok: false, quotaExceeded: isGovApiQuotaOrAuthError(detail), items: [], errorDetail: detail };
  }
  return { ok: true, quotaExceeded: false, items: normalizeItems(payload) };
}

// 낙찰자 사업자등록번호로 조달청에 정식 등록된 주소/전화번호를 조회한다.
// 절대 예외를 던지지 않는다 — 호출부(resolveBidderContact 등)가 이 결과가
// 없어도 나머지 보완 단계(첨부파일/Naver)로 계속 진행할 수 있어야 한다.
export async function lookupGovCorpInfo(
  bizno: string | null | undefined,
): Promise<{ address?: string; phone?: string } | null> {
  const trimmedBizno = (bizno ?? "").replace(/[^0-9]/g, "");
  if (trimmedBizno.length !== 10) return null;
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key) return null;

  const cached = await getCachedGovCorpInfo(trimmedBizno);
  if (cached.checked) {
    return cached.address || cached.phone ? { address: cached.address, phone: cached.phone } : null;
  }
  if (!govRegistryGuardAllow()) return null;

  const candidates = [govRegistryGuard.resolvedInqryDiv, "1", "2", "3"].filter(
    (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index,
  );

  for (const inqryDiv of candidates) {
    if (!govRegistryGuardAllow()) return null;
    govRegistryGuardRecordCall();
    let result: Awaited<ReturnType<typeof callGovCorpApi>>;
    try {
      result = await callGovCorpApi(trimmedBizno, inqryDiv, key);
    } catch (error) {
      govRegistryGuardRecordFailure(describeError(error));
      logger.warn({ err: error, bizno: trimmedBizno }, "조달청 사용자정보 API 호출 실패");
      // 네트워크/회로차단 오류는 inqryDiv 값 문제가 아니므로 다른 값으로
      // 재시도하지 않는다. 캐시에도 남기지 않아 다음 스캔에서 다시 시도된다.
      return null;
    }
    if (!result.ok) {
      govRegistryGuardRecordFailure(result.errorDetail ?? "");
      if (result.quotaExceeded) {
        logger.warn(
          { bizno: trimmedBizno, detail: result.errorDetail },
          "조달청 사용자정보 API 한도/권한 오류 — 오늘은 중단",
        );
        return null;
      }
      continue; // 파라미터(inqryDiv) 오류로 추정 — 다음 후보 값으로 재시도.
    }
    govRegistryGuardRecordSuccess();
    govRegistryGuard.resolvedInqryDiv = inqryDiv;
    const item = result.items[0];
    if (!item) {
      await cacheGovCorpInfo(trimmedBizno, null);
      return null;
    }
    const address = [String(item.adrs ?? "").trim(), String(item.dtlAdrs ?? "").trim()]
      .filter(Boolean)
      .join(" ")
      .trim();
    const phone = String(item.telNo ?? "").trim();
    const found: { address?: string; phone?: string } = {};
    if (address) found.address = address;
    if (phone) found.phone = phone;
    const finalResult = address || phone ? found : null;
    await cacheGovCorpInfo(trimmedBizno, finalResult);
    return finalResult;
  }
  logger.warn({ bizno: trimmedBizno }, "조달청 사용자정보 API: 모든 inqryDiv 후보 실패, 결과 없음 처리");
  return null;
}

export async function requestBuffer(url: string, timeoutMs = 45_000, redirects = 0): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  assertCircuitAvailable();
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  try {
    const response = await new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: Buffer;
    }>((resolve, reject) => {
      const target = new URL(url);
      const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
      const startedAt = Date.now();
      let phase = "dns";
      let settled = false;
      const request = httpsRequest(target, {
        method: "GET",
        agent,
        ...(agent ? {} : {
          autoSelectFamily: true,
          autoSelectFamilyAttemptTimeout: 250,
        }),
        headers: {
          Accept: "application/json, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7",
          "User-Agent": "Mozilla/5.0 BidAttachmentSearch/1.0",
        },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => {
          settled = true;
          clearTimeout(hardTimeout);
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          });
        });
      });
      request.on("socket", (socket) => {
        socket.once("lookup", () => {
          phase = "connect";
        });
        socket.once("connect", () => {
          phase = "tls";
        });
        socket.once("secureConnect", () => {
          phase = "response";
        });
      });
      const hardTimeout = setTimeout(() => {
        if (settled) return;
        const error = Object.assign(new Error(`요청 시간 제한 ${timeoutMs}ms 초과`), {
          code: "ETIMEDOUT",
          hostname: target.hostname,
          syscall: phase === "dns" ? "getaddrinfo" : phase === "connect" ? "connect" : phase,
          phase,
          elapsedMs: Date.now() - startedAt,
        });
        request.destroy(error);
      }, timeoutMs);
      request.on("error", (error) => {
        settled = true;
        clearTimeout(hardTimeout);
        reject(error);
      });
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      if (redirects >= 5) throw new Error("HTTP 리다이렉트가 5회를 초과했습니다.");
      const location = Array.isArray(response.headers.location)
        ? response.headers.location[0]
        : response.headers.location;
      return requestBuffer(new URL(location, url).toString(), timeoutMs, redirects + 1);
    }
    recordNetworkSuccess();
    return response;
  } catch (error) {
    if (error instanceof CircuitOpenError) throw error;
    return recordNetworkFailure(error);
  }
}

type JobState = "queued" | "running" | "completed" | "completed_with_errors" | "failed";
type NoticeState = "queued" | "running" | "completed" | "partial" | "failed";

export interface SearchResult {
  noticeNumber: string;
  noticeName: string | null;
  attachmentFileName: string;
  downloadStatus: "success" | "failed";
  downloadError: string | null;
  parseStatus: "success" | "failed" | "not_applicable";
  parseError: string | null;
  resultStatus:
    | "keyword_found"
    | "keyword_not_found"
    | "no_attachment"
    | "download_failed"
    | "parse_failed"
    | "not_awarded";
  retryCount: number;
  keywordFound: boolean;
  foundKeywords: string[];
  fileName: string;
  sheet: string | null;
  page: number | null;
  location: string;
  surroundingText: string;
  originalText: string;
  itemSpecification?: string;
  itemName?: string;
  itemQuantity?: string;
  itemUnit?: string;
  itemAmount?: string;
  bidderName?: string;
  awardIdentifier?: string;
  awardDate?: string;
  awardAmount?: string;
  bidderAddress?: string;
  bidderPhone?: string;
  budgetAmount?: string;
  estimatedAmount?: string;
  baseAmount?: string;
  constructionOverview?: string;
  awardStatus?: "confirmed" | "not_found";
  contactSource?: "government" | "attachment" | "registry" | "portal" | "web";
}

export interface AttachmentResult {
  fileName: string;
  url: string;
  priority: boolean;
  downloadStatus: "pending" | "success" | "failed";
  downloadError: string | null;
  attempts: number;
  parsedFileCount: number;
  parseFailureCount: number;
  keywordFound: boolean;
}

export interface NoticeResult {
  noticeNumber: string;
  noticeName: string | null;
  requestedOrder: string;
  resolvedOrder: string | null;
  orderMatched: boolean | null;
  lookupAttempts: number;
  status: NoticeState;
  attachmentCount: number;
  downloadedCount: number;
  failedCount: number;
  keywordHitCount: number;
  parseFailureCount: number;
  attachments: AttachmentResult[];
  budgetAmount?: string;
  estimatedAmount?: string;
  baseAmount?: string;
  constructionOverview?: string;
  // Set up front (before attachments are even looked at) from the government
  // award record: notices with no confirmed winner skip attachment download
  // and keyword search entirely — there is no one to pitch to yet.
  awardStatus?: "confirmed" | "not_found";
  bidderName?: string | null;
  error: string | null;
}

export interface CollectionJob {
  jobId: string;
  status: JobState;
  totalCount: number;
  completedCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  currentNoticeNumber: string | null;
  notices: NoticeResult[];
  searchResults: SearchResult[];
  keywords: string[];
  requestKey: string;
  reusedFromJobId: string | null;
  summary: {
    notices: number;
    attachments: number;
    downloaded: number;
    downloadFailures: number;
    parseFailures: number;
    lookupFailures: number;
    filesWithKeywords: number;
    keywordMatches: number;
  };
  error: string | null;
}

export interface ExtractedSegment {
  text: string;
  itemContext?: string;
  sheet: string | null;
  page: number | null;
  location: string;
}

interface AttemptResult<T> {
  value: T;
  attempts: number;
  previousErrors: string[];
}

const jobs = new Map<string, CollectionJob>();
let persistChain = Promise.resolve();

function decodeXml(value: string): string {
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

function stripXml(xml: string): string {
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

export function sanitizeName(value: string, fallback = "attachment"): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Keep the source name when it is not URL-encoded.
  }
  const cleaned = decoded
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.\.+/g, "_")
    .trim();
  return cleaned.slice(0, 180) || fallback;
}

export function formatServiceKey(key: string): string {
  return /%[0-9a-f]{2}/i.test(key) ? key : encodeURIComponent(key);
}

function parseNoticeNumber(value: string): { base: string; order: string } {
  const match = /^(R[0-9A-Z]{12})-(\d{3})$/.exec(value);
  if (!match) throw new Error(`올바르지 않은 공고번호 형식: ${value}`);
  return { base: match[1], order: match[2] };
}

export function normalizeItems(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const response = (root.response ?? root) as Record<string, unknown>;
  const body = (response.body ?? response) as Record<string, unknown>;
  const items = body.items;
  if (Array.isArray(items)) return items as Record<string, unknown>[];
  if (items && typeof items === "object") {
    const item = (items as Record<string, unknown>).item;
    if (Array.isArray(item)) return item as Record<string, unknown>[];
    if (item && typeof item === "object") return [item as Record<string, unknown>];
  }
  return [];
}

function tagValue(xml: string, name: string): string {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return match ? decodeXml(match[1]).trim() : "";
}

function parseXmlItems(xml: string): Record<string, unknown>[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item: Record<string, unknown> = {};
    for (const tag of match[1].matchAll(/<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g)) {
      item[tag[1]] = decodeXml(tag[2]).trim();
    }
    return item;
  });
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 3,
): Promise<AttemptResult<T>> {
  const previousErrors: string[] = [];
  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    try {
      return { value: await operation(), attempts, previousErrors };
    } catch (error) {
      previousErrors.push(describeError(error));
      if (error instanceof CircuitOpenError) throw error;
      if (attempts < maxAttempts) {
        const backoffMs = Math.min(15_000, 750 * 2 ** (attempts - 1));
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw new Error(`총 ${maxAttempts}회 시도 실패: ${previousErrors.join(" | ")}`);
}

async function fetchNotice(noticeNumber: string): Promise<Record<string, unknown>> {
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key) throw new Error("서버에 DATA_GO_KR_SERVICE_KEY가 설정되지 않았습니다.");
  const { base, order } = parseNoticeNumber(noticeNumber);
  const query = [
    `serviceKey=${formatServiceKey(key)}`,
    "pageNo=1",
    "numOfRows=100",
    "inqryDiv=2",
    `bidNtceNo=${encodeURIComponent(base)}`,
    "type=json",
  ].join("&");
  const response = await requestBuffer(`${API_BASE}?${query}`);
  const raw = response.body.toString("utf8");
  if (response.status < 200 || response.status >= 300) {
    let detail = "";
    try {
      const json = JSON.parse(raw) as Record<string, unknown>;
      const serviceResponse = (json.OpenAPI_ServiceResponse ??
        json.response ??
        json) as Record<string, unknown>;
      const header = (serviceResponse.cmmMsgHeader ??
        serviceResponse.header ??
        json.header ??
        serviceResponse) as Record<string, unknown>;
      const authMessage = String(header.returnAuthMsg ?? "").trim();
      const reasonCode = String(header.returnReasonCode ?? "").trim();
      const generalMessage = String(
        header.resultMsg ?? header.errMsg ?? header.message ?? "",
      ).trim();
      detail = [
        authMessage || generalMessage,
        reasonCode ? `오류코드 ${reasonCode}` : "",
      ]
        .filter(Boolean)
        .join(", ");
    } catch {
      detail =
        tagValue(raw, "resultMsg") ||
        tagValue(raw, "errMsg") ||
        stripXml(raw).slice(0, 240);
    }
    throw new Error(
      `나라장터 API 응답 오류 (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  let items: Record<string, unknown>[] = [];
  try {
    items = normalizeItems(JSON.parse(raw));
  } catch {
    const resultCode = tagValue(raw, "resultCode");
    const resultMsg = tagValue(raw, "resultMsg");
    if (resultCode && resultCode !== "00") {
      throw new Error(resultMsg || `나라장터 API 오류 ${resultCode}`);
    }
    items = parseXmlItems(raw);
  }
  const wanted = Number.parseInt(order, 10);
  const selected = items.find((item) => Number(item.bidNtceOrd) === wanted);
  if (!selected) {
    throw new Error(`공고 차수 ${order}에 해당하는 응답을 찾지 못했습니다.`);
  }
  return selected;
}

export function compactDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

async function fetchAwards(targets: Set<string>): Promise<Map<string, Record<string, unknown>>> {
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key || targets.size === 0) return new Map();
  const found = new Map<string, Record<string, unknown>>();
  const end = new Date();
  for (let windowIndex = 0; windowIndex < 4 && found.size < targets.size; windowIndex += 1) {
    const windowEnd = new Date(end);
    windowEnd.setDate(end.getDate() - windowIndex * 30);
    const windowStart = new Date(windowEnd);
    windowStart.setDate(windowEnd.getDate() - 29);
    let page = 1;
    let totalPages = 1;
    do {
      const query = [
        `serviceKey=${formatServiceKey(key)}`,
        `pageNo=${page}`,
        "numOfRows=999",
        "inqryDiv=2",
        `inqryBgnDt=${compactDate(windowStart)}0000`,
        `inqryEndDt=${compactDate(windowEnd)}2359`,
        "type=json",
      ].join("&");
      const response = await requestBuffer(
        `https://apis.data.go.kr/1230000/as/ScsbidInfoService/getScsbidListSttusCnstwk?${query}`,
      );
      if (response.status < 200 || response.status >= 300) break;
      const payload = JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
      const body = ((payload.response as Record<string, unknown>)?.body ?? {}) as Record<string, unknown>;
      const items = normalizeItems(payload);
      totalPages = Math.max(1, Math.ceil(Number(body.totalCount ?? 0) / 999));
      for (const item of items) {
        const key = `${item.bidNtceNo}-${String(item.bidNtceOrd ?? "").padStart(3, "0")}`;
        if (targets.has(key)) found.set(key, item);
      }
      page += 1;
    } while (page <= totalPages && found.size < targets.size);
  }
  return found;
}

export function extractItemFields(text: string, keywords: readonly string[] = DEFAULT_KEYWORDS): Pick<SearchResult, "itemName" | "itemSpecification" | "itemQuantity" | "itemUnit" | "itemAmount"> {
  // xlsx cells arrive already joined as "A1=텍스트 | B1=텍스트" (see extractXlsx's
  // itemContext), but text pulled from a PDF/HWP/DOCX table row has no "|" —
  // it is one flat line such as "부직포설치\t1Ton/m\t11.7\t㎡" where the columns
  // are separated by tabs or runs of 2+ spaces (pdftotext -layout). Split on
  // those too so a spec/rate cell like "1Ton/m" doesn't get lumped together
  // with the real quantity/unit cells that follow it.
  const cellValues = text
    .split(text.includes("|") ? "|" : /\t+|\s{2,}/)
    .map((part) => part.trim().replace(/^[A-Z]+\d+=/, "").trim())
    .filter(Boolean);
  const keywordIndex = cellValues.findIndex((value) => keywords.some((keyword) => value.includes(keyword)));
  const unitPattern = /^(?:㎡|m²|m2|M2|m|kg|ton|톤|매|개|식)$/i;
  const numericPattern = /^[0-9][0-9,]*(?:\.[0-9]+)?$/;
  const unitIndex = cellValues.findIndex((value) => unitPattern.test(value));
  const adjacentQuantity =
    unitIndex > 0 && numericPattern.test(cellValues[unitIndex - 1])
      ? cellValues[unitIndex - 1]
      : unitIndex >= 0 && numericPattern.test(cellValues[unitIndex + 1] ?? "")
        ? cellValues[unitIndex + 1]
        : undefined;
  const adjacentSpecification =
    keywordIndex >= 0 &&
    cellValues[keywordIndex + 1] &&
    !unitPattern.test(cellValues[keywordIndex + 1]) &&
    !numericPattern.test(cellValues[keywordIndex + 1])
      ? cellValues[keywordIndex + 1]
      : undefined;
  const specification =
    text.match(/(?:규격|두께|폭|길이)\s*[:：]?\s*([0-9.,]+\s*(?:mm|cm|m|㎡|m²|g\/㎡|kg\/㎡))/i)?.[1] ??
    text.match(/[0-9.,]+\s*(?:mm|cm|g\/㎡|kg\/㎡)/i)?.[0] ??
    adjacentSpecification;
  // 요구사항(2026-09-12 사용자 리포트: R26BK01648131-000 공고 — 첨부파일의
  // "부직포설치	1Ton/m	11.7	㎡"에서 실제 수량인 "11.7 ㎡"를 찾아야 하는데
  // "1Ton/m"의 "1"+"Ton"이 먼저 매칭돼 엉뚱하게 "1 Ton"으로 표시됐음):
  // 단위 바로 뒤에 "/"가 오는 표현("1Ton/m", "5kg/㎡" 등)은 실제 수량이 아니라
  // 규격/단가성 비율 표기이므로 후보에서 제외하고, 그 뒤에 나오는 진짜
  // 수량+단위(예: "11.7 ㎡")를 찾는다. 또한 원래 정규식의 "\b"는 "㎡"·"m²"
  // 같은 기호 문자를 단어문자로 취급하지 않아 뒤에 아무것도 없어도 항상
  // 매칭에 실패했으므로(예: "500 ㎡" 전체가 무시됨), 숫자/영문/한글이 바로
  // 뒤따르지 않는지를 직접 확인하는 방식으로 대체한다.
  const UNIT_ALTERNATION = "㎡|m²|m2|M2|m|kg|ton|톤|매|개|식";
  const quantityMatch = [
    ...text.matchAll(
      new RegExp(
        `([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*(${UNIT_ALTERNATION})(?!\\s*/)(?![0-9A-Za-z가-힣])`,
        "gi",
      ),
    ),
  ][0];
  const amount = text.match(/(?:금액|합계)\s*[:：]?\s*([0-9][0-9,]*)\s*원?/i)?.[1];
  // 요구사항(2026-09-11 사용자 요청: "일일 검색결과에서 수량에 소숫점 이하가
  // 무한대일때 무한대로 나오네. 소수점 이하는 절삭해서 보여줘"): 원문 첨부파일
  // (엑셀→PDF 변환 등)의 부동소수점 오차로 소수점 이하 자릿수가 끝없이 길게
  // 찍히는 경우가 있어, 화면/CSV에 그대로 노출하면 숫자가 "무한히" 이어지는
  // 것처럼 보인다. 반올림이 아니라 절삭(소수점 이하 버림)으로 정수부만 남긴다.
  const rawQuantity = quantityMatch?.[1] ?? adjacentQuantity;
  const itemQuantity = rawQuantity ? rawQuantity.split(".")[0] : undefined;
  return {
    itemName: keywordIndex >= 0 ? cellValues[keywordIndex] : "미공개/확인불가",
    itemSpecification: specification ?? "미공개/확인불가",
    itemQuantity: itemQuantity ?? "미공개/확인불가",
    itemUnit: quantityMatch?.[2] ?? (unitIndex >= 0 ? cellValues[unitIndex] : "미공개/확인불가"),
    itemAmount: amount ?? "미공개/확인불가",
  };
}

const BUSINESS_PHONE_PATTERN =
  /(?:전화(?:번호)?|TEL|Tel|연락처|대표\s*번호|대표\s*전화)\s*[:：|]?\s*(0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4})/;
const BUSINESS_PHONE_FALLBACK_PATTERN = /0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}/;
// Attachment text is often flattened from spreadsheet cells with "|" as the
// cell separator (see extractItemFields below), so the value can follow the
// label with a colon, a pipe, or nothing at all.
const BUSINESS_ADDRESS_PATTERN =
  /(?:사업장\s*소재지|본점\s*소재지|본사\s*소재지|소재지|주소)\s*[:：|]?\s*([^\n\r|]{5,80})/;

// Looks for the winning bidder's company name inside already-parsed document
// text and, if found, pulls an address/phone mentioned nearby. Free — no
// network call — so this is always tried before the paid/rate-limited portal
// search below.
export function extractBusinessContactFromText(
  text: string,
  companyName: string,
): { address?: string; phone?: string } {
  const trimmedName = companyName.trim();
  if (!trimmedName || trimmedName === "미공개/확인불가") return {};
  const index = text.indexOf(trimmedName);
  if (index < 0) return {};
  const windowText = text.slice(Math.max(0, index - 200), index + trimmedName.length + 400);
  const phone =
    windowText.match(BUSINESS_PHONE_PATTERN)?.[1] ?? windowText.match(BUSINESS_PHONE_FALLBACK_PATTERN)?.[0];
  const address = windowText.match(BUSINESS_ADDRESS_PATTERN)?.[1]?.trim();
  const found: { address?: string; phone?: string } = {};
  if (address) found.address = address;
  if (phone) found.phone = phone;
  return found;
}

// Re-reads the notice's already-downloaded attachment files (kept on disk for
// the ZIP download) looking for the winning bidder's company name.
async function findBusinessContactInAttachments(
  job: CollectionJob,
  noticeNumber: string,
  companyName: string,
): Promise<{ address?: string; phone?: string }> {
  const noticeDir = path.join(jobDirectory(job.jobId), noticeNumber);
  const files = new Set(
    job.searchResults
      .filter((result) => result.noticeNumber === noticeNumber && result.fileName && result.fileName !== "-")
      .map((result) => path.join(noticeDir, result.fileName)),
  );
  for (const filePath of files) {
    try {
      const segments = await extractSegments(filePath);
      const text = segments.map((segment) => segment.itemContext ?? segment.text).join("\n");
      const found = extractBusinessContactFromText(text, companyName);
      if (found.address || found.phone) return found;
    } catch {
      // Best-effort: skip files that can no longer be parsed here.
    }
  }
  return {};
}

// 요구사항(전화번호 정확도 보완, 2026-09-09 사용자 리포트: "회사이름과 주소를
// 교차검증하면 전화번호를 정확히 찾을 수 있을 것 같아"): 회사명만으로 검색하면
// 전국에 같은/비슷한 이름의 다른 업체가 걸려 엉뚱한 번호를 가져올 수 있다.
// 이미 알고 있는 주소(정부 낙찰기록·첨부파일 등에서)가 있으면 "시/도 + 시/군/구"
// 정도의 지역명을 뽑아 검색어에 더해 같은 지역의 업체를 우선하도록 돕는다.
function regionHint(address: string | null | undefined): string | null {
  if (!address) return null;
  const match = address
    .trim()
    .match(/^(\S+(?:특별시|광역시|특별자치시|특별자치도|도))\s+(\S+(?:시|군|구))/);
  return match ? `${match[1]} ${match[2]}` : null;
}

// Naver's 지역검색(Local Search) open API: given a business name, returns its
// road address and listed phone number. Free tier (NAVER_CLIENT_ID /
// NAVER_CLIENT_SECRET, see replit.md) — used only as a last resort when
// neither the government award record nor the notice's attachments have
// contact details for the winning bidder. When a known address is passed in,
// its region is added to the query and cross-checked against the result's
// address so a same-named business in a different city isn't mistaken for
// the real one.
export async function searchBusinessContactOnPortal(
  companyName: string,
  knownAddress?: string | null,
): Promise<{ address?: string; phone?: string } | null> {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  const trimmedName = companyName.trim();
  if (!clientId || !clientSecret || !trimmedName || trimmedName === "미공개/확인불가") return null;
  const region = regionHint(knownAddress);
  const query = region ? `${trimmedName} ${region}` : trimmedName;
  const cacheKey = `${trimmedName}::${region ?? ""}`;

  // 요구사항(2026-09-11): 같은 회사(+지역)는 평생 한 번만 조회한다 — 이미
  // 조회했던 적이 있으면(못 찾은 경우 포함) 캐시된 값을 그대로 쓰고 API를
  // 다시 부르지 않는다.
  const cached = await getCachedPortalContact(cacheKey);
  if (cached.checked) {
    return cached.address || cached.phone ? { address: cached.address, phone: cached.phone } : null;
  }
  if (!naverGuardAllow()) return null;

  try {
    const url = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(query)}&display=1`;
    naverGuardRecordCall();
    const response = await fetch(url, {
      headers: {
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // 200이 아니면 "결과 없음"이 아니라 인증/한도 문제일 수 있으므로, 화면에서는
      // 조용히 넘어가더라도 로그에는 원인 파악용으로 상태코드를 남긴다. 한도/장애성
      // 오류일 수 있으므로 캐시에는 남기지 않아 다음에 다시 시도될 수 있게 한다.
      naverGuardRecordFailure(`HTTP ${response.status} ${response.statusText}`);
      logger.warn(
        { status: response.status, statusText: response.statusText, companyName: trimmedName },
        "Naver local search returned a non-OK response",
      );
      return null;
    }
    naverGuardRecordSuccess();
    const payload = (await response.json()) as {
      items?: { address?: string; roadAddress?: string; telephone?: string }[];
    };
    const item = payload.items?.[0];
    if (!item) {
      await cachePortalContact(cacheKey, null);
      return null;
    }
    const address = (item.roadAddress || item.address || "").trim();
    const phone = (item.telephone || "").trim();
    if (!address && !phone) {
      await cachePortalContact(cacheKey, null);
      return null;
    }
    // 지역을 알고 있는데 검색 결과 주소가 그 지역이 아니면(동명 다른 업체일 가능성),
    // 전화번호는 신뢰하지 않고 주소만(있다면) 참고용으로 남긴다.
    const regionMismatch = Boolean(region && address && !address.includes(region.split(" ")[1] ?? region));
    const found: { address?: string; phone?: string } = {};
    if (address) found.address = address;
    if (phone && !regionMismatch) found.phone = phone;
    const result = address || found.phone ? found : null;
    await cachePortalContact(cacheKey, result);
    return result;
  } catch (error) {
    naverGuardRecordFailure(describeError(error));
    logger.warn({ err: error, companyName: trimmedName }, "Naver local search failed");
    return null;
  }
}

// 요구사항(전화번호 검색 보완, 2026-09-09 사용자 리포트: "너가 생각했을 때
// 내가 전화번호를 찾아내고 싶어. 방법을 만들어봐"): 네이버 지역검색(Local
// Search)은 "스마트플레이스"에 등록된 업체(주로 식당/매장)만 색인하기 때문에
// 협동조합·비영리단체 같은 곳은 검색해도 안 나온다(명문사회적협동조합 사례로
// 확인됨). 같은 NAVER_CLIENT_ID/SECRET으로 쓸 수 있는 네이버 웹문서/블로그
// 검색 API는 훨씬 넓은 범위를 색인하므로, 회사명이 실제로 언급된 검색결과
// 스니펫에서 전화번호 패턴을 정규식으로 추출해 최후의 보완 수단으로 쓴다.
// 정확도가 구조화된 지역검색보다는 낮으므로 contactSource를 "web"으로 따로
// 표시해 화면에서 구분한다.
function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'");
}

async function searchNaverText(
  endpoint: "webkr" | "blog",
  query: string,
): Promise<{ title: string; description: string }[]> {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];
  if (!naverGuardAllow()) return [];
  try {
    const url = `https://openapi.naver.com/v1/search/${endpoint}.json?query=${encodeURIComponent(query)}&display=5`;
    naverGuardRecordCall();
    const response = await fetch(url, {
      headers: {
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      naverGuardRecordFailure(`HTTP ${response.status} ${response.statusText}`);
      logger.warn(
        { status: response.status, statusText: response.statusText, endpoint, query },
        "Naver text search returned a non-OK response",
      );
      return [];
    }
    naverGuardRecordSuccess();
    const payload = (await response.json()) as { items?: { title?: string; description?: string }[] };
    return (payload.items ?? []).map((item) => ({
      title: stripHtml(item.title ?? ""),
      description: stripHtml(item.description ?? ""),
    }));
  } catch (error) {
    naverGuardRecordFailure(describeError(error));
    logger.warn({ err: error, endpoint, query }, "Naver text search failed");
    return [];
  }
}

// 네이버 웹문서 검색 → 안 나오면 블로그 검색 순으로 "회사명 (지역) 전화번호"를
// 찾아 본다. 알고 있는 주소가 있으면 지역명을 검색어에 더해 동명의 다른 업체가
// 섞여 들어올 확률을 낮춘다. 회사명이 실제 스니펫에 등장하는 결과만 신뢰하고,
// 라벨이 붙은 전화번호 패턴을 우선하고 없으면 느슨한 패턴으로 한 번 더 시도한다.
export async function searchBusinessContactOnWeb(
  companyName: string,
  knownAddress?: string | null,
): Promise<{ phone?: string } | null> {
  const trimmedName = companyName.trim();
  if (!trimmedName || trimmedName === "미공개/확인불가") return null;
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) return null;

  const region = regionHint(knownAddress);
  const cacheKey = `${trimmedName}::${region ?? ""}`;

  // 요구사항(2026-09-11): 같은 회사(+지역)는 평생 한 번만 조회한다 — 이미
  // 조회했던 적이 있으면(못 찾은 경우 포함) 캐시된 값을 그대로 쓴다.
  const cached = await getCachedWebContact(cacheKey);
  if (cached.checked) {
    return cached.phone ? { phone: cached.phone } : null;
  }
  if (!naverGuardAllow()) return null;

  const queries = region ? [`${trimmedName} ${region} 전화번호`, `${trimmedName} 전화번호`] : [`${trimmedName} 전화번호`];

  // 결과가 확정적일 때만(중간에 한도/회로차단으로 못 부른 게 아닐 때만)
  // "못 찾음"을 캐시한다 — 그래야 일시적 장애로 놓친 경우 다음 스캔에서
  // 다시 시도된다.
  let foundPhone: string | undefined;
  let definitive = true;
  outer: for (const query of queries) {
    for (const endpoint of ["webkr", "blog"] as const) {
      if (!naverGuardAllow()) {
        definitive = false;
        break outer;
      }
      const items = await searchNaverText(endpoint, query);
      for (const item of items) {
        const combined = `${item.title} ${item.description}`;
        if (!combined.includes(trimmedName)) continue;
        const phone =
          combined.match(BUSINESS_PHONE_PATTERN)?.[1] ?? combined.match(BUSINESS_PHONE_FALLBACK_PATTERN)?.[0];
        if (phone) {
          foundPhone = phone;
          break outer;
        }
      }
    }
  }

  if (definitive) {
    await cacheWebContact(cacheKey, foundPhone ?? null);
  }
  return foundPhone ? { phone: foundPhone } : null;
}

// Fills in bidderAddress/bidderPhone when the government award record left
// them blank: the notice's own attachments are tried first (free), then the
// portal search (rate-limited, needs credentials).
async function fillMissingBusinessContact(
  job: CollectionJob,
  result: SearchResult,
  bizno?: string | null,
): Promise<void> {
  if (!result.bidderName || result.bidderName === "미공개/확인불가") return;
  const needsAddress = !result.bidderAddress || result.bidderAddress === "미공개/확인불가";
  const needsPhone =
    !result.bidderPhone || result.bidderPhone === "미공개/확인불가" || result.bidderPhone.includes("*");
  if (!needsAddress && !needsPhone) return;

  const fromAttachment = await findBusinessContactInAttachments(job, result.noticeNumber, result.bidderName);
  if (needsAddress && fromAttachment.address) {
    result.bidderAddress = fromAttachment.address;
    result.contactSource ??= "attachment";
  }
  if (needsPhone && fromAttachment.phone) {
    result.bidderPhone = fromAttachment.phone;
    result.contactSource ??= "attachment";
  }

  let stillNeedsAddress = !result.bidderAddress || result.bidderAddress === "미공개/확인불가";
  let stillNeedsPhone =
    !result.bidderPhone || result.bidderPhone === "미공개/확인불가" || result.bidderPhone.includes("*");
  if (!stillNeedsAddress && !stillNeedsPhone) return;

  // 요구사항(2026-09-11 사용자 요청): 정부 낙찰기록/첨부파일에도 없으면,
  // 네이버 검색(회사명 텍스트 매칭이라 동명업체 오류 가능)보다 먼저 사업자
  // 등록번호로 조달청 정식 등록정보를 정확 매칭 조회한다.
  if (bizno) {
    const fromRegistry = await lookupGovCorpInfo(bizno);
    if (fromRegistry) {
      if (stillNeedsAddress && fromRegistry.address) {
        result.bidderAddress = fromRegistry.address;
        result.contactSource ??= "registry";
      }
      if (stillNeedsPhone && fromRegistry.phone) {
        result.bidderPhone = fromRegistry.phone;
        result.contactSource ??= "registry";
      }
    }
    stillNeedsAddress = !result.bidderAddress || result.bidderAddress === "미공개/확인불가";
    stillNeedsPhone =
      !result.bidderPhone || result.bidderPhone === "미공개/확인불가" || result.bidderPhone.includes("*");
    if (!stillNeedsAddress && !stillNeedsPhone) return;
  }

  const knownAddress =
    result.bidderAddress && result.bidderAddress !== "미공개/확인불가" ? result.bidderAddress : null;

  const fromPortal = await searchBusinessContactOnPortal(result.bidderName, knownAddress);
  if (fromPortal) {
    if (stillNeedsAddress && fromPortal.address) {
      result.bidderAddress = fromPortal.address;
      result.contactSource ??= "portal";
    }
    if (stillNeedsPhone && fromPortal.phone) {
      result.bidderPhone = fromPortal.phone;
      result.contactSource ??= "portal";
    }
  }

  const stillNeedsPhoneAfterPortal =
    !result.bidderPhone || result.bidderPhone === "미공개/확인불가" || result.bidderPhone.includes("*");
  if (stillNeedsPhoneAfterPortal) {
    const fromWeb = await searchBusinessContactOnWeb(result.bidderName, knownAddress);
    if (fromWeb?.phone) {
      result.bidderPhone = fromWeb.phone;
      result.contactSource = "web";
    }
  }
}

async function enrichKeywordResults(job: CollectionJob, awards: Map<string, Record<string, unknown>>): Promise<void> {
  for (const result of job.searchResults.filter((candidate) => candidate.keywordFound)) {
    const notice = job.notices.find((candidate) => candidate.noticeNumber === result.noticeNumber);
    const award = awards.get(result.noticeNumber);
    Object.assign(result, extractItemFields(result.originalText, job.keywords));
    result.bidderName = String(award?.bidwinnrNm ?? "미공개/확인불가");
    result.awardIdentifier = award
      ? `${award.bidNtceNo ?? result.noticeNumber.slice(0, -4)}-${String(award.bidNtceOrd ?? "").padStart(3, "0")}/재입찰 ${String(award.rbidNo ?? "000")}`
      : "미공개/확인불가";
    result.awardDate = String(award?.fnlSucsfDate ?? award?.rlOpengDt ?? "미공개/확인불가");
    result.awardAmount = String(award?.sucsfbidAmt ?? "미공개/확인불가");
    result.bidderAddress = String(award?.bidwinnrAdrs ?? "미공개/확인불가");
    result.bidderPhone = String(award?.bidwinnrTelNo ?? "미공개/확인불가");
    result.budgetAmount = notice?.budgetAmount ?? "미공개/확인불가";
    result.estimatedAmount = notice?.estimatedAmount ?? "미공개/확인불가";
    result.baseAmount = notice?.baseAmount ?? "미공개/확인불가";
    result.constructionOverview = notice?.constructionOverview ?? "미공개/확인불가";
    result.awardStatus = award ? "confirmed" : "not_found";
    result.contactSource = award?.bidwinnrAdrs || award?.bidwinnrTelNo ? "government" : undefined;
    try {
      await fillMissingBusinessContact(job, result, award?.bidwinnrBizno ? String(award.bidwinnrBizno).trim() : null);
    } catch (error) {
      logger.warn(
        { err: error, noticeNumber: result.noticeNumber, bidderName: result.bidderName },
        "Could not fill missing business contact info",
      );
    }
  }
}

export function collectAttachments(item: Record<string, unknown>): { name: string; url: string }[] {
  const attachments: { name: string; url: string }[] = [];
  for (let index = 1; index <= 10; index += 1) {
    const url = String(item[`ntceSpecDocUrl${index}`] ?? "").trim();
    const name = String(item[`ntceSpecFileNm${index}`] ?? "").trim();
    if (url) attachments.push({ url: decodeXml(url), name: name || `attachment-${index}` });
  }
  return attachments;
}

export function isPriorityAttachment(fileName: string): boolean {
  return /(공내역|설계내역|물량내역|산출내역|내역서|수량산출|시방서)/i.test(fileName);
}

async function uniquePath(directory: string, fileName: string): Promise<string> {
  const parsed = path.parse(sanitizeName(fileName));
  let candidate = path.join(directory, `${parsed.name}${parsed.ext}`);
  let index = 2;
  while (true) {
    try {
      await access(candidate, fsConstants.F_OK);
      candidate = path.join(directory, `${parsed.name}-${index}${parsed.ext}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
}

function contentDispositionName(value: string | null): string | null {
  if (!value) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      return utf8[1];
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain?.[1] ?? null;
}

export async function downloadAttachment(
  url: string,
  directory: string,
  suggestedName: string,
): Promise<string> {
  const response = await requestBuffer(url, 90_000);
  if (response.status < 200 || response.status >= 300) throw new Error(`다운로드 HTTP ${response.status}`);
  const contentDisposition = response.headers["content-disposition"];
  const disposition = contentDispositionName(Array.isArray(contentDisposition) ? contentDisposition[0] : contentDisposition ?? null);
  const filePath = await uniquePath(directory, disposition || suggestedName);
  const bytes = response.body;
  if (bytes.length === 0) throw new Error("빈 파일이 반환되었습니다.");
  await writeFile(filePath, bytes);
  return filePath;
}

export async function command(command: string, args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
  return result.stdout;
}

async function extractZip(zipPath: string): Promise<string | null> {
  const archive = await unzipper.Open.file(zipPath);
  if (archive.files.length > 10_000) throw new Error("ZIP 항목 수가 안전 제한(10,000개)을 초과했습니다.");
  const totalUncompressed = archive.files.reduce(
    (total, entry) => total + Number(entry.uncompressedSize || 0),
    0,
  );
  if (totalUncompressed > 2 * 1024 * 1024 * 1024) {
    throw new Error("ZIP 압축 해제 크기가 안전 제한(2GB)을 초과했습니다.");
  }
  const target = `${zipPath.slice(0, -path.extname(zipPath).length)}_extracted`;
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const targetRoot = `${path.resolve(target)}${path.sep}`;
  for (const entry of archive.files) {
    const normalized = entry.path.replaceAll("\\", "/");
    if (
      path.posix.isAbsolute(normalized) ||
      normalized.split("/").some((part) => part === "..")
    ) {
      throw new Error(`안전하지 않은 ZIP 경로입니다: ${entry.path}`);
    }
    const destination = path.resolve(target, normalized);
    if (destination !== path.resolve(target) && !destination.startsWith(targetRoot)) {
      throw new Error(`ZIP 경로가 대상 폴더를 벗어납니다: ${entry.path}`);
    }
    if (entry.type === "Directory") {
      await mkdir(destination, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await pipeline(entry.stream(), createWriteStream(destination));
  }
  return target;
}

export async function extractZipRecursively(zipPath: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  const target = await extractZip(zipPath);
  if (!target) return [];
  const files = await walk(target);
  const expanded = [...files];
  for (const file of files) {
    if (path.extname(file).toLowerCase() === ".zip") {
      expanded.push(...(await extractZipRecursively(file, depth + 1)));
    }
  }
  return expanded;
}

async function walk(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(fullPath)));
    else if (entry.isFile()) output.push(fullPath);
  }
  return output;
}

function decodeText(bytes: Buffer): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const replacementRatio = (utf8.match(/\uFFFD/g)?.length ?? 0) / Math.max(utf8.length, 1);
  if (replacementRatio < 0.01) return utf8;
  try {
    return new TextDecoder("euc-kr", { fatal: false }).decode(bytes);
  } catch {
    return utf8;
  }
}

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
  return decodeText(await entry.buffer());
}

async function extractXlsx(filePath: string): Promise<ExtractedSegment[]> {
  const archive = await openZip(filePath);
  const entries = archive.files.map((entry) => entry.path);
  const sharedXml = await unzipText(archive, "xl/sharedStrings.xml");
  const sharedStrings = [...sharedXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    stripXml(match[1]),
  );
  const sheets = entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry));
  const segments: ExtractedSegment[] = [];
  for (const sheetEntry of sheets) {
    const xml = await unzipText(archive, sheetEntry);
    const sheetName = path.basename(sheetEntry, ".xml");
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: { address: string; text: string }[] = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const address = /\br="([^"]+)"/.exec(cell[1])?.[1] ?? "셀";
        const type = /\bt="([^"]+)"/.exec(cell[1])?.[1] ?? "";
        const body = cell[2];
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
      const itemContext = cells.map((cell) => `${cell.address}=${cell.text}`).join(" | ");
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
  const text = decodeText(await readFile(target));
  await rm(target, { force: true });
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

export async function extractSegments(filePath: string): Promise<ExtractedSegment[]> {
  const extension = path.extname(filePath).toLowerCase();
  if ([".xlsx", ".xlsm"].includes(extension)) return extractXlsx(filePath);
  if (extension === ".docx") {
    return extractOfficeXml(filePath, /^word\/document\.xml$/i, "DOCX");
  }
  if ([".hwpx", ".hwtx"].includes(extension)) {
    return extractOfficeXml(filePath, /^(?:Contents|contents)\/section\d+\.xml$/, "HWPX");
  }
  if (extension === ".pdf") return extractPdf(filePath);
  if ([".xls", ".hwp", ".doc"].includes(extension)) {
    return extractLegacy(filePath, extension);
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

export function searchSegments(segments: ExtractedSegment[], keywords: readonly string[]): {
  keywordFound: boolean;
  foundKeywords: string[];
  sheet: string | null;
  page: number | null;
  location: string;
  surroundingText: string;
  originalText: string;
}[] {
  const matches: ReturnType<typeof searchSegments> = [];
  for (const segment of segments) {
    const foundKeywords = keywords.filter((keyword) => segment.text.toLocaleLowerCase("ko-KR").includes(keyword.toLocaleLowerCase("ko-KR")));
    if (!foundKeywords.length) continue;
    const firstIndex = Math.min(
      ...foundKeywords.map((keyword) => segment.text.indexOf(keyword)).filter((index) => index >= 0),
    );
    matches.push({
      keywordFound: true,
      foundKeywords: [...foundKeywords],
      sheet: segment.sheet,
      page: segment.page,
      location: segment.location,
      surroundingText: (segment.itemContext ?? segment.text).slice(
        Math.max(0, firstIndex - 80),
        firstIndex + 500,
      ),
      originalText: segment.itemContext ?? segment.text,
    });
  }
  return matches;
}

function updateSummary(job: CollectionJob): void {
  job.summary = {
    notices: job.notices.length,
    attachments: job.notices.reduce((sum, item) => sum + item.attachmentCount, 0),
    downloaded: job.notices.reduce((sum, item) => sum + item.downloadedCount, 0),
    downloadFailures: job.notices.reduce((sum, item) => sum + item.failedCount, 0),
    parseFailures: job.notices.reduce((sum, item) => sum + item.parseFailureCount, 0),
    lookupFailures: job.notices.filter((item) => item.status === "failed" && !item.resolvedOrder).length,
    filesWithKeywords: new Set(
      job.searchResults
        .filter((item) => item.keywordFound)
        .map((item) => `${item.noticeNumber}/${item.fileName}`),
    ).size,
    keywordMatches: job.searchResults.filter((item) => item.keywordFound).length,
  };
  job.updatedAt = new Date().toISOString();
}

async function persistJob(job: CollectionJob): Promise<void> {
  persistChain = persistChain.then(async () => {
    await mkdir(jobDirectory(job.jobId), { recursive: true });
    const target = jobStatePath(job.jobId);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(job, null, 2));
    await cp(temporary, target);
    await rm(temporary, { force: true });
  });
  await persistChain;
}

function jobDirectory(jobId: string): string {
  return path.join(JOB_ROOT, sanitizeName(jobId));
}

function jobStatePath(jobId: string): string {
  return path.join(jobDirectory(jobId), "job.json");
}

async function processNotice(
  job: CollectionJob,
  notice: NoticeResult,
  award: Record<string, unknown> | null,
): Promise<void> {
  notice.status = "running";
  job.currentNoticeNumber = notice.noticeNumber;
  notice.awardStatus = award ? "confirmed" : "not_found";
  notice.bidderName = award ? String(award.bidwinnrNm ?? "").trim() || null : null;
  updateSummary(job);
  await persistJob(job);

  // No confirmed winner yet: there's no one to pitch to, so skip downloading
  // and searching this notice's attachments entirely and just record that.
  if (!award) {
    notice.status = "completed";
    job.searchResults.push({
      noticeNumber: notice.noticeNumber,
      noticeName: null,
      attachmentFileName: "-",
      downloadStatus: "failed",
      downloadError: "낙찰자가 아직 확정되지 않아 첨부파일 검색을 건너뛰었습니다.",
      parseStatus: "not_applicable",
      parseError: null,
      resultStatus: "not_awarded",
      retryCount: 0,
      keywordFound: false,
      foundKeywords: [],
      fileName: "-",
      sheet: null,
      page: null,
      location: "-",
      surroundingText: "",
      originalText: "",
      bidderName: "낙찰자 없음",
      awardStatus: "not_found",
    });
    return;
  }

  const noticeDir = path.join(jobDirectory(job.jobId), notice.noticeNumber);
  await mkdir(noticeDir, { recursive: true });

  try {
    const lookup = await withRetry(() => fetchNotice(notice.noticeNumber));
    const item = lookup.value;
    notice.lookupAttempts = lookup.attempts;
    notice.noticeName = String(item.bidNtceNm ?? item.bidNtceName ?? "").trim() || null;
    notice.budgetAmount = String(item.bdgtAmt ?? "미공개/확인불가");
    notice.estimatedAmount = String(item.presmptPrce ?? "미공개/확인불가");
    notice.baseAmount = String(item.bssAmt ?? "미공개/확인불가");
    notice.constructionOverview = [
      item.cnstrtsiteRgnNm,
      item.cnstrtsPeriod,
      item.cnstrtsNm,
    ].filter(Boolean).join(" / ") || "미공개/확인불가";
    notice.resolvedOrder = String(item.bidNtceOrd ?? "").padStart(3, "0");
    notice.orderMatched = notice.requestedOrder === notice.resolvedOrder;
    if (!notice.orderMatched) {
      throw new Error(
        `정정차수 불일치: 요청 ${notice.requestedOrder}, 응답 ${notice.resolvedOrder}`,
      );
    }
    const attachments = collectAttachments(item).sort(
      (a, b) => Number(isPriorityAttachment(b.name)) - Number(isPriorityAttachment(a.name)),
    );
    notice.attachmentCount = attachments.length;
    notice.attachments = attachments.map((attachment) => ({
      fileName: sanitizeName(attachment.name),
      url: attachment.url,
      priority: isPriorityAttachment(attachment.name),
      downloadStatus: "pending",
      downloadError: null,
      attempts: 0,
      parsedFileCount: 0,
      parseFailureCount: 0,
      keywordFound: false,
    }));
    if (attachments.length === 0) {
      job.searchResults.push({
        noticeNumber: notice.noticeNumber, noticeName: notice.noticeName,
        attachmentFileName: "-", downloadStatus: "failed", downloadError: "첨부파일 없음",
        parseStatus: "not_applicable", parseError: null, resultStatus: "no_attachment",
        retryCount: 0, keywordFound: false, foundKeywords: [], fileName: "-",
        sheet: null, page: null, location: "-", surroundingText: "", originalText: "",
      });
    }

    for (const [attachmentIndex, attachment] of attachments.entries()) {
      const attachmentResult = notice.attachments[attachmentIndex];
      let downloadedPath: string;
      try {
        const download = await withRetry(() =>
          downloadAttachment(attachment.url, noticeDir, attachment.name),
        );
        downloadedPath = download.value;
        attachmentResult.attempts = download.attempts;
        attachmentResult.downloadStatus = "success";
        attachmentResult.fileName = path.basename(downloadedPath);
        notice.downloadedCount += 1;
      } catch (error) {
        notice.failedCount += 1;
        const message = error instanceof Error ? error.message : "알 수 없는 다운로드 오류";
        attachmentResult.downloadStatus = "failed";
        attachmentResult.downloadError = message;
        attachmentResult.attempts = 3;
        job.searchResults.push({
          noticeNumber: notice.noticeNumber,
          noticeName: notice.noticeName,
          attachmentFileName: attachment.name,
          downloadStatus: "failed",
          downloadError: message,
          parseStatus: "not_applicable",
          parseError: null,
          resultStatus: "download_failed",
          retryCount: 2,
          keywordFound: false,
          foundKeywords: [],
          fileName: attachment.name,
          sheet: null,
          page: null,
          location: "-",
          surroundingText: "",
          originalText: "",
        });
        updateSummary(job);
        await persistJob(job);
        continue;
      }

      try {
        let searchRoots = [downloadedPath];
        if (path.extname(downloadedPath).toLowerCase() === ".zip") {
          searchRoots = await extractZipRecursively(downloadedPath);
        }

        for (const searchablePath of searchRoots) {
          if ((await stat(searchablePath)).isDirectory()) continue;
          if (path.extname(searchablePath).toLowerCase() === ".zip") continue;
          let matches: ReturnType<typeof searchSegments>;
          try {
            const parsing = await withRetry(() => extractSegments(searchablePath), 2);
            const segments = parsing.value;
            if (
              segments.length === 0 &&
              ![".xlsx", ".xlsm", ".xls", ".pdf", ".hwp", ".hwpx", ".hwtx", ".doc", ".docx", ".csv", ".txt", ".xml"].includes(
                path.extname(searchablePath).toLowerCase(),
              )
            ) {
              throw new Error(`지원하지 않는 파일 형식: ${path.extname(searchablePath) || "확장자 없음"}`);
            }
            matches = searchSegments(segments, job.keywords);
            attachmentResult.parsedFileCount += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : "문서 파싱 오류";
            attachmentResult.parseFailureCount += 1;
            notice.parseFailureCount += 1;
            logger.warn(
              {
                err: error,
                noticeNumber: notice.noticeNumber,
                fileName: path.basename(searchablePath),
              },
              "Could not extract attachment text",
            );
            job.searchResults.push({
              noticeNumber: notice.noticeNumber,
              noticeName: notice.noticeName,
              attachmentFileName: path.basename(downloadedPath),
              downloadStatus: "success",
              downloadError: null,
              parseStatus: "failed",
              parseError: message,
              resultStatus: "parse_failed",
              retryCount: Math.max(0, attachmentResult.attempts - 1) + 1,
              keywordFound: false,
              foundKeywords: [],
              fileName: path.relative(noticeDir, searchablePath),
              sheet: null,
              page: null,
              location: "-",
              surroundingText: "",
              originalText: "",
            });
            continue;
          }
          // 요구사항(2026-09-10 사용자 요청: "수량이 없는 키워드는 검색하지
          // 마 ... 검색 결과에 키워드/수량을 꼭 함께 넣어줘"): 문서에 키워드
          // 단어 자체는 있어도 수량(예: 000㎡, 00kg 등)을 특정할 수 없으면
          // 실제 발주 물량을 확인할 수 없는 단순 언급일 가능성이 커서
          // 매칭에서 제외한다.
          matches = matches.filter(
            (match) => extractItemFields(match.originalText, job.keywords).itemQuantity !== "미공개/확인불가",
          );
          attachmentResult.keywordFound ||= matches.length > 0;
          if (!matches.length) {
            job.searchResults.push({
              noticeNumber: notice.noticeNumber,
              noticeName: notice.noticeName,
              attachmentFileName: path.basename(downloadedPath),
              downloadStatus: "success",
              downloadError: null,
              parseStatus: "success",
              parseError: null,
              resultStatus: "keyword_not_found",
              retryCount: Math.max(0, attachmentResult.attempts - 1),
              keywordFound: false,
              foundKeywords: [],
              fileName: path.relative(noticeDir, searchablePath),
              sheet: null,
              page: null,
              location: "-",
              surroundingText: "",
              originalText: "",
            });
          }
          for (const match of matches) {
            job.searchResults.push({
              noticeNumber: notice.noticeNumber,
              noticeName: notice.noticeName,
              attachmentFileName: path.basename(downloadedPath),
              downloadStatus: "success",
              downloadError: null,
              parseStatus: "success",
              parseError: null,
              resultStatus: "keyword_found",
              retryCount: Math.max(0, attachmentResult.attempts - 1),
              fileName: path.relative(noticeDir, searchablePath),
              ...match,
            });
          }
        }
        if (searchRoots.length === 0) {
          attachmentResult.parseFailureCount += 1;
          notice.parseFailureCount += 1;
          job.searchResults.push({
            noticeNumber: notice.noticeNumber,
            noticeName: notice.noticeName,
            attachmentFileName: path.basename(downloadedPath),
            downloadStatus: "success",
            downloadError: null,
            parseStatus: "failed",
            parseError: "ZIP 내부에서 검사할 파일을 찾지 못했습니다.",
            resultStatus: "parse_failed",
            retryCount: Math.max(0, attachmentResult.attempts - 1),
            keywordFound: false,
            foundKeywords: [],
            fileName: path.basename(downloadedPath),
            sheet: null,
            page: null,
            location: "-",
            surroundingText: "",
            originalText: "",
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "압축 해제 또는 파싱 오류";
        attachmentResult.parseFailureCount += 1;
        notice.parseFailureCount += 1;
        job.searchResults.push({
          noticeNumber: notice.noticeNumber,
          noticeName: notice.noticeName,
          attachmentFileName: path.basename(downloadedPath),
          downloadStatus: "success",
          downloadError: null,
          parseStatus: "failed",
          parseError: message,
          resultStatus: "parse_failed",
          retryCount: Math.max(0, attachmentResult.attempts - 1),
          keywordFound: false,
          foundKeywords: [],
          fileName: path.basename(downloadedPath),
          sheet: null,
          page: null,
          location: "-",
          surroundingText: "",
          originalText: "",
        });
      }
      updateSummary(job);
      await persistJob(job);
    }

    notice.keywordHitCount = job.searchResults.filter(
      (item) => item.noticeNumber === notice.noticeNumber && item.keywordFound,
    ).length;
    notice.status = notice.failedCount
      ? notice.downloadedCount
        ? "partial"
        : "failed"
      : notice.parseFailureCount
        ? "partial"
        : "completed";
  } catch (error) {
    notice.status = "failed";
    notice.lookupAttempts = 3;
    notice.error = describeError(error);
    logger.warn(
      {
        err: error,
        networkError: notice.error,
        noticeNumber: notice.noticeNumber,
      },
      "Could not fetch bid notice",
    );
  }
}

async function runJob(job: CollectionJob): Promise<void> {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  try {
    // Check award status for every requested notice up front, in one batched
    // pass, before touching any attachments: a notice with no confirmed
    // winner yet has no one to pitch to, so there's no point downloading and
    // parsing its documents at all.
    const awards = await fetchAwards(new Set(job.notices.map((notice) => notice.noticeNumber)));
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < job.notices.length) {
        const notice = job.notices[nextIndex++];
        await processNotice(job, notice, awards.get(notice.noticeNumber) ?? null);
        job.completedCount += 1;
        updateSummary(job);
        await persistJob(job);
        if (networkCircuit.openUntil > Date.now()) break;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, job.notices.length) }, worker));
    if (networkCircuit.openUntil > Date.now()) {
      job.notices.forEach((notice) => {
        if (notice.status === "running") notice.status = "queued";
      });
      job.currentNoticeNumber = null;
      job.status = "failed";
      job.error = `나라장터 외부 연결 장애로 작업을 일시 중지했습니다. 실패 건만 재처리할 수 있습니다. 마지막 오류: ${networkCircuit.lastError}`;
      updateSummary(job);
      await persistJob(job);
      return;
    }
    await enrichKeywordResults(job, awards);
    job.currentNoticeNumber = null;
    job.status = job.notices.some((notice) => notice.status === "failed" || notice.status === "partial")
      ? "completed_with_errors"
      : "completed";
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "작업 처리 중 오류가 발생했습니다.";
  }
  updateSummary(job);
  await persistJob(job);
}

function normalizeKeywords(keywords?: string[]): string[] {
  const values = (keywords?.length ? keywords : [...DEFAULT_KEYWORDS])
    .map((value) => value.trim()).filter(Boolean);
  return [...new Set(values)].slice(0, 20);
}

function makeRequestKey(noticeNumbers: string[], keywords: string[]): string {
  return createHash("sha256").update(JSON.stringify({
    notices: [...noticeNumbers].sort(), keywords: keywords.map((item) => item.toLocaleLowerCase("ko-KR")).sort(),
  })).digest("hex");
}

async function findReusableJob(requestKey: string): Promise<CollectionJob | null> {
  await mkdir(JOB_ROOT, { recursive: true });
  for (const entry of await readdir(JOB_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const candidate = JSON.parse(await readFile(jobStatePath(entry.name), "utf8")) as CollectionJob;
      if (candidate.requestKey === requestKey && ["completed", "completed_with_errors"].includes(candidate.status)) return candidate;
    } catch { /* Ignore incomplete cache entries. */ }
  }
  return null;
}

export async function createCollectionJob(noticeNumbers: string[], requestedKeywords?: string[], bypassCache = false): Promise<CollectionJob> {
  await mkdir(JOB_ROOT, { recursive: true });
  const uniqueNotices = [...new Set(noticeNumbers.map((value) => value.trim().toUpperCase()))];
  uniqueNotices.forEach(parseNoticeNumber);
  const keywords = normalizeKeywords(requestedKeywords);
  if (!keywords.length) throw new Error("검색 키워드를 하나 이상 입력해 주세요.");
  const requestKey = makeRequestKey(uniqueNotices, keywords);
  if (!bypassCache) {
    const reusable = await findReusableJob(requestKey);
    if (reusable) {
      jobs.set(reusable.jobId, reusable);
      return reusable;
    }
  }
  const jobId = crypto.randomUUID();
  const job: CollectionJob = {
    jobId,
    status: "queued",
    totalCount: uniqueNotices.length,
    completedCount: 0,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    currentNoticeNumber: null,
    notices: uniqueNotices.map((noticeNumber) => ({
      noticeNumber,
      noticeName: null,
      requestedOrder: noticeNumber.slice(-3),
      resolvedOrder: null,
      orderMatched: null,
      lookupAttempts: 0,
      status: "queued",
      attachmentCount: 0,
      downloadedCount: 0,
      failedCount: 0,
      keywordHitCount: 0,
      parseFailureCount: 0,
      attachments: [],
      error: null,
    })),
    searchResults: [],
    keywords,
    requestKey,
    reusedFromJobId: null,
    summary: {
      notices: uniqueNotices.length,
      attachments: 0,
      downloaded: 0,
      downloadFailures: 0,
      parseFailures: 0,
      lookupFailures: 0,
      filesWithKeywords: 0,
      keywordMatches: 0,
    },
    error: null,
  };
  jobs.set(jobId, job);
  await persistJob(job);
  void runJob(job).catch((error) => {
    logger.error({ err: error, jobId }, "Bid collection job failed");
  });
  return job;
}

export async function retryFailedCollectionJob(jobId: string): Promise<CollectionJob> {
  const source = await getCollectionJob(jobId);
  if (!source) throw new Error("원본 작업을 찾을 수 없습니다.");
  const failed = source.notices.filter((notice) => notice.status === "failed" || notice.status === "partial").map((notice) => notice.noticeNumber);
  if (!failed.length) throw new Error("재처리할 실패 공고가 없습니다.");
  return createCollectionJob(failed, source.keywords, true);
}

export async function parseNoticeUpload(fileName: string, contentBase64: string): Promise<{
  noticeNumbers: string[]; duplicateCount: number; invalidValues: string[];
}> {
  const extension = path.extname(fileName).toLowerCase();
  if (![".xls", ".xlsx", ".csv"].includes(extension)) throw new Error("XLS, XLSX 또는 CSV 파일만 업로드할 수 있습니다.");
  const directory = await mkdtemp(path.join(tmpdir(), "bid-upload-"));
  const filePath = path.join(directory, sanitizeName(fileName));
  try {
    const buffer = Buffer.from(contentBase64, "base64");
    if (!buffer.length || buffer.length > 15 * 1024 * 1024) throw new Error("업로드 파일은 15MB 이하여야 합니다.");
    await writeFile(filePath, buffer);
    const segments = await extractSegments(filePath);
    const sourceRows = [...new Set(segments.map((segment) => segment.itemContext ?? segment.text))];
    const candidates = sourceRows.flatMap((value) => value.split(/[|,\t;\r\n]+/));
    const valid: string[] = [];
    const invalidValues: string[] = [];
    for (const candidate of candidates) {
      const cleaned = candidate.trim().replace(/^(?:[A-Z]+\d+|R\d+C\d+)=/, "").trim();
      const matches = cleaned.toUpperCase().match(/R[0-9A-Z]{12}-[0-9]{3}/g);
      if (matches) valid.push(...matches);
      else if (/^R/i.test(cleaned)) {
        invalidValues.push(cleaned.slice(0, 120));
      }
    }
    const unique = [...new Set(valid)];
    if (!unique.length) throw new Error("파일에서 유효한 공고번호 열을 찾지 못했습니다.");
    return { noticeNumbers: unique, duplicateCount: valid.length - unique.length, invalidValues: [...new Set(invalidValues)].slice(0, 100) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function getCollectionJob(jobId: string): Promise<CollectionJob | null> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const cached = jobs.get(jobId);
  if (cached) {
    cached.keywords ??= [...DEFAULT_KEYWORDS];
    cached.requestKey ??= makeRequestKey(cached.notices.map((item) => item.noticeNumber), cached.keywords);
    cached.reusedFromJobId ??= null;
    for (const result of cached.searchResults.filter((item) => item.keywordFound)) {
      Object.assign(result, extractItemFields(result.originalText, cached.keywords ?? DEFAULT_KEYWORDS));
    }
    return cached;
  }
  try {
    const job = JSON.parse(await readFile(jobStatePath(jobId), "utf8")) as CollectionJob;
    job.keywords ??= [...DEFAULT_KEYWORDS];
    job.requestKey ??= makeRequestKey(job.notices.map((item) => item.noticeNumber), job.keywords);
    job.reusedFromJobId ??= null;
    for (const result of job.searchResults.filter((item) => item.keywordFound)) {
      Object.assign(result, extractItemFields(result.originalText, job.keywords ?? DEFAULT_KEYWORDS));
    }
    jobs.set(jobId, job);
    return job;
  } catch {
    return null;
  }
}

// 요구사항(2026-09-10 사용자 요청: "우선 지금 test로 되어있는 결과값들은 모두
// 삭제해줘"): /search 화면에서 배포 확인차 만들었던 검색 작업들을 한 번에
// 정리하는 일회성 전체 삭제. 디스크에 저장된 작업 디렉터리와 인메모리 캐시를
// 모두 비운다.
export async function deleteAllJobs(): Promise<{ deletedCount: number }> {
  jobs.clear();
  let deletedCount = 0;
  try {
    const entries = await readdir(JOB_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await rm(path.join(JOB_ROOT, entry.name), { recursive: true, force: true });
      deletedCount += 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  return { deletedCount };
}

export async function buildArchive(job: CollectionJob): Promise<string> {
  const archivePath = path.join(jobDirectory(job.jobId), "나라장터_공고첨부파일.zip");
  await rm(archivePath, { force: true });
  const staging = await mkdtemp(path.join(tmpdir(), "bid-archive-"));
  for (const notice of job.notices) {
    const source = path.join(jobDirectory(job.jobId), notice.noticeNumber);
    try {
      await cp(source, path.join(staging, notice.noticeNumber), {
        recursive: true,
        filter: async (sourcePath) => {
          if (path.extname(sourcePath).toLowerCase() !== ".zip") return true;
          const extractedPath = `${sourcePath.slice(0, -path.extname(sourcePath).length)}_extracted`;
          try {
            return !(await stat(extractedPath)).isDirectory();
          } catch {
            return true;
          }
        },
      });
    } catch {
      // Notices without downloadable files are intentionally omitted.
    }
  }
  await command("zip", ["-qr", archivePath, "."], staging);
  await rm(staging, { recursive: true, force: true });
  return archivePath;
}

function csvEscape(value: unknown): string {
  const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

const RESULT_HEADERS = [
  "공고번호",
  "공고명",
  "요청차수",
  "응답차수",
  "차수일치",
  "첨부파일명",
  "우선검사",
  "다운로드 상태",
  "다운로드 시도횟수",
  "다운로드 오류",
  "파싱 상태",
  "파싱 오류",
  "최종 판정",
  "키워드 발견",
  "발견 키워드",
  "파일명",
  "시트",
  "페이지",
  "위치",
  "주변 텍스트",
  "원문 셀/문장",
  "품명",
  "규격",
  "수량",
  "단위",
  "품목금액",
  "낙찰정보 상태",
  "낙찰자",
  "낙찰/재입찰 식별번호",
  "낙찰일",
  "낙찰금액",
  "예산금액",
  "추정가격",
  "기초금액",
  "공사 규모/개요",
  "낙찰자 주소",
  "낙찰자 연락처",
  "출처 유형",
  "첨부 검색 상태",
  "공고정보 조회 상태",
  "낙찰정보 조회 상태",
  "대표 연락처 조회 상태",
] as const;

function resultRows(job: CollectionJob): unknown[][] {
  return job.searchResults.map((item) => {
    const notice = job.notices.find((candidate) => candidate.noticeNumber === item.noticeNumber);
    const attachment = notice?.attachments.find(
      (candidate) => candidate.fileName === item.attachmentFileName,
    );
    return [
      item.noticeNumber,
      item.noticeName,
      notice?.requestedOrder,
      notice?.resolvedOrder,
      notice?.orderMatched === true ? "일치" : notice?.orderMatched === false ? "불일치" : "확인실패",
      item.attachmentFileName,
      attachment?.priority ? "예" : "아니오",
      item.downloadStatus === "success" ? "성공" : "실패",
      item.retryCount + 1,
      item.downloadError,
      item.parseStatus === "success"
        ? "성공"
        : item.parseStatus === "failed"
          ? "실패"
          : "해당없음",
      item.parseError,
      {
        keyword_found: "키워드발견",
        keyword_not_found: "키워드없음",
        no_attachment: "첨부파일없음",
        download_failed: "다운로드실패",
        parse_failed: "파싱실패",
        not_awarded: "낙찰자없음",
      }[item.resultStatus],
      item.keywordFound ? "발견" : "없음",
      item.foundKeywords,
      item.fileName,
      item.sheet,
      item.page,
      item.location,
      item.surroundingText,
      item.originalText,
      item.itemName,
      item.itemSpecification,
      item.itemQuantity,
      item.itemUnit,
      item.itemAmount,
      item.awardStatus === "confirmed" ? "확인" : "미확인",
      item.bidderName,
      item.awardIdentifier,
      item.awardDate,
      item.awardAmount,
      item.budgetAmount,
      item.estimatedAmount,
      item.baseAmount,
      item.constructionOverview,
      item.bidderAddress,
      item.bidderPhone,
      "첨부파일 / 입찰공고 / 낙찰정보",
      {
        keyword_found: "FOUND",
        keyword_not_found: "NOT_FOUND",
        no_attachment: "NO_ATTACHMENT",
        download_failed: "DOWNLOAD_FAIL",
        parse_failed: "PARSE_FAIL",
        not_awarded: "NOT_AWARDED",
      }[item.resultStatus],
      item.resultStatus === "not_awarded" ? "SKIPPED_NOT_AWARDED" : notice?.resolvedOrder ? "SUCCESS" : "LOOKUP_FAIL",
      item.resultStatus === "not_awarded"
        ? "NOT_AWARDED"
        : item.keywordFound
          ? (item.awardStatus === "confirmed" ? "SUCCESS" : "NOT_FOUND")
          : "NOT_APPLICABLE",
      item.keywordFound
        ? !item.bidderPhone && !item.bidderAddress
          ? "NOT_APPLICABLE"
          : item.bidderPhone !== "미공개/확인불가" || item.bidderAddress !== "미공개/확인불가"
            ? {
                government: "GOV_API_FOUND",
                attachment: "ATTACHMENT_FOUND",
                registry: "GOV_REGISTRY_FOUND",
                portal: "PORTAL_SEARCH_FOUND",
                web: "WEB_SEARCH_FOUND",
              }[item.contactSource ?? "government"]
            : "CONTACT_NOT_FOUND"
        : "NOT_APPLICABLE",
    ];
  });
}

export function buildCsv(job: CollectionJob): string {
  const rows = [RESULT_HEADERS, ...resultRows(job)];
  return `\uFEFF${rows.map((row) => row.map(csvEscape).join(",")).join("\r\n")}`;
}

function xmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function excelColumn(index: number): string {
  let result = "";
  let value = index + 1;
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export async function buildXlsx(job: CollectionJob): Promise<string> {
  const workbookDir = await mkdtemp(path.join(tmpdir(), "bid-xlsx-"));
  await mkdir(path.join(workbookDir, "_rels"), { recursive: true });
  await mkdir(path.join(workbookDir, "xl", "_rels"), { recursive: true });
  await mkdir(path.join(workbookDir, "xl", "worksheets"), { recursive: true });
  const rows = [RESULT_HEADERS, ...resultRows(job)];
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map(
          (value, columnIndex) =>
            `<c r="${excelColumn(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(Array.isArray(value) ? value.join(", ") : value)}</t></is></c>`,
        )
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  await writeFile(
    path.join(workbookDir, "[Content_Types].xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  await writeFile(
    path.join(workbookDir, "_rels", ".rels"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  await writeFile(
    path.join(workbookDir, "xl", "workbook.xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="검색결과" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  await writeFile(
    path.join(workbookDir, "xl", "_rels", "workbook.xml.rels"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  await writeFile(
    path.join(workbookDir, "xl", "worksheets", "sheet1.xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  );
  const output = path.join(jobDirectory(job.jobId), "나라장터_키워드검색결과.xlsx");
  await rm(output, { force: true });
  await command("zip", ["-qr", output, "."], workbookDir);
  await rm(workbookDir, { recursive: true, force: true });
  return output;
}

export function sendDownload(res: Response, filePath: string, fileName: string): void {
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  createReadStream(filePath).pipe(res);
}

export interface JobHistoryEntry {
  jobId: string;
  status: JobState;
  keywords: string[];
  noticeCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  summary: CollectionJob["summary"];
}

// Every completed/running job is already persisted to JOB_ROOT/<jobId>/job.json
// (see persistJob). This scans that same durable store so "search history" is
// available from any browser/device, not just the one that started the job.
export async function listRecentJobs(limit = 30): Promise<JobHistoryEntry[]> {
  await mkdir(JOB_ROOT, { recursive: true });
  const entries: JobHistoryEntry[] = [];
  for (const dirEntry of await readdir(JOB_ROOT, { withFileTypes: true })) {
    if (!dirEntry.isDirectory()) continue;
    try {
      const job = JSON.parse(await readFile(jobStatePath(dirEntry.name), "utf8")) as CollectionJob;
      entries.push({
        jobId: job.jobId,
        status: job.status,
        keywords: job.keywords?.length ? job.keywords : [...DEFAULT_KEYWORDS],
        noticeCount: job.notices?.length ?? 0,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        summary: job.summary,
      });
    } catch {
      // Skip unreadable/partial job directories (e.g. still being written).
    }
  }
  entries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return entries.slice(0, Math.max(1, Math.min(100, limit)));
}

// Resolves a specific downloaded/extracted attachment file for direct manual
// review ("바로가기"), guarding against path traversal via the notice number
// or the requested relative path.
export async function resolveAttachmentFile(
  jobId: string,
  noticeNumber: string,
  relativePath: string,
): Promise<string> {
  parseNoticeNumber(noticeNumber);
  const noticeDir = path.resolve(jobDirectory(jobId), noticeNumber.trim().toUpperCase());
  const target = path.resolve(noticeDir, relativePath);
  const noticeDirWithSep = `${noticeDir}${path.sep}`;
  if (target !== noticeDir && !target.startsWith(noticeDirWithSep)) {
    throw new Error("잘못된 파일 경로입니다.");
  }
  const info = await stat(target);
  if (!info.isFile()) throw new Error("파일을 찾을 수 없습니다.");
  return target;
}
