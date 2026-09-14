import { afterEach, describe, expect, it, vi } from "vitest";
import { SiYuanKernelClient } from "./client.js";
import {
	SiYuanApiError,
	SiYuanAuthError,
	SiYuanKernelError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	SiYuanTimeoutError,
} from "./errors.js";

type FetchCall = { url: string; init: RequestInit };

function mockFetch(
	handler: (call: FetchCall, attempt: number) => Promise<Response> | Response,
) {
	const calls: FetchCall[] = [];
	const fn = vi.fn(
		async (
			url: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			const call: FetchCall = { url: String(url), init: init ?? {} };
			calls.push(call);
			return handler(call, calls.length - 1);
		},
	);
	return { fn, calls };
}

function client(fetchFn: typeof fetch): SiYuanKernelClient {
	return new SiYuanKernelClient("http://127.0.0.1:6806", "secret-token", {
		fetch: fetchFn,
	});
}

function jsonResponse(
	status: number,
	body: unknown,
	headers?: Record<string, string>,
): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

/** Access the private request core through getVersion's shape; endpoint methods ride the same path. */
function request(
	client_: SiYuanKernelClient,
	path: string,
	body: unknown,
	retryable: boolean,
) {
	return (
		client_ as unknown as {
			request<T>(
				path: string,
				body: unknown,
				opts: { retryable: boolean },
			): Promise<T>;
		}
	).request.bind(client_)<unknown>(path, body, { retryable });
}

const envelope = (data: unknown) => ({ code: 0, msg: "", data });

afterEach(() => {
	vi.restoreAllMocks();
});

describe("request core", () => {
	it("POSTs JSON with the auth header to the joined URL", async () => {
		const { fn, calls } = mockFetch(() => jsonResponse(200, envelope("ok")));
		const c = client(fn);
		await request(c, "/api/notebook/lsNotebooks", { a: 1 }, true);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(
			"http://127.0.0.1:6806/api/notebook/lsNotebooks",
		);
		expect(calls[0]!.init.method).toBe("POST");
		expect(calls[0]!.init.headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "Token secret-token",
		});
		expect(calls[0]!.init.body).toBe(JSON.stringify({ a: 1 }));
	});

	it("attaches a timeout signal to every request", async () => {
		const { fn, calls } = mockFetch(() => jsonResponse(200, envelope(null)));
		await request(client(fn), "/api/system/version", {}, false);
		const signal = calls[0]!.init.signal as AbortSignal;
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal.aborted).toBe(false);
	});

	it("unwraps the envelope data", async () => {
		const { fn } = mockFetch(() => jsonResponse(200, envelope("3.8.3")));
		await expect(request(client(fn), "/x", {}, true)).resolves.toBe("3.8.3");
	});
});

describe("getVersion", () => {
	it("calls /api/system/version and unwraps the raw version string", async () => {
		const { fn, calls } = mockFetch(() => jsonResponse(200, envelope("3.8.3")));
		await expect(client(fn).getVersion()).resolves.toBe("3.8.3");
		expect(calls[0]!.url).toBe("http://127.0.0.1:6806/api/system/version");
	});
});

