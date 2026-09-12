import nodemailer from "nodemailer";
import { logger } from "./logger";

// 요구사항(2026-09-12 사용자 요청: "설정에서 매일 검색 결과를 이메일로 자동
// 전송될 수 있는 주소를 넣는곳을 만들어줘... 만약 검색 결과가 있으면 해당
// 키워드가 있던 첨부파일도 함께 보내줘"): 매일 07시 자동 스캔이 끝났을 때
// 결과 요약 메일을 발송한다. 발신 계정은 구글(Gmail) 계정 하나를 쓰기로
// 했다 — 일반 로그인 비밀번호가 아니라 구글 계정의 "앱 비밀번호"(2단계 인증이
// 켜져 있어야 발급 가능)를 MAIL_APP_PASSWORD로 Railway 환경변수에 넣어야
// 실제 발송이 된다. 두 환경변수가 없으면(로컬 개발 등) 조용히 건너뛴다 —
// 스캔 자체는 메일 발송 여부와 무관하게 항상 정상 동작해야 하기 때문이다.
const MAIL_USER = process.env.MAIL_USER;
const MAIL_APP_PASSWORD = process.env.MAIL_APP_PASSWORD;

let cachedTransporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (!MAIL_USER || !MAIL_APP_PASSWORD) return null;
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: MAIL_USER, pass: MAIL_APP_PASSWORD },
    });
  }
  return cachedTransporter;
}

export interface ScanResultEmailMatch {
  siteName: string | null;
  noticeName: string | null;
  demandAgency: string | null;
  bidderName: string | null;
  matchedKeyword: string;
  quantityText: string | null;
  attachmentFileName: string | null;
}

export interface ScanResultEmailAttachment {
  filename: string;
  path: string;
}

export interface ScanResultEmailParams {
  to: string[];
  /** "9/12" 형식(월/일, 0 없음) — 검색 대상 날짜(낙찰일 기준). */
  dateLabel: string;
  matches: ScanResultEmailMatch[];
  attachments: ScanResultEmailAttachment[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TABLE_HEADERS = ["현장명(공고명)", "발주기관", "낙찰자", "매칭 키워드", "수량", "첨부파일"];

function buildHtml(params: ScanResultEmailParams): string {
  const rows = params.matches
    .map((match) => {
      const cells = [
        match.siteName ?? match.noticeName ?? "-",
        match.demandAgency ?? "-",
        match.bidderName ?? "-",
        match.matchedKeyword,
        match.quantityText ?? "-",
        match.attachmentFileName ?? "-",
      ];
      return `<tr>${cells
        .map((cell) => `<td style="padding:6px 10px;border:1px solid #ddd;">${escapeHtml(cell)}</td>`)
        .join("")}</tr>`;
    })
    .join("");
  const headerCells = TABLE_HEADERS.map(
    (header) => `<th style="padding:6px 10px;border:1px solid #ddd;text-align:left;background:#f5f5f5;">${header}</th>`,
  ).join("");
  return `
    <div style="font-family:sans-serif;font-size:14px;color:#222;">
      <p>${params.dateLabel}일 나라장터 낙찰공고 자동 검색에서 ${params.matches.length}건의 신규 매칭을 찾았습니다.</p>
      <table style="border-collapse:collapse;margin-top:12px;">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${params.attachments.length > 0 ? `<p style="margin-top:12px;">첨부파일 ${params.attachments.length}건을 함께 보냅니다.</p>` : ""}
      <p style="margin-top:16px;color:#777;font-size:12px;">이 메일은 나라장터 공고 검색 시스템에서 자동 발송되었습니다. 받는 주소는 설정 화면에서 추가/삭제할 수 있습니다.</p>
    </div>`;
}

export async function sendScanResultEmail(params: ScanResultEmailParams): Promise<void> {
  if (params.to.length === 0 || params.matches.length === 0) return;
  const transporter = getTransporter();
  if (!transporter) {
    logger.warn(
      "일일 검색결과 메일 발송 건너뜀: MAIL_USER/MAIL_APP_PASSWORD 환경변수가 설정되어 있지 않습니다.",
    );
    return;
  }
  const subject = `나라장터 검색결과_${params.dateLabel}일_${params.matches.length}건`;
  try {
    await transporter.sendMail({
      from: MAIL_USER,
      to: params.to.join(", "),
      subject,
      html: buildHtml(params),
      attachments: params.attachments,
    });
    logger.info({ to: params.to, matches: params.matches.length }, "일일 검색결과 메일 발송 완료");
  } catch (error) {
    logger.error({ err: error }, "일일 검색결과 메일 발송 실패");
  }
}
