# Replit 배포 가이드 — 나라장터 공고 첨부문서 검색

이 문서는 이 코드를 Replit에 올려서 실제로 동작하는 웹 서비스로 배포하는 절차입니다.
아래 순서대로 진행하면 됩니다.

## 0. 이 문서를 만들면서 확인/수정한 것

- `pnpm install`, `pnpm run typecheck` 모두 이 환경에서 정상 통과했습니다. (코드 자체는 문제 없이 빌드됩니다.)
- API 서버를 로컬 Postgres에 연결해 실제로 띄우고, 공고번호 엑셀 업로드(`/api/bids/import`)를 실제 파일로 테스트했습니다 — 정상 동작 확인.
- **`.replit`의 배포 방식을 `autoscale` → `vm`(Reserved VM)으로 바꿨습니다.** 이유: 이 서버는 진행 중인 작업 상태와 다운로드한 첨부파일을 서버 메모리·로컬 디스크에 저장합니다(`artifacts/api-server/src/lib/bid-processing.ts`). Autoscale은 인스턴스를 여러 개로 늘리는데, 인스턴스마다 메모리·디스크가 따로라서 작업을 시작한 인스턴스와 다른 인스턴스가 상태를 조회하면 "작업을 찾을 수 없습니다" 오류가 무작위로 발생합니다. Reserved VM은 인스턴스가 하나로 고정되어 이 문제가 없습니다. (나중에 여러 인스턴스로 확장하려면 작업 상태를 Postgres로 옮기는 작업이 필요합니다 — 하단 "다음 단계" 참고.)

## 1. Replit에 프로젝트 올리기

1. [replit.com](https://replit.com) 로그인 → **Create App** → **Import from...** 대신, 받으신 zip 파일을 그대로 새 Repl로 업로드하세요.
   - Replit 우측 상단 "Create Repl" → 파일 업로드(zip) 옵션을 사용하거나,
   - 이 코드를 먼저 GitHub 저장소에 올린 뒤 Replit에서 "Import from GitHub"로 가져오는 방법도 가능합니다 (팀으로 협업하신다면 이 방법을 추천합니다).
2. 프로젝트 타입은 자동으로 Node.js/PNPM Workspace로 인식됩니다 (`.replit`, `pnpm-workspace.yaml` 포함되어 있음).

## 2. 데이터베이스 연결

1. Replit 좌측 도구 메뉴에서 **Postgres Database**를 추가하면 `DATABASE_URL`이 자동으로 발급됩니다.
2. Shell 탭에서 아래 명령으로 스키마를 적용하세요 (지금은 빈 스키마라 "No changes detected"만 뜨는 게 정상입니다 — 앱이 아직 DB 대신 메모리/디스크에 작업 상태를 저장하기 때문입니다):
   ```
   pnpm --filter @workspace/db run push
   ```

## 3. 환경변수(Secrets) 설정

Replit 좌측 **Secrets** 탭에서 아래 값을 등록하세요.

| 이름 | 값 | 비고 |
|---|---|---|
| `DATABASE_URL` | (2번에서 자동 발급된 값) | Replit Postgres 추가 시 자동 채워짐 |
| `SESSION_SECRET` | 임의의 긴 무작위 문자열 | 예: `openssl rand -hex 32` 로 생성 |
| `DATA_GO_KR_SERVICE_KEY` | 보유하신 공공데이터포털 나라장터 서비스키 | **절대 코드나 채팅에 직접 붙여넣지 말고 Secrets에만 저장하세요** |

## 4. 실행 확인 (배포 전 테스트)

1. Replit 상단 **Run** 버튼(workflow "Project")을 눌러 개발 서버를 띄웁니다.
2. 웹 화면에서 공고번호가 담긴 엑셀/CSV 파일을 실제로 업로드해 유효 건수·중복·형식오류가 제대로 표시되는지 확인하세요.
3. 키워드를 등록하고 "수집 시작"을 눌러 실제 나라장터 공고 조회·첨부문서 다운로드·키워드 검색이 정상 동작하는지 확인하세요. (이 단계부터는 `DATA_GO_KR_SERVICE_KEY`가 정확히 등록되어 있어야 동작합니다.)

## 5. 배포(Deploy)

1. Replit 상단 **Deploy** 탭 → **Reserved VM** 선택 (Autoscale이 아님, 위 0번 항목 참고).
2. 필요한 만큼의 vCPU/메모리를 선택하고, 위 3번의 Secrets를 배포 설정에도 동일하게 등록합니다.
3. Deploy를 누르면 `https://[프로젝트명].replit.app` 형태의 공개 URL이 생성됩니다. 커스텀 도메인을 연결하려면 Replit Deployments의 도메인 설정에서 등록하세요.

## 현재 알아두셔야 할 제약 (v1 기준)

- **작업 상태·다운로드 결과는 서버 로컬 디스크에 저장됩니다.** Reserved VM 하나로 운영하는 동안은 문제없지만, 재배포(코드 업데이트로 다시 Deploy)하면 디스크가 초기화되어 진행 중이던 작업 기록은 사라집니다. 완료된 결과를 오래 보관하려면 Postgres나 Replit Object Storage로 옮기는 작업이 필요합니다.
- **결제 기능은 아직 없습니다.** 말씀하신 대로 지금은 앱 기능 자체를 우선했습니다. 유료 판매를 준비하실 때 회원가입/로그인 + Stripe 등 결제 연동 + 사용량 제한을 추가로 붙여야 합니다.
- **공공데이터포털 서비스키 호출 한도**를 확인하세요. 대량 공고를 한 번에 수집하면 일일 호출 한도에 걸릴 수 있습니다.

## 다음 단계로 추천하는 것

1. 결제/회원 기능 붙이기 (Stripe + 로그인) — 요청 주시면 이어서 작업하겠습니다.
2. 작업 상태를 Postgres 테이블로 이전해 재배포/장애에도 결과가 남도록 하기.
3. 완료된 결과(ZIP/XLSX)를 Replit Object Storage 등 영구 저장소로 옮겨 다운로드 링크를 오래 유지하기.
