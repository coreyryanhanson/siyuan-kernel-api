import {
	SiYuanApiError,
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	SiYuanTimeoutError,
} from "./errors.js";
import type {
	BlockTransaction,
	ChildBlock,
	EncryptedNotebookStatus,
	ExportMarkdownResult,
	NotebookInfo,
	NotebookList,
	SearchResult,
} from "./types.js";

/** Hard per-attempt timeout; a read that exhausts its single retry worst-cases at ~60s wall clock. */
const TIMEOUT_MS = 30_000;

export interface SiYuanKernelClientOptions {
	/** Injection seam for unit tests; defaults to globalThis.fetch. */
	fetch?: typeof fetch;
}

interface Envelope {
	code: number;
	msg: unknown;
	data: unknown;
}

function isEnvelope(value: unknown): value is Envelope {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Envelope).code === "number"
	);
}

function isTimeoutError(err: unknown): boolean {
	return err instanceof Error && err.name === "TimeoutError";
}

/**
 * Typed client for the SiYuan kernel HTTP API.
 * Zero runtime dependencies — native fetch only.
 * URL + token are injected by the caller; nothing is hardcoded here.
 * No version constant and no write gate live in this package (extension-owned).
 */
export class SiYuanKernelClient {
	/** Kernel origin without trailing slash, e.g. "http://127.0.0.1:6806". */
	readonly baseUrl: string;
	readonly token: string;
	private readonly doFetch: typeof fetch;

	constructor(
		baseUrl: string,
		token: string,
		options?: SiYuanKernelClientOptions,
	) {
		const url = baseUrl.trim();
		if (!url) {
			throw new TypeError("baseUrl must be a non-empty string");
		}
		const trimmedToken = token.trim();
		if (!trimmedToken) {
			throw new TypeError("token must be a non-empty string");
		}
		// Normalize once here so endpoint paths can be joined unconditionally.
		const normalized = url.replace(/\/+$/, "");
		if (!normalized) {
			throw new TypeError("baseUrl must contain a non-empty origin");
		}
		this.baseUrl = normalized;
		this.token = trimmedToken;
		this.doFetch = options?.fetch ?? globalThis.fetch;
	}

	/** `/api/system/version` — the raw version string. No gate, no pinned constant. */
	async getVersion(): Promise<string> {
		return this.request<string>("/api/system/version", {}, { retryable: true });
	}

	// Shared write-route note (applies to every write method below, and to the
	// filetree/doc writes): these routes carry `CheckAdminRole` and are blocked
	// in read-only workspaces by the `CheckReadonly` middleware (`code: -1`).

	/**
	 * `/api/notebook/createNotebook`. An empty or whitespace-only name is not
	 * an error — the kernel substitutes its default "untitled" name (names
	 * beyond 512 runes fail with `code: -1`); a missing `name` field is a hard
	 * error, unreachable through this typed signature.
	 *
	 * Unwraps `data.notebook` — the kernel returns the full new-notebook row,
	 * the same shape as an `lsNotebooks` row.
	 */
	async createNotebook(name: string): Promise<NotebookInfo> {
		return this.createNotebookRow("/api/notebook/createNotebook", {
			name,
		});
	}

	/**
	 * `/api/notebook/createEncryptedNotebook`. Creates an encrypted notebook
	 * and returns it mounted and unlocked — the locked state is reached via
	 * closeNotebook.
	 *
	 * Requires workspace encryption to be enabled already; check
	 * getEncryptedNotebookStatus().enabled first, otherwise the call fails
	 * with `code: -1` ("Encrypted notebook feature is not enabled"). Names
	 * beyond 512 runes fail with `code: -1`; an empty name gets the kernel's
	 * default "untitled" name. The password transits the request body in
	 * plaintext over HTTP.
	 *
	 * On a mount failure the kernel re-locks the box, so the notebook may
	 * remain created but locked.
	 */
	async createEncryptedNotebook(
		name: string,
		password: string,
	): Promise<NotebookInfo> {
		return this.createNotebookRow("/api/notebook/createEncryptedNotebook", {
			name,
			password,
		});
	}

