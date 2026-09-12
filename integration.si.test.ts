/**
 * Live integration profile for the SiYuan kernel — opt-in, host-only, manual.
 *
 * Runs only when SIYUAN_BASE_URL + SIYUAN_API_TOKEN are set AND
 * SIYUAN_INTEGRATION=1; otherwise the suite self-skips so `vitest run` in CI
 * stays green without a kernel. The token is a host-side secret. The auth
 * throttle pin additionally needs SIYUAN_INTEGRATION_THROTTLE=1 — it locks
 * the host IP out for ~4 min, so it is opt-in even within an enabled suite.
 * Never wire this into CI and never run the suite twice in quick succession.
 *
 * Execution order is load-bearing and equals this file's declaration order:
 *
 *   1. search `paths`-shape pin      (first asserted case, after setup/seeding)
 *   2. auth smoke matrix
 *   3. verified-create contract pin
 *   4. auth-throttle contract pin    (last — arms the lockout)
 *
 * (M3 adds a raw-DELETE case after the throttle pin.) The suite opts out of
 * concurrency (`concurrent: false`, this vitest's explicit knob) — a concurrent
 * run would re-arm the throttle mid-suite.
 * S3-order numbering differs from declaration order deliberately: the auth
 * smoke matrix is kernel-dependent but touches no fixtures, so the search
 * shape runs first among asserted cases per §10's search-first rule.
 *
 * curl precursor (host-side, observed live @ 3.8.3):
 *   - correctly-shaped `paths: [<boxId>]` narrows results to the fixture box
 *     (1 row, box = fixture box)
 *   - a deliberately wrong `boxes` field is ignored: the query degrades to
 *     whole-workspace results (a unique marker outside the path filter was
 *     still returned with `boxes: [nonexistent-id]`)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "./client.js";
import { SiYuanAuthError, SiYuanRateLimitError } from "./errors.js";
import type { SearchResult } from "./types.js";

const BASE_URL = process.env.SIYUAN_BASE_URL ?? "";
const TOKEN = process.env.SIYUAN_API_TOKEN ?? "";
const ENABLED = process.env.SIYUAN_INTEGRATION === "1";
const CONFIGURED = BASE_URL !== "" && TOKEN !== "" && ENABLED;
/** Throttle pin locks the host IP out for ~4 min — opt-in within the suite. */
const THROTTLE_ENABLED = process.env.SIYUAN_INTEGRATION_THROTTLE === "1";

/** Test constant, not a client constant — the client ships no pinned version. */
const EXPECTED_VERSION = "3.8.3";

/**
 * Throttle lockout math (kernel @ 3.8.3): locked requests *overwrite* the
 * lock, `30 << (FailCount - 5)` — FailCount 8 after this suite's 8 requests
 * → 240 s. The passive wait must cover the last extension, not the sum.
 */
const THROTTLE_LOCK_MS = 240_000;
/** Lock is 240 s; margin must absorb clock/timing skew — 5 s raced it once. */
const SLEEP_MARGIN_MS = 15_000;
/** FTS/SQL index may lag raw writes; bounded wait before giving up. */
const INDEX_WAIT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `done` holds or the index-wait budget is spent. */
async function waitFor<T>(
	probe: () => Promise<T>,
	done: (value: T) => boolean,
): Promise<T> {
	const deadline = Date.now() + INDEX_WAIT_MS;
	let value = await probe();
	while (!done(value) && Date.now() <= deadline) {
		await sleep(1_000);
		value = await probe();
	}
	return value;
}

