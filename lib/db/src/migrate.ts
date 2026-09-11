import { pool } from "./index";

// Lightweight, idempotent schema bootstrap. This project doesn't run a
// migration-file workflow (see drizzle-kit "push"/"push-force" in
// package.json, which is a manual dev-time command) — instead the tables the
// daily-scan feature needs are created here with CREATE TABLE IF NOT EXISTS
// on every boot, so a fresh production database picks them up automatically
// on first deploy without a manual step. Keep this in sync with
// src/schema/*.ts by hand; drizzle-kit push can still be run manually to
// reconcile anything this script doesn't cover (e.g. column changes).
export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_super_admin TEXT NOT NULL DEFAULT 'false',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1,
      match_keywords JSONB NOT NULL,
      work_type_keywords JSONB NOT NULL,
      min_budget_amount BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 업무구분 선택(물품/일반용역/기술용역/공사)과 추정가격 범위 필터. 이미 배포된
    -- 테이블에는 없는 컬럼이라 ALTER ... ADD COLUMN IF NOT EXISTS로 보강한다.
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS work_categories JSONB;
    UPDATE app_settings SET work_categories = '["물품","일반용역","기술용역","공사"]'::jsonb
      WHERE work_categories IS NULL;
    ALTER TABLE app_settings ALTER COLUMN work_categories SET NOT NULL;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS min_estimated_price BIGINT;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS max_estimated_price BIGINT;

    CREATE TABLE IF NOT EXISTS daily_scan_runs (
      id SERIAL PRIMARY KEY,
      target_dates JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      trigger_type TEXT NOT NULL DEFAULT 'schedule',
      awards_found INTEGER NOT NULL DEFAULT 0,
      candidates_checked INTEGER NOT NULL DEFAULT 0,
      matches_found INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );

    -- 요구사항(2026-09-11 사용자 지적: "이런식으로 하면 손해배상청구 소송"):
    -- 자동 스캔(매일 07시)과 수동 "지금 실행"이 겹치거나 버튼을 두 번 누르면
    -- data.go.kr·네이버 API 호출이 그대로 두 배로 나가 한도 초과가 재발할 수
    -- 있다. status='running'인 행은 항상 최대 1개만 존재하도록 DB 레벨에서
    -- 강제해 동시 실행 자체를 막는다(daily-scan.ts의 ScanAlreadyRunningError
    -- 참고). 인덱스 생성 전, 혹시 남아있을 수 있는 고아 running 행(서버가
    -- 재배포되며 죽은 이전 실행)을 먼저 정리해 인덱스 생성이 실패하지 않게
    -- 한다 — recoverOrphanedScanRuns()가 어차피 뒤이어 같은 일을 하므로 중복
    -- 정리는 안전하다.
    UPDATE daily_scan_runs
      SET status = 'failed', error_message = '서버 재배포로 스캔이 중단되었습니다.', finished_at = now()
      WHERE status = 'running';
    CREATE UNIQUE INDEX IF NOT EXISTS daily_scan_runs_single_running
      ON daily_scan_runs (status) WHERE status = 'running';

    CREATE TABLE IF NOT EXISTS awarded_matches (
      id SERIAL PRIMARY KEY,
      scan_run_id INTEGER REFERENCES daily_scan_runs(id),
      notice_number TEXT NOT NULL,
      notice_name TEXT,
      site_name TEXT,
      site_office TEXT,
      work_type_name TEXT,
      demand_agency TEXT,
      bidder_name TEXT,
      bidder_bizno TEXT,
      bidder_address TEXT,
      bidder_phone TEXT,
      budget_amount BIGINT,
      award_amount BIGINT,
      award_date TEXT,
      matched_keyword TEXT NOT NULL,
      quantity_text TEXT,
      surrounding_text TEXT,
      attachment_file_name TEXT,
      attachment_stored_path TEXT,
      sms_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS awarded_matches_unique_hit
      ON awarded_matches (notice_number, matched_keyword, attachment_file_name);

    -- 업무구분 다중 API 지원 + 추정가격 + 연락처 출처(정부기록/첨부파일/네이버 포털).
    ALTER TABLE awarded_matches ADD COLUMN IF NOT EXISTS work_category TEXT;
    ALTER TABLE awarded_matches ADD COLUMN IF NOT EXISTS contact_source TEXT;
    ALTER TABLE awarded_matches ADD COLUMN IF NOT EXISTS estimated_amount BIGINT;

    -- 첨부파일 5개월 보관/자동삭제(attachment-cleanup.ts). 채워지면 디스크 파일은
    -- 이미 삭제된 상태이고 리드 레코드 자체는 남아있음을 뜻한다.
    ALTER TABLE awarded_matches ADD COLUMN IF NOT EXISTS attachment_deleted_at TIMESTAMPTZ;

    -- 요구사항(2026-09-11 사용자 제안: "전일 공사 항목의 첨부파일을 서버에
    -- 저장하고 서버에 저장한 파일을 키워드 검색하면 어떨까"): 공고 상세정보(첨부
    -- 파일 URL, 예산, 업무구분 등)는 공고 등록 후 바뀌지 않는데도, 최근 3일
    -- 재확인 로직 때문에 daily-scan.ts가 같은 공고를 매일/매번 재실행할 때마다
    -- data.go.kr 상세 API를 다시 불러 "일일 서비스 요청제한 횟수 초과" 오류의
    -- 원인이 됐다. 한 번 조회에 성공한 상세정보를 여기 캐시해 재조회를 없앤다.
    CREATE TABLE IF NOT EXISTS notice_detail_cache (
      notice_number TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      detail_json JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 요구사항(2026-09-11 사용자 지적: "API 는 호출량이 있고... 이런식으로
    -- 하면 손해배상청구 소송"): 낙찰자 연락처 보완용 네이버 오픈API(지역검색/
    -- 웹문서/블로그) 호출은 기존에 스캔 실행마다(메모리 캐시만) 새로 나갔다.
    -- 같은 회사(+지역)를 회사 단위로 영구 캐시해 재조회를 없앤다. 지역검색과
    -- 웹/블로그검색은 서로 다른 API이므로 조회 여부/결과를 각각 따로 기록한다.
    CREATE TABLE IF NOT EXISTS business_contact_cache (
      cache_key TEXT PRIMARY KEY,
      portal_checked BOOLEAN NOT NULL DEFAULT false,
      portal_address TEXT,
      portal_phone TEXT,
      web_checked BOOLEAN NOT NULL DEFAULT false,
      web_phone TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- express-session's store (connect-pg-simple) ships a table.sql asset it
    -- reads from disk to create this table on demand ("createTableIfMissing").
    -- That file doesn't survive our esbuild bundling step, so relying on it
    -- fails at runtime (ENOENT) and silently breaks session persistence —
    -- every login "succeeds" but the session is never actually saved, so the
    -- very next request looks logged out. We create the table ourselves here
    -- instead (schema matches connect-pg-simple's own default exactly) and
    -- set createTableIfMissing: false in app.ts.
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    );

    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);
}
