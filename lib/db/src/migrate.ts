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

    -- 요구사항(2026-09-12 사용자 요청: 매일 검색 결과 자동 이메일 발송): 결과를
    -- 받을 이메일 주소 목록. 기존 배포된 테이블에는 없는 컬럼이라 다른 컬럼들과
    -- 같은 방식으로 보강한다.
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS notification_emails JSONB NOT NULL DEFAULT '[]'::jsonb;

    -- 요구사항(2026-09-14 사용자 요청: "나라장터를 기본으로, 토지공사나 군대
    -- 입찰싸이트도 선택하면 검색할 수 있는 싸이트로 업그레이드"): 매일 자동 검색 +
    -- 수동 검색 모두에서 어떤 사이트를 조회할지. 기존 배포된 테이블에는 없는
    -- 컬럼이라 다른 컬럼들과 같은 방식으로 보강한다. "나라장터"는 항상 포함.
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS enabled_sources JSONB NOT NULL DEFAULT '["나라장터"]'::jsonb;

    -- 요구사항(2026-09-15 사용자 요청: "키워드 2번째를 설정할 수 있도록 해줘.
    -- 낙찰금액과 공사제목만 넣으면 첫번째 키워드가 없어도 검색되게 하는거야"):
    -- 1차 키워드와 완전히 독립된 2차 조건(제목 키워드 + 낙찰금액 범위). 기존
    -- 배포된 테이블에는 없는 컬럼이라 다른 컬럼들과 같은 방식으로 보강한다.
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS secondary_keywords JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS secondary_min_award_amount BIGINT;
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS secondary_max_award_amount BIGINT;

    -- 요구사항(2026-09-18 사용자 요청: "admin 과 msjbro 는 별도의 독립적인 id
    -- 야. msjbro에는 admin 의 모든 정보를 공유하지않아... 두 아이디로 입력은
    -- 서로 영향을 미치지 않아"): 예전에는 이 테이블이 id가 항상 1인 단일
    -- 행(전체 시스템 공용 설정)이었다. 계정마다 독립된 설정 행을 갖도록
    -- admin_user_id를 추가한다. 이미 배포되어 있던(admin 계정만 쓰던 시절의)
    -- 기존 행은 admin 계정 소유로 채워 넣는다 — ensureAdminSeeded()가
    -- ensureSchema() 다음에 실행되므로, 이 시점에 admin_users에 이미 'admin'
    -- 행이 있는 경우(=이번이 첫 배포가 아닌 경우)에만 채워지고, 정말 처음
    -- 배포되는 빈 DB에서는 app_settings에도 아직 행이 없어 채울 것이 없다.
    ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS admin_user_id INTEGER REFERENCES admin_users(id);
    UPDATE app_settings SET admin_user_id = (SELECT id FROM admin_users WHERE username = 'admin' LIMIT 1)
      WHERE admin_user_id IS NULL;
    ALTER TABLE app_settings ALTER COLUMN admin_user_id SET NOT NULL;
    -- id 컬럼은 과거에는 항상 1(DEFAULT 1)이었지만, 이제 계정마다 새 행이
    -- 생기므로 값을 명시하지 않고 INSERT해도 겹치지 않게 시퀀스를 건다.
    CREATE SEQUENCE IF NOT EXISTS app_settings_id_seq OWNED BY app_settings.id;
    SELECT setval('app_settings_id_seq', COALESCE((SELECT MAX(id) FROM app_settings), 1));
    ALTER TABLE app_settings ALTER COLUMN id SET DEFAULT nextval('app_settings_id_seq');
    CREATE UNIQUE INDEX IF NOT EXISTS app_settings_admin_user_id_idx ON app_settings (admin_user_id);

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

    -- 요구사항(2026-09-18 사용자 요청: "admin 과 msjbro 는 별도의 독립적인 id
    -- 야... 두 아이디로 입력은 서로 영향을 미치지 않아"): 스캔 실행도 계정마다
    -- 독립적으로 돈다. 기존 행(admin 계정만 쓰던 시절)은 admin 소유로 채운다.
    ALTER TABLE daily_scan_runs ADD COLUMN IF NOT EXISTS admin_user_id INTEGER REFERENCES admin_users(id);
    UPDATE daily_scan_runs SET admin_user_id = (SELECT id FROM admin_users WHERE username = 'admin' LIMIT 1)
      WHERE admin_user_id IS NULL;
    ALTER TABLE daily_scan_runs ALTER COLUMN admin_user_id SET NOT NULL;

    -- 위 "동시 실행 방지" 인덱스를 계정 단위로 바꾼다 — admin과 msjbro가 각자
    -- 07시에 자동 스캔을 돌리므로(계정마다 독립 실행), 한 계정이 스캔 중이라고
    -- 다른 계정의 스캔까지 막히면 안 된다. 같은 계정 안에서만 동시 실행을
    -- 막는다(자동 스캔과 수동 "지금 실행"이 겹치는 경우 등).
    DROP INDEX IF EXISTS daily_scan_runs_single_running;
    CREATE UNIQUE INDEX IF NOT EXISTS daily_scan_runs_single_running_per_admin
      ON daily_scan_runs (admin_user_id) WHERE status = 'running';

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

    -- 요구사항(2026-09-14 사용자 요청: "나라장터를 기본으로, 토지공사나 군대
    -- 입찰싸이트도 선택하면 검색할 수 있도록"): 이 매칭을 어느 사이트(나라장터/LH)
    -- 에서 찾았는지. 기존 배포된 테이블에는 없는 컬럼이라 다른 컬럼들과 같은
    -- 방식으로 보강한다.
    --
    -- (2026-09-19: 이 단계에서 하던 "유니크 인덱스를 source 포함 4개 컬럼으로
    -- 다시 만든다"는 DROP INDEX/CREATE UNIQUE INDEX는 제거했다. ensureSchema()는
    -- 매 부팅마다 이 스크립트 전체를 다시 실행하므로, 그 DROP+CREATE도 매번
    -- 재실행되어 최종(아래 admin_user_id + surrounding_text까지 포함하는) 인덱스를
    -- 매 부팅마다 이 옛날 4개 컬럼짜리 정의로 일시적으로 좁혔다가 다시 넓히고
    -- 있었다. 이미 admin/msjbro 두 계정이 같은 공고/키워드/첨부파일을 각자
    -- 찾아내는(따라서 admin_user_id만 다른) 정상적인 상황이 실제로 발생했는데,
    -- admin_user_id가 빠진 이 4개 컬럼 정의로는 그게 "중복"으로 보여 CREATE
    -- UNIQUE INDEX가 23505로 실패했고, 그 여파로 이 배치 전체(아래 surrounding_text
    -- 추가분 포함)가 롤백되어 조용히 무효화됐다. 이 단계는 과거 마이그레이션
    -- 경로의 중간 단계일 뿐이고 운영 DB는 이미 이 단계를 지나 최신 정의까지
    -- 가 있으므로, 재실행할 필요가 없고 재실행하면 오히려 위험하다 — 최종
    -- DROP INDEX/CREATE UNIQUE INDEX(맨 아래)만 남겨둔다.
    ALTER TABLE awarded_matches ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '나라장터';

    -- 요구사항(2026-09-18 사용자 요청: "admin 과 msjbro 는 별도의 독립적인 id
    -- 야. msjbro에는 admin 의 모든 정보를 공유하지않아... 두 아이디로 입력은
    -- 서로 영향을 미치지 않아"): 리드(매칭 결과)도 계정마다 독립적으로 쌓인다.
    -- 기존 행(admin 계정만 쓰던 시절)은 admin 소유로 채운다. 유니크 인덱스에도
    -- admin_user_id를 포함시켜, 두 계정이 우연히 같은 키워드로 같은 공고를
    -- 각자 찾아내도 한쪽이 다른 쪽 결과를 가려버리지(onConflictDoNothing으로
    -- 씹히지) 않고 각자의 리드로 독립적으로 남게 한다.
    -- (2026-09-19: 여기서 하던 "유니크 인덱스를 admin_user_id 포함 5개 컬럼으로
    -- 다시 만든다"는 DROP INDEX/CREATE UNIQUE INDEX도 같은 이유로 제거했다 —
    -- 바로 위 4개 컬럼 단계와 마찬가지로 매 부팅마다 재실행되는 중간 단계일
    -- 뿐이며, 운영 DB는 이미 이 단계를 지나 있다. 최종 정의(맨 아래, 6개
    -- 컬럼)로 한 번에 가도록 남겨둔다.
    ALTER TABLE awarded_matches ADD COLUMN IF NOT EXISTS admin_user_id INTEGER REFERENCES admin_users(id);
    UPDATE awarded_matches SET admin_user_id = (SELECT id FROM admin_users WHERE username = 'admin' LIMIT 1)
      WHERE admin_user_id IS NULL;
    ALTER TABLE awarded_matches ALTER COLUMN admin_user_id SET NOT NULL;

    -- 첨부파일 5개월 보관/자동삭제(attachment-cleanup.ts). 채워지면 디스크 파일은
    -- 이미 삭제된 상태이고 리드 레코드 자체는 남아있음을 뜻한다.
    ALTER TABLE awarded_matches ADD COLUMN IF NOT EXISTS attachment_deleted_at TIMESTAMPTZ;

    -- 요구사항(2026-09-12: 화면 주소를 사업자주소 대신 실제 공사현장으로).
    ALTER TABLE awarded_matches ADD COLUMN IF NOT EXISTS site_address TEXT;

    -- 요구사항(2026-09-19 사용자 재지적: "검색결과가 1000m2 이하인 것들도
    -- 많던데 내가 1000m2 이하는 검색하지 말라고 했잖아"): 위 유니크 인덱스가
    -- 첨부파일 단위로만 걸려 있어서, 같은 파일 안에서 "부직포"가 여러 줄에
    -- 걸쳐 여러 번 매칭돼도(예: 87㎡ 한 줄, 263㎡ 다른 줄) 전부 동일한
    -- 유니크 키를 가져 daily-scan.ts가 "매칭 2건 이상이니 1,000㎡ 이하
    -- 단독매칭 제외 규칙을 적용하지 않는다"고 정확히 판단해도, 실제로는
    -- onConflictDoNothing에 의해 그 중 1건만 저장되고 나머지는 조용히
    -- 사라졌다. surrounding_text(매칭된 줄의 셀/행 위치까지 포함하는 텍스트)를
    -- 인덱스에 추가해 같은 파일 안의 서로 다른 매칭 줄이 서로 다른 유니크
    -- 키를 갖게 한다 — schema/awarded-matches.ts 참고.
    DROP INDEX IF EXISTS awarded_matches_unique_hit;
    CREATE UNIQUE INDEX IF NOT EXISTS awarded_matches_unique_hit
      ON awarded_matches (admin_user_id, source, notice_number, matched_keyword, attachment_file_name, surrounding_text);

    -- 위 버그로 이미 저장된 기존 행 중 일부는 나머지 매칭이 조용히 유실된
    -- 채로 소규모 단독 매칭처럼 남아있을 수 있다. 이 정리는 데이터 삭제라
    -- 여기서 자동으로 하지 않는다 — 사용자가 직접 확인 후 정리를 요청하면
    -- 그때 처리한다(2026-09-19 대화 참고).

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

    -- 요구사항(2026-09-11 사용자 요청: 조달청 "조달업체 등록 내역" 공공데이터를
    -- 알려주며 "기존 낙찰자 정보를 이 API로 보강"해달라고 요청): 조달청
    -- "나라장터 사용자정보 서비스"(조달업체 기본정보 조회)로 사업자등록번호
    -- 기준 정확 매칭 조회한 주소/전화번호를 영구 캐시한다. 위 캐시(회사명+
    -- 지역 기준, 네이버용)와는 조회 기준과 출처가 달라 별도 테이블로 둔다.
    CREATE TABLE IF NOT EXISTS gov_corp_cache (
      bizno TEXT PRIMARY KEY,
      checked BOOLEAN NOT NULL DEFAULT false,
      address TEXT,
      phone TEXT,
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
