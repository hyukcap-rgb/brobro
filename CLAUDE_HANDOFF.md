# 나라장터 공고 첨부문서 검색 — Claude handoff

This archive contains the application source, workspace configuration, API contract, generated API client/Zod types, and document-processing code.

## Install and run

- Node.js 24 and pnpm are expected.
- Install dependencies with `pnpm install`.
- Run the API server with `pnpm --filter @workspace/api-server run dev`.
- Run the web app with `pnpm --filter @workspace/bid-attachment-search run dev`.
- Run the API typecheck with `pnpm --filter @workspace/api-server run typecheck`.

## Required environment

Set these in the target environment; values are intentionally not included in this archive:

- `DATABASE_URL`
- `SESSION_SECRET`
- `DATA_GO_KR_SERVICE_KEY`
- Object Storage variables used by the project, if persistent attachment storage is enabled.

Never commit or paste secret values into source files.

## Main areas

- `artifacts/api-server/src/lib/bid-processing.ts`: public API requests, retries/circuit breaker, attachment downloads, ZIP extraction, parsing, keyword search, and jobs.
- `artifacts/api-server/src/routes/bids.ts`: upload, collection, status, retry, and result endpoints.
- `artifacts/bid-attachment-search/src/pages/home.tsx`: web UI.
- `lib/api-spec/openapi.yaml`: API contract source of truth.
- `lib/api-zod` and `lib/api-client-react`: generated API types and client.