describe("error mapping", () => {
	it("maps 401 to SiYuanAuthError, even inside a code -1 envelope", async () => {
		const { fn } = mockFetch(() =>
			jsonResponse(401, { code: -1, msg: "auth" }),
		);
		await expect(client(fn).getVersion()).rejects.toThrow(SiYuanAuthError);
	});

	it("maps 403 to SiYuanAuthError, including a bodyless response", async () => {
		const { fn } = mockFetch(() => new Response(null, { status: 403 }));
		await expect(client(fn).getVersion()).rejects.toThrow(SiYuanAuthError);
	});

	it("maps 429 to SiYuanRateLimitError with the parsed Retry-After", async () => {
		const { fn } = mockFetch(() =>
			jsonResponse(
				429,
				{ code: -1, msg: "throttled" },
				{ "Retry-After": "60" },
			),
		);
		const err = await client(fn)
			.getVersion()
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SiYuanRateLimitError);
		expect((err as SiYuanRateLimitError).retryAfterSeconds).toBe(60);
	});

	it("leaves retryAfterSeconds undefined when Retry-After is absent", async () => {
		const { fn } = mockFetch(() =>
			jsonResponse(429, { code: -1, msg: "throttled" }),
		);
		const err = await client(fn)
			.getVersion()
			.catch((e: unknown) => e);
		expect((err as SiYuanRateLimitError).retryAfterSeconds).toBeUndefined();
	});

	it("leaves retryAfterSeconds undefined when Retry-After is unparseable", async () => {
		const { fn } = mockFetch(() =>
			jsonResponse(
				429,
				{ code: -1, msg: "throttled" },
				{ "Retry-After": "later" },
			),
		);
		const err = await client(fn)
			.getVersion()
			.catch((e: unknown) => e);
		expect((err as SiYuanRateLimitError).retryAfterSeconds).toBeUndefined();
	});

	it("maps an envelope code != 0 on 200 to SiYuanApiError with code and msg", async () => {
		const { fn } = mockFetch(() =>
			jsonResponse(200, { code: -1, msg: "boom", data: null }),
		);
		const err = await client(fn)
			.getVersion()
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SiYuanApiError);
		expect((err as SiYuanApiError).status).toBe(200);
		expect((err as SiYuanApiError).code).toBe(-1);
		expect((err as SiYuanApiError).msg).toBe("boom");
	});

	it("maps other non-2xx (400) to SiYuanApiError carrying the HTTP status", async () => {
		const { fn } = mockFetch(() => jsonResponse(400, "nope"));
		const err = await client(fn)
			.getVersion()
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SiYuanApiError);
		expect((err as SiYuanApiError).status).toBe(400);
		expect((err as SiYuanApiError).code).toBeUndefined();
	});

	it("maps a 5xx with a garbage body to SiYuanApiError with the status and no envelope fields", async () => {
		const { fn } = mockFetch(
			() => new Response("<html>boom</html>", { status: 502 }),
		);
		const err = await client(fn)
			.getVersion()
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SiYuanApiError);
		expect((err as SiYuanApiError).status).toBe(502);
		expect((err as SiYuanApiError).code).toBeUndefined();
		expect((err as SiYuanApiError).msg).toBeUndefined();
	});

	it("maps a 2xx whose body is valid JSON but not an envelope to SiYuanApiError", async () => {
		const { fn } = mockFetch(() => jsonResponse(200, { foo: 1 }));
		const err = await client(fn)
			.getVersion()
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SiYuanApiError);
		expect((err as SiYuanApiError).status).toBe(200);
		expect((err as SiYuanApiError).code).toBeUndefined();
	});

	it("maps a non-string envelope msg to SiYuanApiError without the msg text", async () => {
		const { fn } = mockFetch(() =>
			jsonResponse(200, { code: -1, msg: 42, data: null }),
		);
		const err = await client(fn)
			.getVersion()
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SiYuanApiError);
		expect((err as SiYuanApiError).status).toBe(200);
		expect((err as SiYuanApiError).code).toBe(-1);
		expect((err as SiYuanApiError).msg).toBeUndefined();
	});

	it("maps a 2xx with a non-envelope body (HTML error page) to SiYuanApiError", async () => {
		const { fn } = mockFetch(
			() => new Response("<html>maintenance</html>", { status: 200 }),
		);
		const err = await client(fn)
			.getVersion()
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SiYuanApiError);
		expect((err as SiYuanApiError).status).toBe(200);
	});

	it("never throws the bare base class", async () => {
		const responses = [401, 403, 429, 400, 500].map(
			(status) => () => jsonResponse(status, { code: -1, msg: "x" }),
		);
		for (const handler of responses) {
			const { fn } = mockFetch(handler);
			const err = await client(fn)
				.getVersion()
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(SiYuanKernelError);
			expect((err as SiYuanKernelError).constructor).not.toBe(
				SiYuanKernelError,
			);
		}
	});
});

