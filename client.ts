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
	ExportMarkdownResult,
	NotebookInfo,
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
 * Zero runtime dependencies, zero pi imports — native fetch only.
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

	/** `/api/notebook/lsNotebooks` — unwraps `data.notebooks`. */
	async listNotebooks(): Promise<NotebookInfo[]> {
		const data = await this.request<{
			notebooks: NotebookInfo[];
		}>("/api/notebook/lsNotebooks", {}, { retryable: true });
		return data.notebooks;
	}

	/** `/api/query/sql` — always sends `mode: "readonly"`; v1 cannot express a writable mode. */
	async query(
		stmt: string,
		mode: "readonly" = "readonly",
	): Promise<Record<string, unknown>[]> {
		return this.request<Record<string, unknown>[]>(
			"/api/query/sql",
			{ stmt, mode },
			{ retryable: true },
		);
	}

	/**
	 * `/api/search/fullTextSearchBlock`. Only `query`/`paths`/`pageSize` are
	 * exposed; `method: 0` is hardcoded and `types`/`orderBy`/`groupBy` are
	 * omitted entirely, so the SQL-smuggling bypass cannot be reintroduced by a
	 * caller.
	 */
	async search(params: {
		query: string;
		paths: string[];
		pageSize: number;
	}): Promise<SearchResult> {
		return this.request<SearchResult>(
			"/api/search/fullTextSearchBlock",
			{
				query: params.query,
				paths: params.paths,
				pageSize: params.pageSize,
				method: 0,
			},
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

	/** `/api/block/getChildBlocks`. */
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
		return this.request<null>(
			"/api/filetree/moveDocsByID",
			{ fromIDs: params.fromIDs, toID: params.toID },
			{ retryable: false },
		);
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

			if (res.status === 401 || res.status === 403) {
				throw new SiYuanAuthError(res.status);
			}
			if (res.status === 429) {
				throw new SiYuanRateLimitError(res.status, parseRetryAfter(res));
			}
			// 5xx gets the retry; other non-2xx (400/404/405) do not. A 5xx with an
			// unparseable body still surfaces as SiYuanApiError with the status.
			if (res.status >= 500 && opts.retryable && attempt === 0) {
				continue;
			}
			if (!isOk(res.status)) {
				throw new SiYuanApiError(res.status);
			}

			let parsed: unknown;
			try {
				parsed = await res.json();
			} catch {
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

function isOk(status: number): boolean {
	return status >= 200 && status < 300;
}

function parseRetryAfter(res: Response): number | undefined {
	const raw = res.headers.get("Retry-After");
	if (!raw) {
		return undefined;
	}
	const seconds = Number(raw);
	return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
}
