# Changelog

## [Unreleased]

## [0.2.0] - 2026-09-14

### Added

- **Notebook lifecycle and doc-rename endpoints** — `createNotebook(name)`
  (returns the new notebook row, symmetric with `listNotebooks()`),
  `removeNotebook(id)`, `renameNotebook(id, name)`, `openNotebook(id)` /
  `closeNotebook(id)` (the recovery path for writing into a notebook closed
  in the UI, which fails kernel-side with `ErrBoxClosed`), and
  `renameDocByID(id, title)` (updates the hpath's last segment; renaming the
  box doc renames the notebook when box-doc is enabled). An empty or
  whitespace-only name gets the kernel's default "untitled" name. Also
  `listInvalidBlockRefs({page?, pageSize?})`, the only detection route for
  block references orphaned by `removeDocByID`/`deleteBlock`: a paginated
  read (kernel defaults 1/32, `page` is 1-based) that resolves `null` for a
  page past the kernel's range and an empty page at the exact-multiple
  boundary.

### Changed

- **Breaking:** `SearchBlock` gained a required `content: string` field; the
  kernel always sets it. Only consumers that construct `SearchBlock` literals
  (test fixtures, mocks) are affected.
- `search()` accepts optional `page` and `pageSize` (kernel defaults 1/32;
  `page` is 1-based). 0.1.0 required `pageSize` and never sent `page`, so
  every search was silently page 1 and `pageCount` pages ≥ 2 were
  unreachable through the typed client.

### Fixed

- `listNotebooks()` and `createNotebook()` throw a typed `SiYuanApiError`
  instead of a raw `TypeError` if the kernel returns a `code: 0` /
  `data: null` envelope, so every error extends `SiYuanKernelError`.
- A response body that stalls past the 30 s timeout now surfaces as
  `SiYuanTimeoutError` (retried once on reads) instead of `SiYuanApiError`.

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
