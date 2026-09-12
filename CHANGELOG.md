# Changelog

## [0.1.0] - 2026-09-12

### Added

- **Initial release of `siyuan-kernel-api`** — a typed, zero-runtime-dependency
  client for the [SiYuan](https://github.com/siyuan-note/siyuan) kernel HTTP
  API. Ships raw `.ts` sources with no build step (`main`/`types` point
  directly at `index.ts`), uses native `fetch` only, and is deliberately
  policy-free: base URL and API token are injected per constructor, and the
  client holds no pinned version constant, no write gate, and no result
  budgets — all policy (version gating, budgets, scoping) belongs to the
  caller. Types are hand-rolled over only the fields the methods consume,
  with unknown kernel fields passed through via `Record<string, unknown>`
  intersections.

- **Endpoint surface** — `getVersion()`, `listNotebooks()`, `query(stmt)`
  (always sends `mode: "readonly"`, kernel-enforced via
  `sqlite3_stmt_readonly`), `search({query, paths, pageSize})` (hardcoded
  keyword `method: 0`; the admin-only `method: 2` SQL search is not exposed,
  so raw SQL is reachable only through `query()`), `exportMarkdown(id)`,
  `getChildBlocks(id)`, `createDocWithMarkdown()`, `insertBlock()` /
  `appendBlock()` / `updateBlock()` / `deleteBlock()` / `moveBlock()`,
  `removeDocByID()`, and `moveDocsByID()`.

- **Content writes always send `dataType: "markdown"`.** The kernel's block
  write endpoints silently no-op (`code: 0`, `data: null`) when the field is
  missing, so it is hardcoded rather than exposed. For the same reason
  `createDocWithMarkdown`'s `tags` parameter is typed as a plain string — an
  array would panic into the same silent no-op.

- **Total error hierarchy under `SiYuanKernelError`.** Callers branch with
  `instanceof`: `SiYuanAuthError` (HTTP 401/403), `SiYuanRateLimitError`
  (HTTP 429, carrying `retryAfterSeconds` from `Retry-After`),
  `SiYuanTimeoutError`, `SiYuanNetworkError` (with `cause`), and
  `SiYuanApiError` (any other non-2xx, or a 2xx whose body is not a valid
  `code`/`msg`/`data` envelope with `code === 0`). `SiYuanRateLimitError` is
  a *sibling* of `SiYuanAuthError`, never a subclass: the kernel's per-IP
  auth throttle can return 429 with a perfectly correct token, so the error
  never tells the caller to fix the token.

- **Built-in retry and timeout policy.** Every attempt carries a hard 30 s
  timeout. 401/403/429 are never retried — the kernel rate-locks IPs after
  repeated bad-token attempts, so retrying with a bad token locks the caller
  out entirely. Reads get a single retry on network error, timeout, or 5xx;
  writes are never retried.

- **Opt-in live integration suite** (`integration.si.test.ts`), enabled with
  `SIYUAN_INTEGRATION=1` plus `SIYUAN_BASE_URL` / `SIYUAN_API_TOKEN`, with a
  separate `SIYUAN_INTEGRATION_THROTTLE=1` opt-in for the 429 throttle case
  (it locks the caller's IP out of the kernel). Pins the two endpoints absent
  from SiYuan's API.md — `/api/search/fullTextSearchBlock` and
  `mode: "readonly"` on `/api/query/sql` — whose behavior is nonetheless
  backed by kernel functions SiYuan's own MCP server relies on.