	/**
	 * `/api/notebook/getEncryptedNotebookStatus` — the encrypted-notebook
	 * family's state read: whether workspace encryption is enabled (the
	 * precondition gate for createEncryptedNotebook) and which encrypted
	 * boxes exist, locked or unlocked. A pure read with no `CheckReadonly`,
	 * so it works in read-only workspaces. A row's `name` is empty for a box
	 * that is not mounted/unlocked. The `state` unions are the v3.8.3
	 * kernel's values.
	 */
	async getEncryptedNotebookStatus(): Promise<EncryptedNotebookStatus> {
		return this.request<EncryptedNotebookStatus>(
			"/api/notebook/getEncryptedNotebookStatus",
			{},
			{ retryable: true },
		);
	}

	/**
	 * `/api/notebook/removeNotebook` — posts the subject as `notebook` (the
	 * endpoint's real body field). Synchronous: the kernel deletes the
	 * directory and cleans indexes before responding.
	 *
	 * An empty-string id is rejected with `code: -1` ("Field [notebook] must
	 * not be empty") before the malformed-ID check. A well-formed but unknown
	 * id is a silent success (`code: 0` / `data: null`) — the kernel gives no
	 * signal to distinguish it from an existing notebook, and neither does
	 * this method.
	 */
	async removeNotebook(id: string): Promise<null> {
		return this.request<null>(
			"/api/notebook/removeNotebook",
			{ notebook: id },
			{ retryable: false },
		);
	}

	/**
	 * `/api/notebook/renameNotebook` — posts as `notebook` plus the new
	 * `name`. An empty or whitespace-only name is silently substituted with
	 * the kernel's default "untitled" name (same as createNotebook).
	 *
	 * An empty-string id is rejected with `code: -1` before the malformed-ID
	 * check (same as removeNotebook). Locked encrypted boxes fail with a
	 * `code: -1` lease error (kernel `Language(314)`).
	 */
	async renameNotebook(id: string, name: string): Promise<null> {
		return this.request<null>(
			"/api/notebook/renameNotebook",
			{ notebook: id, name },
			{ retryable: false },
		);
	}

	/**
	 * `/api/notebook/openNotebook` — posts the subject as `notebook` (the
	 * endpoint's real body field). Re-mounts a closed notebook, the recovery
	 * path for doc writes that would otherwise fail with `ErrBoxClosed`.
	 * Synchronous: the kernel completes the mount before responding.
	 *
	 * An empty-string id is rejected with `code: -1` ("Field [notebook] must
	 * not be empty") before the malformed-ID check. Locked encrypted boxes
	 * fail with a `code: -1` lease error (kernel `Language(314)`); the
	 * recovery path is unlockAndOpenNotebook.
	 */
	async openNotebook(id: string): Promise<null> {
		return this.request<null>(
			"/api/notebook/openNotebook",
			{ notebook: id },
			{ retryable: false },
		);
	}

	/**
	 * `/api/notebook/closeNotebook` — posts as `notebook` (the endpoint's
	 * real body field). Unmount cannot fail; the only failure path is a
	 * malformed id (`code: -1`) — unlike its siblings, the handler does not
	 * reject an empty string first, it goes straight to the malformed-ID
	 * check. On an encrypted notebook it also locks the box — the cached key
	 * is cleared and the encrypted db closed, so a later openNotebook fails
	 * with the lease error until unlockAndOpenNotebook.
	 */
	async closeNotebook(id: string): Promise<null> {
		return this.request<null>(
			"/api/notebook/closeNotebook",
			{ notebook: id },
			{ retryable: false },
		);
	}

	/**
	 * `/api/notebook/unlockAndOpenNotebook` — the recovery path for a locked
	 * encrypted notebook (closeNotebook on an encrypted box produces that
	 * state). Derives the box key from the master password and unlocks plus
	 * mounts the box; returns null on success.
	 *
	 * A wrong password is rejected with `code: -1` only on a locked box; an
	 * already-unlocked box re-mounts without re-verifying the password.
	 * An empty or whitespace-only id or password is rejected with `code: -1`
	 * before any crypto work. Unlocked boxes auto-lock on idle, so an
	 * unlock-then-work flow can hit a mid-flow auto-lock.
	 */
	async unlockAndOpenNotebook(id: string, password: string): Promise<null> {
		return this.request<null>(
			"/api/notebook/unlockAndOpenNotebook",
			{ notebook: id, password },
			{ retryable: false },
		);
	}

