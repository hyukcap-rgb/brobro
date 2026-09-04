# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `DATA_GO_KR_SERVICE_KEY` — 나라장터 공공데이터포털 서비스키
- Optional env: `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` — Naver 지역검색 Open API (free), last-resort fallback for filling in a winning bidder's address/phone when the government award record and the notice's own attachments don't have it

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

- Winning-bidder contact info (`bidderAddress`/`bidderPhone` on `BidSearchResult`) is filled in through a fallback chain in `enrichKeywordResults` (bid-processing.ts): government award record → the notice's own downloaded attachments (free, regex-based) → Naver 지역검색 portal search (needs `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`, otherwise silently skipped). `contactSource` on the result records which stage actually filled it in.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
