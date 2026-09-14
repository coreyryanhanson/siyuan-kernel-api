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

`integration.si.test.ts` runs only with `SIYUAN_INTEGRATION=1` plus `SIYUAN_BASE_URL` and `SIYUAN_API_TOKEN`; otherwise it self-skips so `vitest run` stays green without a live kernel. The 429-throttle pin additionally needs `SIYUAN_INTEGRATION_THROTTLE=1` — it locks the caller's IP out of the kernel, so it is opt-in. The encrypted-notebook round-trip additionally needs `SIYUAN_MASTER_PASSWORD` plus an encryption-enabled workspace; without the variable it self-skips.

## Design constraints (don't undo these)

- The client is **policy-free**: no version gating, budgets, or scoping — that belongs to callers.
- Every error extends `SiYuanKernelError`. `SiYuanRateLimitError` (429) is a *sibling* of `SiYuanAuthError`, never a subclass — a 429 can arrive with a correct token.
- Retry policy: never retry 401/403/429 (bad-token retries lock the IP out); single retry for network/timeout/5xx on reads only; writes are never retried; hard 30 s timeout per attempt.
- Content writes always send `dataType: "markdown"` — the kernel endpoints silently no-op (`code: 0`, `data: null`) without it.
- `search()` hardcodes `method: 0`; `method: 2` (SQL search) is admin-only and deliberately not exposed — raw SQL goes through `query()` only.
- **Subject-`id` naming rule.** The *subject* of an operation is always the method's `id` parameter (as in `removeDocByID(id)`, `renameNotebook(id, …)`); params that scope an operation keep their kernel body field names (as in `createDocWithMarkdown({ notebook, … })`); display-name params stay domain-faithful — a notebook takes `name`, a doc takes `title`.
- **Encrypted-notebook failure contract.** Every kernel-level rejection across the encrypted family (`createEncryptedNotebook`, `unlockAndOpenNotebook`, `getEncryptedNotebookStatus`) arrives as an HTTP 200 `code: -1` envelope — a plain `SiYuanApiError` with the kernel's localized `msg` — and the client attempts no code-level discrimination. Transport/5xx failures surface as the ordinary `SiYuanNetworkError`/`SiYuanTimeoutError`/`SiYuanApiError` like every other method.
- **Deferred endpoints** (revisit on first consumer demand): `lockNotebook` is a guarded alias of the shipped `closeNotebook` — both kernel handlers end in the identical locked state for an encrypted box, the only delta being the not-encrypted guard — so revisit only if a real consumer asks for the self-describing verb; `getNotebookConf`/`setNotebookConf` and `changeSortNotebook`/`reorderNotebooks`/`setNotebookIcon`/`getNotebookInfo` are purely additive later and none conflicts with a planned signature; `boxDocEnabled` sits on the `lsNotebooks` envelope, not on notebook rows, so surfacing it means changing `listNotebooks`'s return shape, not widening a row type. `unlockNotebook` is subsumed by `unlockAndOpenNotebook` — unlock-without-mount has no consumer. (Enabling workspace encryption itself is a host deployment action outside any single call and stays out of the client; `createEncryptedNotebook` merely *requires* an already-enabled workspace — `getEncryptedNotebookStatus().enabled` is the typed check.) The rest of the `notebook/*` crypto family (`changeMasterPassword`, `setNotebookCryptoAutoLock`, backup import/export) and `touchEncryptedNotebooks` stay out on the same no-consumer rationale.
- Six items are absent from SiYuan's API references but pinned by integration tests (see README "Scope notes" for the list and per-route caveats); don't remove those tests.

## Releases

`npm run release:patch|minor|major` bumps, commits, tags, publishes, and pushes. `prepublishOnly` runs tests, typecheck, and the pack check.