	/**
	 * `/api/notebook/lsNotebooks` — returns the `data` envelope, including the
	 * `boxDocEnabled` gate for `NotebookInfo.subFileCount`. The `notebooks`
	 * unwrap is guarded: a `code: 0` success envelope whose `data` carries no
	 * `notebooks` field (missing or `null`) surfaces as `SiYuanApiError`,
	 * never a raw `TypeError` (same as createNotebook).
	 */
	async listNotebooks(): Promise<NotebookList> {
		const data = await this.request<NotebookList>(
			"/api/notebook/lsNotebooks",
			{},
			{ retryable: true },
		);
		if (data?.notebooks == null) {
			throw new SiYuanApiError(
				200,
				undefined,
				"envelope data carries no notebooks",
			);
		}
		return data;
	}

	/**
	 * `/api/query/sql` — sends `mode: "readonly"` hardcoded: it is the only
	 * mode the kernel validates for read-only safety (mode "" gets only a
	 * single-statement check and still permits writes), and the modes without
	 * that check offer a corruption path that reports success. Readonly
	 * forever — the block/doc write methods are the write surface. A
	 * `code: 0` / `data: null` envelope is normalized to `[]` so a nil result
	 * can never surface as `null` against the non-nullable signature.
	 */
	async query(stmt: string): Promise<Record<string, unknown>[]> {
		const data = await this.request<Record<string, unknown>[] | null>(
			"/api/query/sql",
			{ stmt, mode: "readonly" },
			{ retryable: true },
		);
		return data ?? [];
	}

	/**
	 * `/api/search/fullTextSearchBlock`. Only `query`/`paths` are required;
	 * `page` (1-based) and `pageSize` are optional and omitted from the wire
	 * body when unset — the kernel defaults are page 1 / pageSize 32, and
	 * `pageCount` in the response reveals the effective page size. `method: 0`
	 * is hardcoded and `types`/`orderBy`/`groupBy` are omitted entirely, so the
	 * SQL-smuggling bypass cannot be reintroduced by a caller. Pagination runs
	 * in SQL (LIMIT/OFFSET), so an out-of-range `page` is a benign empty page.
	 */
	async search(params: {
		query: string;
		paths: string[];
		page?: number;
		pageSize?: number;
	}): Promise<SearchResult> {
		return this.request<SearchResult>(
			"/api/search/fullTextSearchBlock",
			{ ...compact(params), method: 0 },
			{ retryable: true },
		);
	}

	/**
	 * `/api/search/listInvalidBlockRefs` — blocks whose refs point at missing
	 * targets (e.g. after removeDocByID/deleteBlock). Paginated read: `page` is
	 * 1-based; omitted params are omitted from the wire body, so the kernel's
	 * 1/32 defaults apply.
	 *
	 * Out-of-range `page` resolves `null` — the kernel's panic path flushes a
	 * `code: 0` / `data: null` envelope — while a page at the exact-multiple
	 * boundary returns an empty page object; treat both as "nothing more".
	 * (fullTextSearchBlock paginates in SQL instead, so the same params yield a
	 * benign empty page there — not a shared contract.)
	 */
	async listInvalidBlockRefs(params?: {
		page?: number;
		pageSize?: number;
	}): Promise<SearchResult | null> {
		return this.request<SearchResult | null>(
			"/api/search/listInvalidBlockRefs",
			compact(params ?? {}),
			{ retryable: true },
		);
	}

	/** `/api/export/exportMdContent`. */
	async exportMarkdown(id: string): Promise<ExportMarkdownResult> {
		return this.request<ExportMarkdownResult>(
			"/api/export/exportMdContent",
			{ id },
			{ retryable: true },
		);
	}

	/**
	 * `/api/block/getChildBlocks`. Kernel guard rails (verified live against
	 * 3.8.x): a childless block returns `code: 0`/`data: []` (never null), and
	 * an unknown or locked-block id returns `code: -1` with null data, which
	 * surfaces as `SiYuanApiError`.
	 */
	async getChildBlocks(id: string): Promise<ChildBlock[]> {
		return this.request<ChildBlock[]>(
			"/api/block/getChildBlocks",
			{ id },
			{ retryable: true },
		);
	}