/** Raw documented-HTTP call, bypassing the client — fixture setup only. */
function rawPost(
	path: string,
	body: unknown,
	token = TOKEN,
): Promise<Response> {
	return fetch(`${BASE_URL}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token === "" ? {} : { Authorization: `Token ${token}` }),
		},
		body: JSON.stringify(body),
	});
}

async function envelopeData(res: Response): Promise<unknown> {
	const body = (await res.json()) as {
		code: number;
		data: unknown;
		msg?: string;
	};
	if (!res.ok || body.code !== 0) {
		throw new Error(
			`raw kernel call failed (HTTP ${res.status}, code ${body.code}): ${body.msg ?? ""}`,
		);
	}
	return body.data;
}

async function rawCreateNotebook(name: string): Promise<string> {
	const res = await rawPost("/api/notebook/createNotebook", { name });
	// Kernel wraps the new notebook: data = { notebook: { id, ... } }.
	const data = (await envelopeData(res)) as { notebook?: { id?: unknown } };
	const id = data.notebook?.id;
	if (typeof id !== "string" || id === "") {
		throw new Error(
			`createNotebook returned no notebook id: ${JSON.stringify(data)}`,
		);
	}
	return id;
}

async function rawCreateDoc(
	notebook: string,
	path: string,
	markdown: string,
): Promise<string> {
	const res = await rawPost("/api/filetree/createDocWithMd", {
		notebook,
		path,
		markdown,
	});
	const data = await envelopeData(res);
	if (typeof data !== "string" || data === "") {
		throw new Error(
			`createDocWithMd returned no doc id: ${JSON.stringify(data)}`,
		);
	}
	return data;
}

function countingFetch(counter: { count: number }): typeof fetch {
	const fn: typeof fetch = (input, init) => {
		counter.count++;
		return globalThis.fetch(input, init);
	};
	return fn;
}

describe.skipIf(!CONFIGURED)(
	"SiYuan kernel integration profile",
	// Sequential execution is load-bearing: a concurrent run would re-arm the
	// throttle mid-suite. Tests already run sequentially by default; stated
	// explicitly so a global `concurrent` flip cannot break the throttle pin.
	{ concurrent: false },
	() => {
		let client: SiYuanKernelClient;
		const ts = Date.now();
		const seedMarker = `pikb-seed-${ts}`;
		let fixtureABox = "";
		let fixtureBBox = "";
		let seedDocId = "";

		beforeAll(async () => {
			client = new SiYuanKernelClient(BASE_URL, TOKEN);

			// Residual-lock diagnostic: a 429 here means a previous run's
			// throttle lock is still held (the throttle pin's abort path) —
			// stop instead of running the kernel-dependent cases into the lock.
			// Must be a guarded endpoint: /api/system/version is
			// unauthenticated (observed live @ 3.8.3), so it never 429s and
			// never touches the throttle counter.
			try {
				await client.listNotebooks();
			} catch (err) {
				if (err instanceof SiYuanRateLimitError) {
					throw new Error(
						"Throttle lock still held from a previous run (self-heals in ≤15 min); rerun later.",
					);
				}
				throw err;
			}
			const version = await client.getVersion();
			expect(version).toBe(EXPECTED_VERSION);

			// Fixtures via documented endpoints, raw — not through the client.
			// Fixture-b satisfies the two-notebook policy for M3's multi-KB pins;
			// no M2 case asserts against it.
			fixtureABox = await rawCreateNotebook(`pi-kb-test-fixture-a-${ts}`);
			fixtureBBox = await rawCreateNotebook(`pi-kb-test-fixture-b-${ts}`);

			// Seed fixture-a raw (isolates setup from client bugs and keeps the
			// verified-create raw-call contrast clean); the unique marker makes
			// search narrowing deterministic with no cross-box term needed.
			seedDocId = await rawCreateDoc(
				fixtureABox,
				"/seed",
				`# seed\n\n${seedMarker}\n`,
			);
		});

		afterAll(async () => {
			for (const box of [fixtureABox, fixtureBBox]) {
				if (box === "") continue;
				try {
					await envelopeData(
						await rawPost("/api/notebook/removeNotebook", { notebook: box }),
					);
				} catch (err) {
					// Teardown 429s while a lock from an aborted run is held — the
					// fixture then leaks as a recoverable stray (manual cleanup).
					console.warn(`fixture teardown failed for ${box}:`, err);
				}
			}
		});

		it(
			"search: correctly-shaped paths narrows to the fixture box",
			// The index wait needs far more than vitest's 5 s default.
			{ timeout: 60_000 },
			async () => {
				// Bounded wait — the FTS index may lag the raw seed.
				const hasMarker = (r: SearchResult) =>
					r.blocks.some((block) => String(block.content).includes(seedMarker));
				const result = await waitFor(
					() =>
						client.search({
							query: seedMarker,
							paths: [fixtureABox],
							pageSize: 100,
						}),
					hasMarker,
				);

				// An empty result must not pass.
				expect(hasMarker(result)).toBe(true);
				// Every returned row is scoped to the fixture box. The wrong-`boxes`
				// degradation half is carried by the curl precursor observation in
				// the header comment, not asserted live (no stable cross-box term).
				for (const block of result.blocks) {
					expect(block.box).toBe(fixtureABox);
				}
			},
		);

		it("auth smoke matrix: no token / bogus token / real token", async () => {
			// No-token leg is a raw request — the client constructor throws
			// TypeError on an empty token. An empty token is rejected before
			// AuthThrottleFail, so this leg never touches the throttle counter.
			const noToken = await rawPost("/api/notebook/lsNotebooks", {}, "");
			expect(noToken.ok).toBe(false);

			// Bogus-token leg through the client; the counter proves exactly one
			// request per attempt (no retry on auth).
			const counter = { count: 0 };
			const bogus = new SiYuanKernelClient(BASE_URL, `bogus-${ts}`, {
				fetch: countingFetch(counter),
			});
			await expect(bogus.listNotebooks()).rejects.toBeInstanceOf(
				SiYuanAuthError,
			);
			expect(counter.count).toBe(1);

			const notebooks = await client.listNotebooks();
			expect(Array.isArray(notebooks)).toBe(true);
		});

		it(
			"verified-create: re-creating an existing path keeps both docs",
			// The blocks-table wait needs far more than vitest's 5 s default.
			{ timeout: 60_000 },
			async () => {
				// Raw second create on the same path — the single riskiest kernel
				// contract. The marker term must be retrievable from the new doc;
				// literal content equality is unimplementable (the kernel re-parses
				// markdown and mints block IDs).
				const secondMarker = `pikb-second-${ts}`;
				const secondDocId = await rawCreateDoc(
					fixtureABox,
					"/seed",
					`# seed two\n\n${secondMarker}\n`,
				);
				expect(secondDocId).toBeTruthy();

				// Box-scoped re-lookup: exactly two type='d' rows (the fixture
				// notebook carries no other docs at that path). Bounded wait — the
				// blocks table lags doc creation (~3 s on 3.8.3, observed live).
				const rows = await waitFor(
					() =>
						client.query(
							`SELECT id, root_id, content FROM blocks WHERE type='d' AND box='${fixtureABox}'`,
						),
					(queried) => queried.length >= 2,
				);
				expect(rows).toHaveLength(2);
				expect(rows.some((row) => row.id === secondDocId)).toBe(true);

				const newExport = await client.exportMarkdown(secondDocId);
				expect(newExport.content).toContain(secondMarker);
				const oldExport = await client.exportMarkdown(seedDocId);
				expect(oldExport.content).toContain(seedMarker);
				expect(oldExport.content).not.toContain(secondMarker);

				// One live block write through the client, pinning the
				// data[0].doOperations[0] transaction-array shape that the
				// extension's newBlockId extraction depends on.
				const appendMarker = `pikb-append-${ts}`;
				const transactions = await client.appendBlock({
					data: appendMarker,
					parentID: seedDocId,
				});
				expect(Array.isArray(transactions)).toBe(true);
				const opId = transactions[0]?.doOperations[0]?.id;
				expect(typeof opId).toBe("string");
				// Bounded wait — the blocks table lags the append (~3 s, observed).
				const appended = await waitFor(
					() => client.query(`SELECT id FROM blocks WHERE id='${opId}'`),
					(queried) => queried.length >= 1,
				);
				expect(appended).toHaveLength(1);
			},
		);

		it.skipIf(!THROTTLE_ENABLED)(
			"auth throttle: 429 after the 6th bogus failure, shared per-IP lock",
			{ timeout: 600_000 },
			async () => {
				// Known-good call guarantees a clean throttle counter (the smoke
				// matrix's bogus leg incremented it; successes reset it). Guarded
				// endpoint — getVersion is unauthenticated and touches nothing.
				await client.listNotebooks();

				const counter = { count: 0 };
				const bogus = new SiYuanKernelClient(BASE_URL, `bogus-throttle-${ts}`, {
					fetch: countingFetch(counter),
				});

				// 6 bogus failures; the 6th arms the lock and returns 401. All
				// throttle legs use a guarded endpoint — getVersion is
				// unauthenticated @ 3.8.3 and would succeed with a bogus token.
				for (let i = 0; i < 6; i++) {
					await expect(bogus.listNotebooks()).rejects.toBeInstanceOf(
						SiYuanAuthError,
					);
				}
				expect(counter.count).toBe(6);

				// 7th bogus call: the distinct 429. If 3.8.3 behaves differently,
				// record reality and correct §10 (the pass criterion is the
				// post-6th-failure 429, not the literal ordinal).
				const seventh = await bogus.listNotebooks().then(
					() => null,
					(err: unknown) => err,
				);
				expect(seventh).toBeInstanceOf(SiYuanRateLimitError);
				expect(
					(seventh as SiYuanRateLimitError).retryAfterSeconds,
				).toBeDefined();

				// 8th, correctly-authenticated call: 429 (shared per-IP lock) that
				// *extends* the lock — FailCount 8 → 240 s. Guarded endpoint, same
				// reason as the bogus legs.
				const eighth = await client.listNotebooks().then(
					() => null,
					(err: unknown) => err,
				);
				expect(eighth).toBeInstanceOf(SiYuanRateLimitError);
				const eighthRetryAfter =
					(eighth as SiYuanRateLimitError).retryAfterSeconds ?? 0;

				// Passive wait ≥ the served lock with ZERO kernel calls — any
				// request during the lock re-enters AuthThrottleFail and pushes
				// the lock out, so a poll loop cannot terminate. Trust the 8th
				// call's Retry-After over the computed 240 s: the served lock
				// drifted past the computed value in a live run (observed 226 s
				// remaining after a 255 s sleep).
				const waitMs =
					Math.max(THROTTLE_LOCK_MS, eighthRetryAfter * 1000) + SLEEP_MARGIN_MS;
				await sleep(waitMs);

				// Exactly one probe; it succeeds with no recovery step. Guarded
				// endpoint — an unauthenticated getVersion would succeed even
				// while the lock is held, proving nothing.
				await expect(client.listNotebooks()).resolves.toBeDefined();
			},
		);
	},
);
