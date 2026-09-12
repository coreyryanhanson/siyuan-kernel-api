# siyuan-kernel-api

Typed client for the [SiYuan](https://github.com/siyuan-note/siyuan) kernel HTTP API. Zero runtime dependencies, native `fetch` only.

The client is deliberately policy-free: it calls the kernel API exactly as specified, with hand-rolled types over the response shapes, and leaves all policy (version gating, result budgets, scoping) to the caller.

## Install

```sh
npm install siyuan-kernel-api
```

Requires Node >= 20.

## Usage

The base URL and API token are always passed to the constructor; nothing is hardcoded. The token is the one configured in SiYuan under *Settings → About → API token*. Requests are sent as `Authorization: Token <key>`.

```ts
import { SiYuanKernelClient } from "siyuan-kernel-api";

const client = new SiYuanKernelClient("http://127.0.0.1:6806", "<api-token>");

const version = await client.getVersion();
const notebooks = await client.listNotebooks();

const rows = await client.query(
  "SELECT id, content, root_id FROM blocks WHERE type = 'd' LIMIT 10",
);

const result = await client.search({
 query: "docker networking",
 paths: [notebooks[0].id],
 pageSize: 64,
});

const doc = await client.exportMarkdown("<doc-id>");
const children = await client.getChildBlocks("<block-id>");
```

### Endpoints

| Method | Kernel route | Notes |
| --- | --- | --- |
| `getVersion()` | `/api/system/version` | Raw version string |
| `listNotebooks()` | `/api/notebook/lsNotebooks` | Unwraps `data.notebooks` |
| `query(stmt, mode)` | `/api/query/sql` | `mode` is always `"readonly"` |
| `search({query, paths, pageSize})` | `/api/search/fullTextSearchBlock` | Keyword search only; `types`/`orderBy`/`groupBy` omitted (kernel defaults apply) |
| `exportMarkdown(id)` | `/api/export/exportMdContent` | Doc as GFM markdown |
| `getChildBlocks(id)` | `/api/block/getChildBlocks` | Children in document order |
| `createDocWithMarkdown({notebook, path, markdown, parentID?, tags?})` | `/api/filetree/createDocWithMd` | Returns the new doc's ID |
| `insertBlock({data, nextID?, previousID?, parentID?})` | `/api/block/insertBlock` | |
| `appendBlock({data, parentID})` | `/api/block/appendBlock` | |
| `updateBlock({id, data, lockType?})` | `/api/block/updateBlock` | |
| `deleteBlock(id)` | `/api/block/deleteBlock` | |
| `moveBlock({id, previousID?, parentID?})` | `/api/block/moveBlock` | Returns `null` (the kernel sets no `data` here) |
| `removeDocByID(id)` | `/api/filetree/removeDocByID` | |
| `moveDocsByID({fromIDs, toID})` | `/api/filetree/moveDocsByID` | |

All requests are `POST` with JSON bodies. Content writes always send `dataType: "markdown"`, since the endpoints panic into a silent no-op (`code: 0`, `data: null`) when the field is missing.

## Error handling

Every error extends `SiYuanKernelError`; branch with `instanceof`. All classes are exported from the package root:

```ts
import {
  SiYuanKernelError,
  SiYuanAuthError,
  SiYuanRateLimitError,
  SiYuanTimeoutError,
  SiYuanNetworkError,
  SiYuanApiError,
} from "siyuan-kernel-api";
```

| Class | Thrown when |
| --- | --- |
| `SiYuanAuthError` | HTTP 401 or 403 |
| `SiYuanRateLimitError` | HTTP 429 from the kernel's per-IP auth throttle. Carries `retryAfterSeconds` (from `Retry-After`). A 429 can arrive with a *correct* token because the lock is per-IP, so it is a sibling of `SiYuanAuthError`, never a subclass. |
| `SiYuanTimeoutError` | An attempt exceeded the 30 s timeout |
| `SiYuanNetworkError` | `fetch` itself rejected (DNS, connection refused, …) |
| `SiYuanApiError` | Any other non-2xx, or a 2xx whose body is not a `code`/`msg`/`data` envelope with `code === 0`. Carries `status`, and `code`/`msg` when the envelope parsed. |

Retry policy, built in:

- **Never retried:** 401/403/429. The kernel rate-locks IPs after repeated bad-token attempts, and a retry loop with a bad token locks the caller out entirely.
- **Single retry, reads only:** network errors, timeouts, and 5xx on idempotent read endpoints. Writes are never retried.
- **Every call carries a hard 30 s timeout** per attempt (native `fetch` waits forever by default).

## Scope notes

- **Documented endpoints only, two named exceptions**: `/api/search/fullTextSearchBlock` (absent from SiYuan's API.md, but backed by the same kernel function SiYuan's own MCP server exposes) and the `mode: "readonly"` flag on `/api/query/sql` (kernel-enforced `sqlite3_stmt_readonly` check). Both are pinned by integration tests.
- The search method hardcodes `method: 0` (keyword). The route also accepts `method: 2` (SQL search), which is an admin-only capability; not exposing it keeps raw SQL reachable only through `query()`.
- `getVersion()` fetches and returns the version string; it holds no pinned constant and enforces nothing.
- Types cover only the fields these methods consume; unknown fields pass through via `Record<string, unknown>` intersections.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest unit tests
npm run lint        # oxlint --deny-warnings
npm run fmt:check   # oxfmt --check
```

`integration.si.test.ts` runs against a live SiYuan kernel: enabled with `SIYUAN_INTEGRATION=1`, configured via `SIYUAN_BASE_URL` / `SIYUAN_API_TOKEN`, plus `SIYUAN_INTEGRATION_THROTTLE=1` for the 429 throttle case. Unit tests mock `fetch`.

Releases: `npm run release:patch|minor|major` (bumps the version, tags, and pushes; `prepublishOnly` runs tests, typecheck, and a pack-content check).

## License

[AGPL-3.0-or-later](LICENSE)