	/** `/api/filetree/createDocWithMd`. `parentID`/`tags` pass through when set. */
	async createDocWithMarkdown(params: {
		notebook: string;
		path: string;
		markdown: string;
		parentID?: string;
		/** Plain string — the kernel does `tagsArg.(string)`; an array would panic into a silent `code: 0` / `data: null`. */
		tags?: string;
	}): Promise<string> {
		return this.request<string>(
			"/api/filetree/createDocWithMd",
			compact(params),
			{ retryable: false },
		);
	}

	/** `/api/block/insertBlock`. `dataType: "markdown"` is hardcoded; see appendBlock. */
	async insertBlock(params: {
		data: string;
		nextID?: string;
		previousID?: string;
		parentID?: string;
	}): Promise<BlockTransaction[]> {
		return this.request<BlockTransaction[]>(
			"/api/block/insertBlock",
			blockWriteBody(params),
			{ retryable: false },
		);
	}

	/**
	 * `/api/block/appendBlock`. `dataType: "markdown"` is hardcoded rather than
	 * exposed: a missing value panics into a silent `code: 0` / `data: null`
	 * no-op and a non-markdown value is inserted raw as DOM — keeping callers
	 * off both paths.
	 */
	async appendBlock(params: {
		data: string;
		parentID: string;
	}): Promise<BlockTransaction[]> {
		return this.request<BlockTransaction[]>(
			"/api/block/appendBlock",
			blockWriteBody(params),
			{ retryable: false },
		);
	}

	/** `/api/block/updateBlock`. `dataType: "markdown"` is hardcoded; see appendBlock. */
	async updateBlock(params: {
		id: string;
		data: string;
		lockType?: string;
	}): Promise<BlockTransaction[]> {
		return this.request<BlockTransaction[]>(
			"/api/block/updateBlock",
			blockWriteBody(params),
			{ retryable: false },
		);
	}

	/** `/api/block/deleteBlock`. */
	async deleteBlock(id: string): Promise<BlockTransaction[]> {
		return this.request<BlockTransaction[]>(
			"/api/block/deleteBlock",
			{ id },
			{ retryable: false },
		);
	}

	/** `/api/block/moveBlock` — the kernel never sets `ret.Data` here, so this returns `null`, unlike insert/append/update/delete. */
	async moveBlock(params: {
		id: string;
		previousID?: string;
		parentID?: string;
	}): Promise<null> {
		return this.request<null>("/api/block/moveBlock", compact(params), {
			retryable: false,
		});
	}

	/**
	 * `/api/filetree/renameDocByID` — the hpath's last segment becomes the new
	 * title; the physical `.sy` path and block id are unchanged, and the kernel
	 * pushes a `rename` broadcast event. Titles beyond 512 runes fail with
	 * `code: -1`; an empty title is silently substituted with the kernel's
	 * default "untitled" title.
	 *
	 * Failure paths: a malformed id fails with `code: -1` ("invalid ID
	 * argument"); a well-formed but unresolvable id — including a
	 * locked/encrypted box — fails with `code: -1` and a `closeTimeout` payload.
	 * Renaming a notebook's box/root doc renames the notebook itself, but only
	 * when the box-doc feature is enabled; without it the box-doc id is
	 * unresolvable and hits the same failure path as any unknown id.
	 */
	async renameDocByID(id: string, title: string): Promise<null> {
		return this.request<null>(
			"/api/filetree/renameDocByID",
			{ id, title },
			{ retryable: false },
		);
	}

	/** `/api/filetree/removeDocByID`. Takes the endpoint's real field `id`; tool-schema naming is the extension's job. */
	async removeDocByID(id: string): Promise<null> {
		return this.request<null>(
			"/api/filetree/removeDocByID",
			{ id },
			{ retryable: false },
		);
	}

	/** `/api/filetree/moveDocsByID`. */
	async moveDocsByID(params: {
		fromIDs: string[];
		toID: string;
	}): Promise<null> {
		return this.request<null>("/api/filetree/moveDocsByID", params, {
			retryable: false,
		});
	}

