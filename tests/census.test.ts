import { describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "../client.js";

/**
 * The public client surface, pinned. Every public client method invocation
 * is authenticated kernel contact — downstream consumers rely on that. A
 * method may join this list only after its route's kernel-side auth posture is
 * verified: adding a method to the class without updating this list fails
 * the census, and the args table below forces the same conscious pass.
 */
const PINNED_PUBLIC_METHODS = [
	"appendBlock",
	"closeNotebook",
	"createDocWithMarkdown",
	"createEncryptedNotebook",
	"createNotebook",
	"deleteBlock",
	"exportMarkdown",
	"fullTextSearch",
	"getChildBlocks",
	"getEncryptedNotebookStatus",
	"getHPathByID",
	"getVersion",
	"insertBlock",
	"listInvalidBlockRefs",
	"listNotebooks",
	"moveBlock",
	"moveDocsByID",
	"openNotebook",
	"query",
	"removeDocByID",
	"removeNotebook",
	"renameDocByID",
	"renameNotebook",
	"transact",
	"unlockAndOpenNotebook",
	"updateBlock",
] as const;

/**
 * TS-`private` methods stay runtime-reachable on the prototype (TypeScript
 * privacy is compile-time only), so they are pinned separately: adding one
 * is a conscious edit too, though typed downstream code cannot invoke them.
 */
const PINNED_PRIVATE_METHODS = ["createNotebookRow", "request"] as const;

type PublicMethod = (typeof PINNED_PUBLIC_METHODS)[number];

/** Per-method call args, signature-checked; a missing entry is a compile error. */
const ARGS: { [M in PublicMethod]: Parameters<SiYuanKernelClient[M]> } = {
	appendBlock: [{ data: "x", parentID: "x" }],
	closeNotebook: ["x"],
	createDocWithMarkdown: [{ notebook: "x", path: "/x", markdown: "x" }],
	createEncryptedNotebook: ["x", "x"],
	createNotebook: ["x"],
	deleteBlock: ["x"],
	exportMarkdown: ["x"],
	fullTextSearch: [{ query: "x", paths: ["x"] }],
	getChildBlocks: ["x"],
	getEncryptedNotebookStatus: [],
	getHPathByID: ["x"],
	getVersion: [],
	insertBlock: [{ data: "x", parentID: "x" }],
	listInvalidBlockRefs: [{}],
	listNotebooks: [],
	moveBlock: [{ id: "x" }],
	moveDocsByID: [{ fromIDs: ["x"], toID: "x" }],
	openNotebook: ["x"],
	query: ["SELECT 1"],
	removeDocByID: ["x"],
	removeNotebook: ["x"],
	renameDocByID: ["x", "x"],
	renameNotebook: ["x", "x"],
	// The wire op shape, verbatim: a `delete` op carries only its id — the
	// kernel ignores delete anchors; `reqId` is client-generated, so it is
	// not a call arg.
	transact: [[{ doOperations: [{ action: "delete", id: "x" }] }]],
	unlockAndOpenNotebook: ["x", "x"],
	updateBlock: [{ id: "x", data: "x" }],
};

function prototypeMethodNames(): string[] {
	const proto = SiYuanKernelClient.prototype as unknown as Record<
		string,
		unknown
	>;
	return Object.getOwnPropertyNames(proto)
		.filter((k) => k !== "constructor" && typeof proto[k] === "function")
		.sort();
}

/** Drive one method against a stubbed fetch; post-response unwrap errors are fine — the transport was already observed. */
async function drive(method: string, args: unknown[]): Promise<RequestInit[]> {
	const inits: RequestInit[] = [];
	const fetchStub = (async (
		_url: string | URL,
		init?: RequestInit,
	): Promise<Response> => {
		inits.push(init ?? {});
		return {
			ok: true,
			status: 200,
			json: async () => ({ code: 0, data: {} }),
			headers: { get: () => null },
			body: null,
		} as unknown as Response;
	}) as typeof fetch;
	const client = new SiYuanKernelClient("http://kernel.test", "token", {
		fetch: fetchStub,
	});
	const fn = (
		client as unknown as Record<
			string,
			((...a: unknown[]) => Promise<unknown>) | undefined
		>
	)[method];
	if (!fn) {
		throw new Error(`no prototype method ${method}`);
	}
	try {
		await fn.apply(client, args);
	} catch {
		// Envelope-shape errors land here; fetch was still captured.
	}
	return inits;
}

describe("public client surface census", () => {
	it("partitions the prototype surface into the pinned public and private lists", () => {
		// The union equality also enforces disjointness: a duplicate entry
		// would double-count against the duplicate-free prototype scan.
		const actual = prototypeMethodNames();
		const pinned = [...PINNED_PUBLIC_METHODS, ...PINNED_PRIVATE_METHODS].sort();
		expect(actual).toEqual(pinned);
	});

	it("every pinned method reaches the kernel through the token-attaching request path", async () => {
		for (const method of PINNED_PUBLIC_METHODS) {
			const calls = await drive(method, ARGS[method]);
			expect(calls.length, `${method} never reached fetch`).toBeGreaterThan(0);
			for (const init of calls) {
				const auth = new Headers(init.headers).get("authorization");
				expect(auth, `${method} authorization header`).toBe("Token token");
			}
		}
	});
});
