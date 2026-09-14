# siyuan-kernel-api

Single-package TypeScript library: a typed, zero-runtime-dependency client for the SiYuan kernel HTTP API. No build step — the package ships raw `.ts` sources (`main: ./index.ts`), so every file must stay valid both as source and as published artifact.

## Commands

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest run (unit only; integration self-skips)
npm run lint         # oxlint --deny-warnings
npm run fmt:check    # oxfmt --check
node scripts/check-pack.mjs   # tarball contents == tracked non-test .ts files
```

Run one test file: `npx vitest run client.test.ts`. CI (Node 22) runs lint, fmt:check, typecheck, test, and check-pack — run all five before pushing.

## Toolchain quirks

- Lint/format is **oxc** (oxlint + oxfmt), not eslint/prettier. Tabs, width 2, print width 80; oxfmt ignores JSON/markdown/YAML.
- Pre-commit runs lint-staged (`oxfmt` + `oxlint --fix --deny-warnings`) on staged `.ts` files.
- tsconfig has `verbatimModuleSyntax` (use `import type` for type-only imports), `noUncheckedIndexedAccess`, `strict`.
- `check-pack.mjs` uses `--ignore-scripts` deliberately (husky pollutes pack JSON otherwise). Don't "fix" that.

## Integration tests

`integration.si.test.ts` runs only with `SIYUAN_INTEGRATION=1` plus `SIYUAN_BASE_URL` and `SIYUAN_API_TOKEN`; otherwise it self-skips so `vitest run` stays green without a live kernel. The 429-throttle pin additionally needs `SIYUAN_INTEGRATION_THROTTLE=1` — it locks the caller's IP out of the kernel, so it is opt-in.

## Design constraints (don't undo these)

- The client is **policy-free**: no version gating, budgets, or scoping — that belongs to callers.
- Every error extends `SiYuanKernelError`. `SiYuanRateLimitError` (429) is a *sibling* of `SiYuanAuthError`, never a subclass — a 429 can arrive with a correct token.
- Retry policy: never retry 401/403/429 (bad-token retries lock the IP out); single retry for network/timeout/5xx on reads only; writes are never retried; hard 30 s timeout per attempt.
- Content writes always send `dataType: "markdown"` — the kernel endpoints silently no-op (`code: 0`, `data: null`) without it.
- `search()` hardcodes `method: 0`; `method: 2` (SQL search) is admin-only and deliberately not exposed — raw SQL goes through `query()` only.
- **Subject-`id` naming rule.** The *subject* of an operation is always the method's `id` parameter (as in `removeDocByID(id)`, `renameNotebook(id, …)`); params that scope an operation keep their kernel body field names (as in `createDocWithMarkdown({ notebook, … })`); display-name params stay domain-faithful — a notebook takes `name`, a doc takes `title`.
- **Deferred endpoints** (revisit on first consumer demand): `createEncryptedNotebook`/`lockNotebook` need workspace-level key-domain setup outside any single call, so a typed method would read as safe while the prerequisite lives one layer down; `getNotebookConf`/`setNotebookConf` and `changeSortNotebook`/`reorderNotebooks`/`setNotebookIcon`/`getNotebookInfo` are purely additive later and none conflicts with a planned signature; `boxDocEnabled` sits on the `lsNotebooks` envelope, not on notebook rows, so surfacing it means changing `listNotebooks`'s return shape, not widening a row type.
- Three endpoints are undocumented upstream but pinned by integration tests: `/api/search/fullTextSearchBlock`, `/api/search/listInvalidBlockRefs`, and `mode: "readonly"` on `/api/query/sql`. Don't remove those tests.

## Releases

`npm run release:patch|minor|major` bumps, commits, tags, publishes, and pushes. `prepublishOnly` runs tests, typecheck, and the pack check.