describe("retry policy", () => {
	it("retries a read on 5xx (exactly 2 fetch calls) and succeeds", async () => {
		const { fn } = mockFetch((_, attempt) =>
			attempt === 0
				? new Response("err", { status: 500 })
				: jsonResponse(200, envelope("ok")),
		);
		await expect(request(client(fn), "/read", {}, true)).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("retries a read on network failure (exactly 2 calls), then throws SiYuanNetworkError", async () => {
		const { fn } = mockFetch(() => {
			throw new Error("ECONNREFUSED");
		});
		const err = await request(client(fn), "/read", {}, true).catch(
			(e: unknown) => e,
		);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(err).toBeInstanceOf(SiYuanNetworkError);
		expect((err as SiYuanNetworkError).cause).toBeInstanceOf(Error);
	});

	it("retries a read on timeout (exactly 2 calls), then throws SiYuanTimeoutError", async () => {
		const { fn } = mockFetch(() => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		});
		const err = await request(client(fn), "/read", {}, true).catch(
			(e: unknown) => e,
		);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(err).toBeInstanceOf(SiYuanTimeoutError);
	});

	it("throws SiYuanApiError after both read attempts fail with 5xx", async () => {
		const { fn } = mockFetch(() => new Response("err", { status: 503 }));
		const err = await request(client(fn), "/read", {}, true).catch(
			(e: unknown) => e,
		);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(err).toBeInstanceOf(SiYuanApiError);
		expect((err as SiYuanApiError).status).toBe(503);
	});

	it("maps a non-Error fetch rejection to SiYuanNetworkError with no cause", async () => {
		const { fn } = mockFetch(() => {
			throw undefined;
		});
		const err = await request(client(fn), "/read", {}, false).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(SiYuanNetworkError);
		expect((err as SiYuanNetworkError).cause).toBeUndefined();
	});

	it("retries a read whose body stalls past the timeout, then throws SiYuanTimeoutError", async () => {
		const { fn } = mockFetch(() => {
			// Response whose json() fails with the timeout error — a stalled body
			// trips the same signal as the fetch itself in real transports.
			const res = new Response("{", { status: 200 });
			Object.defineProperty(res, "json", {
				value: () =>
					Promise.reject(
						new DOMException("The operation was aborted.", "TimeoutError"),
					),
			});
			return res;
		});
		const err = await request(client(fn), "/read", {}, true).catch(
			(e: unknown) => e,
		);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(err).toBeInstanceOf(SiYuanTimeoutError);
	});

	it("parses Retry-After: 0 as 0", async () => {
		const { fn } = mockFetch(() =>
			jsonResponse(429, { code: -1, msg: "throttled" }, { "Retry-After": "0" }),
		);
		const err = await client(fn)
			.getVersion()
			.catch((e: unknown) => e);
		expect((err as SiYuanRateLimitError).retryAfterSeconds).toBe(0);
	});

	it("never retries a write on 5xx (exactly 1 call), then throws SiYuanApiError", async () => {
		const { fn } = mockFetch(() => new Response("err", { status: 500 }));
		const err = await request(client(fn), "/write", {}, false).catch(
			(e: unknown) => e,
		);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(err).toBeInstanceOf(SiYuanApiError);
		expect((err as SiYuanApiError).status).toBe(500);
	});

	it("never retries a write on network failure (exactly 1 call), then throws SiYuanNetworkError", async () => {
		const { fn } = mockFetch(() => {
			throw new Error("ECONNREFUSED");
		});
		await expect(request(client(fn), "/write", {}, false)).rejects.toThrow(
			SiYuanNetworkError,
		);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it.each([401, 403, 429])(
		"never retries on %i (exactly 1 call)",
		async (status) => {
			for (const retryable of [true, false]) {
				const { fn } = mockFetch(() =>
					jsonResponse(status, { code: -1, msg: "x" }),
				);
				await expect(
					request(client(fn), "/x", {}, retryable),
				).rejects.toThrow();
				expect(fn).toHaveBeenCalledTimes(1);
			}
		},
	);
});

describe("endpoint surface", () => {
	const okBody = <T>(data: T) => jsonResponse(200, envelope(data));

	it("listNotebooks hits lsNotebooks and unwraps data.notebooks", async () => {
		// `boxDocEnabled` is an envelope-level field in the kernel; here it only
		// proves Record<string, unknown> pass-through on rows.
		const { fn, calls } = mockFetch(() =>
			okBody({ notebooks: [{ id: "b1", name: "NB", boxDocEnabled: true }] }),
		);
		const notebooks = await client(fn).listNotebooks();
		expect(calls[0]!.url).toBe(
			"http://127.0.0.1:6806/api/notebook/lsNotebooks",
		);
		expect(calls[0]!.init.body).toBe(JSON.stringify({}));
		expect(notebooks).toEqual([{ id: "b1", name: "NB", boxDocEnabled: true }]);
	});

	it("listNotebooks throws SiYuanApiError, not TypeError, when data carries no notebooks", async () => {
		// Source-unreachable code 0 / data null envelope: the guarded unwrap
		// must surface it as a typed error, never an unguarded property chain.
		const { fn } = mockFetch(() => okBody(null));
		const err = await client(fn)
			.listNotebooks()
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SiYuanApiError);
		expect((err as SiYuanApiError).status).toBe(200);
	});

	it("createNotebook posts { name } and unwraps data.notebook", async () => {
		const notebookRow = {
			id: "nb1",
			name: "NB",
			closed: false,
		};
		const { fn, calls } = mockFetch(() => okBody({ notebook: notebookRow }));
		const notebook = await client(fn).createNotebook("NB");
		expect(calls[0]!.url).toBe(
			"http://127.0.0.1:6806/api/notebook/createNotebook",
		);
		expect(calls[0]!.init.body).toBe(JSON.stringify({ name: "NB" }));
		expect(notebook).toEqual(notebookRow);
	});

	it("createNotebook throws SiYuanApiError, not TypeError, when data carries no notebook", async () => {
		// Source-unreachable code 0 / data null envelope: the guarded unwrap
		// must surface it as a typed error, never an unguarded property chain.
		const { fn } = mockFetch(() => okBody(null));
		const err = await client(fn)
			.createNotebook("NB")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SiYuanApiError);
		expect((err as SiYuanApiError).status).toBe(200);
	});

	it("createEncryptedNotebook posts { name, password } and unwraps data.notebook", async () => {
		const notebookRow = {
			id: "nb1",
			name: "NB",
			closed: false,
		};
		const { fn, calls } = mockFetch(() => okBody({ notebook: notebookRow }));
		const notebook = await client(fn).createEncryptedNotebook("NB", "pw");
		expect(calls[0]!.url).toBe(
			"http://127.0.0.1:6806/api/notebook/createEncryptedNotebook",
		);
		expect(calls[0]!.init.body).toBe(
			JSON.stringify({ name: "NB", password: "pw" }),
		);
		expect(notebook).toEqual(notebookRow);
	});

	it("createEncryptedNotebook throws SiYuanApiError, not TypeError, when data carries no notebook", async () => {
		// Source-unreachable code 0 / data null envelope: the guarded unwrap
		// must surface it as a typed error, never an unguarded property chain.
		const { fn } = mockFetch(() => okBody(null));
		const err = await client(fn)
			.createEncryptedNotebook("NB", "pw")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SiYuanApiError);
		expect((err as SiYuanApiError).status).toBe(200);
	});

	it("getEncryptedNotebookStatus posts an empty body and unwraps the typed status", async () => {
		const status = {
			enabled: false,
			state: "Disabled",
			count: 0,
			boxes: [{ id: "nb1", name: "", unlocked: false, state: "Locked" }],
			migrationPending: false,
			migrationBoxes: null,
			hasHistoryDependency: false,
		};
		const { fn, calls } = mockFetch(() => okBody(status));
		const res = await client(fn).getEncryptedNotebookStatus();
		expect(calls[0]!.url).toBe(
			"http://127.0.0.1:6806/api/notebook/getEncryptedNotebookStatus",
		);
		expect(calls[0]!.init.body).toBe(JSON.stringify({}));
		expect(res).toEqual(status);
		expect(res.boxes[0]!.state).toBe("Locked");
	});

	it.each([
		[
			(c: SiYuanKernelClient) => c.removeNotebook("nb1"),
			"/api/notebook/removeNotebook",
			{ notebook: "nb1" },
		],
		[
			(c: SiYuanKernelClient) => c.renameNotebook("nb1", "Renamed"),
			"/api/notebook/renameNotebook",
			{ notebook: "nb1", name: "Renamed" },
		],
		[
			(c: SiYuanKernelClient) => c.openNotebook("nb1"),
			"/api/notebook/openNotebook",
			{ notebook: "nb1" },
		],
		[
			(c: SiYuanKernelClient) => c.closeNotebook("nb1"),
			"/api/notebook/closeNotebook",
			{ notebook: "nb1" },
		],
		[
			(c: SiYuanKernelClient) => c.unlockAndOpenNotebook("nb1", "pw"),
			"/api/notebook/unlockAndOpenNotebook",
			{ notebook: "nb1", password: "pw" },
		],
	] as const)(
		"%s posts the endpoint's real fields and returns null",
		async (call, path, body) => {
			const { fn, calls } = mockFetch(() => okBody(null));
			await expect(call(client(fn))).resolves.toBeNull();
			expect(calls[0]!.url).toBe(`http://127.0.0.1:6806${path}`);
			expect(calls[0]!.init.body).toBe(JSON.stringify(body));
		},
	);

	it("query sends stmt and the readonly mode", async () => {
		const { fn, calls } = mockFetch(() => okBody([{ id: "r1" }]));
		const rows = await client(fn).query("SELECT 1");
		expect(calls[0]!.url).toBe("http://127.0.0.1:6806/api/query/sql");
		expect(calls[0]!.init.body).toBe(
			JSON.stringify({ stmt: "SELECT 1", mode: "readonly" }),
		);
		expect(rows).toEqual([{ id: "r1" }]);
	});

	it("search omits unset page/pageSize but keeps method: 0", async () => {
		const { fn, calls } = mockFetch(() =>
			okBody({
				blocks: [],
				matchedBlockCount: 0,
				matchedRootCount: 0,
				pageCount: 1,
			}),
		);
		const res = await client(fn).search({ query: "marker", paths: ["box1"] });
		expect(calls[0]!.url).toBe(
			"http://127.0.0.1:6806/api/search/fullTextSearchBlock",
		);
		const body = JSON.parse(calls[0]!.init.body as string) as Record<
			string,
			unknown
		>;
		expect(Object.keys(body).sort()).toEqual(["method", "paths", "query"]);
		expect(body).toEqual({ query: "marker", paths: ["box1"], method: 0 });
		expect(res.matchedBlockCount).toBe(0);
	});

	it.each([
		[{ page: 2, pageSize: 10 }],
		[{ page: 2 }],
		[{ pageSize: 10 }],
	] as const)(
		"search sends exactly the page/pageSize keys that are set: %o",
		async (pageParams) => {
			const { fn, calls } = mockFetch(() =>
				okBody({
					blocks: [],
					matchedBlockCount: 0,
					matchedRootCount: 0,
					pageCount: 1,
				}),
			);
			await client(fn).search({
				query: "marker",
				paths: ["box1"],
				...pageParams,
			});
			expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
				query: "marker",
				paths: ["box1"],
				...pageParams,
				method: 0,
			});
		},
	);

	it("listInvalidBlockRefs posts {} with no params and returns the page object", async () => {
		const page = {
			blocks: [{ id: "b1", content: "x", updated: "20240101120000" }],
			matchedBlockCount: 1,
			matchedRootCount: 1,
			pageCount: 1,
		};
		const { fn, calls } = mockFetch(() => okBody(page));
		await expect(client(fn).listInvalidBlockRefs()).resolves.toEqual(page);
		expect(calls[0]!.url).toBe(
			"http://127.0.0.1:6806/api/search/listInvalidBlockRefs",
		);
		expect(calls[0]!.init.body).toBe(JSON.stringify({}));
	});

	it("listInvalidBlockRefs passes page/pageSize through when set", async () => {
		const { fn, calls } = mockFetch(() => okBody(null));
		await client(fn).listInvalidBlockRefs({ page: 2, pageSize: 5 });
		expect(calls[0]!.init.body).toBe(JSON.stringify({ page: 2, pageSize: 5 }));
	});

	it("listInvalidBlockRefs resolves null for a page past the panic boundary", async () => {
		const { fn } = mockFetch(() => okBody(null));
		await expect(
			client(fn).listInvalidBlockRefs({ page: 9999 }),
		).resolves.toBeNull();
	});

	it("listInvalidBlockRefs unwraps the exact-multiple empty page object", async () => {
		const emptyPage = {
			blocks: [],
			matchedBlockCount: 0,
			matchedRootCount: 0,
			pageCount: 0,
		};
		const { fn } = mockFetch(() => okBody(emptyPage));
		await expect(
			client(fn).listInvalidBlockRefs({ page: 1, pageSize: 1 }),
		).resolves.toEqual(emptyPage);
	});

	it("exportMarkdown and getChildBlocks send { id }", async () => {
		for (const [call, path] of [
			[
				(c: SiYuanKernelClient) => c.exportMarkdown("d1"),
				"/api/export/exportMdContent",
			],
			[
				(c: SiYuanKernelClient) => c.getChildBlocks("d1"),
				"/api/block/getChildBlocks",
			],
		] as const) {
			const { fn, calls } = mockFetch(() => okBody([]));
			await call(client(fn));
			expect(calls[0]!.url).toBe(`http://127.0.0.1:6806${path}`);
			expect(calls[0]!.init.body).toBe(JSON.stringify({ id: "d1" }));
		}
	});

	it("createDocWithMarkdown passes parentID and tags through when set, omits them when not", async () => {
		const { fn, calls } = mockFetch(() => okBody("doc-id"));
		const id = await client(fn).createDocWithMarkdown({
			notebook: "b1",
			path: "/a/b",
			markdown: "# hi",
			parentID: "p1",
			tags: "t1,t2",
		});
		expect(id).toBe("doc-id");
		expect(calls[0]!.url).toBe(
			"http://127.0.0.1:6806/api/filetree/createDocWithMd",
		);
		expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
			notebook: "b1",
			path: "/a/b",
			markdown: "# hi",
			parentID: "p1",
			tags: "t1,t2",
		});

		const { fn: fn2, calls: calls2 } = mockFetch(() => okBody("doc-id"));
		await client(fn2).createDocWithMarkdown({
			notebook: "b1",
			path: "/a",
			markdown: "x",
		});
		expect(JSON.parse(calls2[0]!.init.body as string)).toEqual({
			notebook: "b1",
			path: "/a",
			markdown: "x",
		});
	});

	it.each([
		["insertBlock", { data: "x", parentID: "p1" }, "/api/block/insertBlock"],
		["appendBlock", { data: "x", parentID: "p1" }, "/api/block/appendBlock"],
		["updateBlock", { id: "blk", data: "y" }, "/api/block/updateBlock"],
		["moveBlock", { id: "blk", previousID: "p" }, "/api/block/moveBlock"],
	])(
		"%s omits unset optional fields, returns the payload the kernel sends",
		async (method, params, path) => {
			const tx = [{ doOperations: [{ id: "new-block" }], undoOperations: [] }];
			const { fn, calls } = mockFetch(() =>
				okBody(method === "moveBlock" ? null : tx),
			);
			const out = await (
				client(fn)[method as "insertBlock"] as (p: unknown) => Promise<unknown>
			)(params);
			expect(calls[0]!.url).toBe(`http://127.0.0.1:6806${path}`);
			expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
				...params,
				...((method === "moveBlock"
					? null
					: { dataType: "markdown" }) as Record<string, unknown>),
			});
			if (method === "moveBlock") {
				expect(out).toBeNull();
			} else {
				expect(out).toEqual(tx);
			}
		},
	);

	it("deleteBlock sends { id } and returns the transaction array", async () => {
		const tx = [{ doOperations: [{ id: "blk" }] }];
		const { fn, calls } = mockFetch(() => okBody(tx));
		await expect(client(fn).deleteBlock("blk")).resolves.toEqual(tx);
		expect(calls[0]!.url).toBe("http://127.0.0.1:6806/api/block/deleteBlock");
		expect(calls[0]!.init.body).toBe(JSON.stringify({ id: "blk" }));
	});

	it("renameDocByID sends { id, title } and returns null", async () => {
		const { fn, calls } = mockFetch(() => okBody(null));
		await expect(
			client(fn).renameDocByID("d1", "New Title"),
		).resolves.toBeNull();
		expect(calls[0]!.url).toBe(
			"http://127.0.0.1:6806/api/filetree/renameDocByID",
		);
		expect(calls[0]!.init.body).toBe(
			JSON.stringify({ id: "d1", title: "New Title" }),
		);
	});

	it("removeDocByID and moveDocsByID send the endpoint's real fields and return null", async () => {
		const { fn, calls } = mockFetch(() => okBody(null));
		await expect(client(fn).removeDocByID("d1")).resolves.toBeNull();
		expect(calls[0]!.url).toBe(
			"http://127.0.0.1:6806/api/filetree/removeDocByID",
		);
		expect(calls[0]!.init.body).toBe(JSON.stringify({ id: "d1" }));

		const { fn: fn2, calls: calls2 } = mockFetch(() => okBody(null));
		await expect(
			client(fn2).moveDocsByID({ fromIDs: ["a", "b"], toID: "nb1" }),
		).resolves.toBeNull();
		expect(calls2[0]!.url).toBe(
			"http://127.0.0.1:6806/api/filetree/moveDocsByID",
		);
		expect(calls2[0]!.init.body).toBe(
			JSON.stringify({ fromIDs: ["a", "b"], toID: "nb1" }),
		);
	});

	it("reads retry once on 5xx (2 calls); writes never retry (1 call)", async () => {
		for (const [call, expected] of [
			[(c: SiYuanKernelClient) => c.getVersion(), 2],
			[(c: SiYuanKernelClient) => c.query("SELECT id FROM blocks LIMIT 1"), 2],
			[(c: SiYuanKernelClient) => c.search({ query: "q", paths: ["nb1"] }), 2],
			[(c: SiYuanKernelClient) => c.listNotebooks(), 2],
			[(c: SiYuanKernelClient) => c.listInvalidBlockRefs(), 2],
			[(c: SiYuanKernelClient) => c.exportMarkdown("d1"), 2],
			[(c: SiYuanKernelClient) => c.getChildBlocks("b1"), 2],
			[(c: SiYuanKernelClient) => c.getEncryptedNotebookStatus(), 2],
			[(c: SiYuanKernelClient) => c.createNotebook("NB"), 1],
			[(c: SiYuanKernelClient) => c.createEncryptedNotebook("NB", "pw"), 1],
			[(c: SiYuanKernelClient) => c.unlockAndOpenNotebook("nb", "pw"), 1],
			[(c: SiYuanKernelClient) => c.renameNotebook("nb", "New"), 1],
			[(c: SiYuanKernelClient) => c.openNotebook("nb"), 1],
			[(c: SiYuanKernelClient) => c.closeNotebook("nb"), 1],
			[(c: SiYuanKernelClient) => c.renameDocByID("d", "t"), 1],
			[
				(c: SiYuanKernelClient) => c.insertBlock({ data: "x", parentID: "p" }),
				1,
			],
			[
				(c: SiYuanKernelClient) => c.appendBlock({ data: "x", parentID: "p" }),
				1,
			],
			[(c: SiYuanKernelClient) => c.updateBlock({ id: "b1", data: "x" }), 1],
			[(c: SiYuanKernelClient) => c.deleteBlock("b1"), 1],
			[(c: SiYuanKernelClient) => c.moveBlock({ id: "b1", parentID: "p" }), 1],
			[
				(c: SiYuanKernelClient) =>
					c.createDocWithMarkdown({ notebook: "b", path: "/", markdown: "m" }),
				1,
			],
			[(c: SiYuanKernelClient) => c.removeDocByID("d"), 1],
			[(c: SiYuanKernelClient) => c.removeNotebook("nb"), 1],
			[
				(c: SiYuanKernelClient) =>
					c.moveDocsByID({ fromIDs: ["a"], toID: "nb1" }),
				1,
			],
		] as const) {
			const { fn } = mockFetch(() => new Response("err", { status: 500 }));
			await expect(call(client(fn))).rejects.toThrow(SiYuanApiError);
			expect(fn).toHaveBeenCalledTimes(expected);
		}
	});
});