	/**
	 * POST one of the notebook-create routes and unwrap its single `notebook`
	 * row. A `code: 0` success envelope whose `data` carries no `notebook`
	 * field (missing or `null`) surfaces as `SiYuanApiError`, never a raw
	 * `TypeError`.
	 */
	private async createNotebookRow(
		path: string,
		body: Record<string, unknown>,
	): Promise<NotebookInfo> {
		const data = await this.request<{ notebook?: NotebookInfo }>(path, body, {
			retryable: false,
		});
		if (data?.notebook == null) {
			throw new SiYuanApiError(
				200,
				undefined,
				"envelope data carries no notebook row",
			);
		}
		return data.notebook;
	}

	/**
	 * Single transport path for every endpoint method. Classification runs on
	 * HTTP status first (401/403/429 also carry a `code: -1` envelope, so the
	 * envelope parse must not run before the status check), then on the envelope
	 * code. One retry, reads only, on network error / timeout / 5xx; never on
	 * 401/403/429. The timeout is per attempt.
	 */
	private async request<T>(
		path: string,
		body: unknown,
		opts: { retryable: boolean },
	): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const init: RequestInit = {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Token ${this.token}`,
			},
			body: JSON.stringify(body),
		};

		for (let attempt = 0; ; attempt++) {
			let res: Response;
			try {
				res = await this.doFetch(url, {
					...init,
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
			} catch (err) {
				if (opts.retryable && attempt === 0) {
					continue;
				}
				if (isTimeoutError(err)) {
					throw new SiYuanTimeoutError(TIMEOUT_MS);
				}
				throw new SiYuanNetworkError(
					err instanceof Error ? { cause: err } : undefined,
				);
			}

			// Unconsumed bodies pin the keep-alive connection; cancel before
			// abandoning the response on every early-exit path.
			if (res.status === 401 || res.status === 403) {
				cancelBody(res);
				throw new SiYuanAuthError(res.status);
			}
			if (res.status === 429) {
				cancelBody(res);
				throw new SiYuanRateLimitError(res.status, parseRetryAfter(res));
			}
			// 5xx gets the retry; other non-2xx (400/404/405) do not. A 5xx with an
			// unparseable body still surfaces as SiYuanApiError with the status.
			if (res.status >= 500 && opts.retryable && attempt === 0) {
				cancelBody(res);
				continue;
			}
			if (!res.ok) {
				cancelBody(res);
				throw new SiYuanApiError(res.status);
			}

			let parsed: unknown;
			try {
				parsed = await res.json();
			} catch (err) {
				// A stalled body trips the same timeout signal as the fetch itself.
				if (isTimeoutError(err)) {
					if (opts.retryable && attempt === 0) {
						cancelBody(res);
						continue;
					}
					throw new SiYuanTimeoutError(TIMEOUT_MS);
				}
				// Proxy corruption, HTML error page, … — keep the mapping total.
				throw new SiYuanApiError(res.status);
			}
			if (!isEnvelope(parsed)) {
				throw new SiYuanApiError(res.status);
			}
			if (parsed.code !== 0) {
				throw new SiYuanApiError(
					res.status,
					parsed.code,
					typeof parsed.msg === "string" ? parsed.msg : undefined,
				);
			}
			return parsed.data as T;
		}
	}
}

/** Request body with unset optional fields dropped. */
function compact(params: Record<string, unknown>): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			body[key] = value;
		}
	}
	return body;
}

/**
 * Body for the content-bearing block writes (insert/append/update): caller
 * fields pass through, `dataType` is always markdown.
 */
function blockWriteBody(
	params: Record<string, unknown>,
): Record<string, unknown> {
	return { ...compact(params), dataType: "markdown" };
}

/** Cancel an abandoned body so it cannot pin the keep-alive connection. */
function cancelBody(res: Response): void {
	res.body?.cancel().catch(() => {});
}

function parseRetryAfter(res: Response): number | undefined {
	const raw = res.headers.get("Retry-After");
	if (!raw) {
		return undefined;
	}
	const seconds = Number(raw);
	return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
}
