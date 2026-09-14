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
 *   4. notebook-lifecycle round-trip pin (client-driven, self-cleaning)
 *   5. renameDocByID hPath pin + box-doc failure-path pin (guarded on the
 *      live `boxDocEnabled` flag — with the flag on the same call renames
 *      the notebook, a destructive side effect, so the pin is skipped)
 *   6. listInvalidBlockRefs round-trip pin (planted orphan, self-cleaning)
 *   7. encrypted-notebook stage-A pins (fixture-free, stateless: typed
 *      status shape, 310 precondition rejection guarded on the live
 *      encryption state, 319 rejection for a well-formed unknown id)
 *   8. encrypted-notebook stage-B round-trip (self-cleaning; needs
 *      SIYUAN_MASTER_PASSWORD and an encryption-enabled workspace —
 *      otherwise it self-skips)
 *   9. auth-throttle contract pin    (last — arms the lockout)
 *
 * The suite opts out of concurrency (`concurrent: false`, this vitest's
 * explicit knob) — a concurrent run would re-arm the throttle mid-suite.
 * The auth smoke matrix is kernel-dependent but touches no fixtures, so the
 * search shape pin runs first among asserted cases.
 * Future fixtures and cases go above the throttle pin only when they must run
 * before the lockout arms; everything after it runs under the armed lock.
 *
 * curl precursor (host-side, observed live @ 3.8.3):
 *   - correctly-shaped `paths: [<boxId>]` narrows results to the fixture box
 *     (1 row, box = fixture box)
 *   - a deliberately wrong `boxes` field is ignored: the query degrades to
 *     whole-workspace results (a unique marker outside the path filter was
 *     still returned with `boxes: [nonexistent-id]`)
 *   - getEncryptedNotebookStatus on the encryption-off workspace returns
 *     every envelope field: enabled:false / state:"Disabled" / count:0 /
 *     boxes:[] / migrationPending:false / migrationBoxes:null (null, not
 *     [], when empty) / hasHistoryDependency:false
 *   - createEncryptedNotebook {name, password} on the encryption-off
 *     workspace answers code:-1 "Encrypted notebook feature is not
 *     enabled" (Language(310)) without touching any state
 *   - unlockAndOpenNotebook with a well-formed unknown id
 *     (20240101000000-zzzzzzz) answers code:-1 "Notebook is not encrypted"
 *     (Language(319)) with lsNotebooks byte-identical before/after
 *   - on the encryption-enabled workspace, the stage-B round-trip ran live:
 *     createEncryptedNotebook returns the notebook mounted and unlocked,
 *     closeNotebook locks it, a wrong password against the locked box
 *     answers code:-1 "Incorrect master password" (Language(311)) and the
 *     correct password unlocks it, a plain notebook answers code:-1
 *     "Notebook is not encrypted" (Language(319)), and removeNotebook
 *     deletes the encrypted box in the unlocked state (observed through
 *     the suite, not raw curl)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "./client.js";
import {
	SiYuanApiError,
	SiYuanAuthError,
	SiYuanRateLimitError,
} from "./errors.js";
import type { SearchResult } from "./types.js";

const BASE_URL = process.env.SIYUAN_BASE_URL ?? "";
const TOKEN = process.env.SIYUAN_API_TOKEN ?? "";
const ENABLED = process.env.SIYUAN_INTEGRATION === "1";
const CONFIGURED = BASE_URL !== "" && TOKEN !== "" && ENABLED;
/** Throttle pin locks the host IP out for ~4 min — opt-in within the suite. */
const THROTTLE_ENABLED = process.env.SIYUAN_INTEGRATION_THROTTLE === "1";
/**
 * Stage B round-trip unlocks and locks real encrypted boxes — the master
 * password is a host-side secret, so the pin is opt-in like the throttle.
 */
const MASTER_PASSWORD = process.env.SIYUAN_MASTER_PASSWORD ?? "";
const STAGE_B_ENABLED = ENABLED && MASTER_PASSWORD !== "";

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
		// Created and removed by the lifecycle case itself; still listed in
		// teardown so a mid-case failure leaks only as a recoverable stray.
		let lifecycleBox = "";
		// Same for the stage-B encrypted fixture. A mid-case failure after the
		// create leaves it in whatever lock state the case had reached.
		let encryptedBox = "";

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
			// Fixture-b satisfies the two-notebook policy (search pinning needs a
			// second box to prove path narrowing); no case asserts against it.
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
			for (const box of [
				fixtureABox,
				fixtureBBox,
				lifecycleBox,
				encryptedBox,
			]) {
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

		it("notebook lifecycle: create/rename/close/open/remove round-trip", async () => {
			// Delta counts only — the shared kernel carries other notebooks.
			const notebookCount = async () => (await client.listNotebooks()).length;
			const baseline = await notebookCount();

			// Create through the client, pinning the data.notebook unwrap —
			// the method must return the full notebook row, not just the id.
			const name = `pi-kb-lifecycle-${ts}`;
			const created = await client.createNotebook(name);
			expect(created.id).toBeTruthy();
			expect(created.name).toBe(name);
			lifecycleBox = created.id;

			// Rename visible via lsNotebooks.
			const renamed = `pi-kb-lifecycle-renamed-${ts}`;
			await expect(
				client.renameNotebook(created.id, renamed),
			).resolves.toBeNull();
			let rows = await client.listNotebooks();
			expect(rows.find((nb) => nb.id === created.id)?.name).toBe(renamed);

			// Close → open round-trip — the suite's only live assertion of
			// the `closed` field. Both transitions are synchronous.
			await expect(client.closeNotebook(created.id)).resolves.toBeNull();
			rows = await client.listNotebooks();
			expect(rows.find((nb) => nb.id === created.id)?.closed).toBe(true);
			await expect(client.openNotebook(created.id)).resolves.toBeNull();
			rows = await client.listNotebooks();
			expect(rows.find((nb) => nb.id === created.id)?.closed).toBe(false);

			// Remove drops the notebook: n → n+1 (create) → n.
			await expect(client.removeNotebook(created.id)).resolves.toBeNull();
			expect(await notebookCount()).toBe(baseline);
			lifecycleBox = "";
		});

		it(
			"renameDocByID: hPath's last segment follows the title; box-doc pin guarded on the live flag",
			{ timeout: 60_000 },
			async () => {
				const renamed = `pikb-renamed-${ts}`;
				await expect(
					client.renameDocByID(seedDocId, renamed),
				).resolves.toBeNull();
				const exported = await client.exportMarkdown(seedDocId);
				expect(exported.hPath).toBe(`/${renamed}`);

				// Box-doc delegation is feature-gated: read the envelope-level
				// `boxDocEnabled` flag raw (lsNotebooks envelope field — the typed
				// listNotebooks discards it). With the flag off (the expected live
				// state) the box-doc id is unresolvable and hits failure path 2;
				// with it on, the same call would succeed and RENAME the notebook —
				// a destructive side effect — so the pin is skipped instead.
				const lsData = (await envelopeData(
					await rawPost("/api/notebook/lsNotebooks", {}),
				)) as { boxDocEnabled?: unknown };
				if (lsData.boxDocEnabled === true) {
					console.warn("box-doc enabled — skipping failure-path-2 pin");
					return;
				}
				// Single live call: capture the rejection once, assert the typed
				// error and its envelope code. (The kernel's `closeTimeout: 7000`
				// payload rides in the envelope `data`, which SiYuanApiError does
				// not surface — code/msg is all the client exposes.)
				const failure = await client.renameDocByID(fixtureABox, renamed).then(
					() => null,
					(err: unknown) => err,
				);
				expect(failure).toBeInstanceOf(SiYuanApiError);
				expect((failure as SiYuanApiError).code).toBe(-1);
			},
		);

		it(
			"listInvalidBlockRefs: planted orphan appears then clears; out-of-range page is null",
			{ timeout: 120_000 },
			async () => {
				// Plant: a paragraph block, a doc referencing it, then delete the
				// target — orphaning the ref. Fixture creation stays raw.
				const targetMarker = `pikb-orphan-target-${ts}`;
				const targetDocId = await rawCreateDoc(
					fixtureABox,
					"/orphan-target",
					`# target\n\n${targetMarker}\n`,
				);
				const targetRows = await waitFor(
					() =>
						client.query(
							`SELECT id FROM blocks WHERE box='${fixtureABox}' AND type='p' AND content='${targetMarker}'`,
						),
					(queried) => queried.length >= 1,
				);
				const targetBlockId = targetRows[0]?.id;
				expect(typeof targetBlockId).toBe("string");

				const holderMarker = `pikb-orphan-holder-${ts}`;
				const holderDocId = await rawCreateDoc(
					fixtureABox,
					"/orphan-holder",
					`${holderMarker}\n\n((${targetBlockId} "${holderMarker} ref"))\n`,
				);
				await client.deleteBlock(String(targetBlockId));

				// The endpoint scans every notebook — assert contains, not counts.
				const mentionsHolder = (r: SearchResult | null) =>
					r !== null && r.blocks.some((b) => b.content.includes(holderMarker));
				const page = await waitFor(
					() => client.listInvalidBlockRefs(),
					mentionsHolder,
				);
				expect(mentionsHolder(page)).toBe(true);
				const row = page!.blocks.find((b) => b.content.includes(holderMarker));
				expect(typeof row?.content).toBe("string");
				expect(typeof row?.updated).toBe("string");

				// Page far beyond pageCount (never pageCount + 1 — an exact
				// multiple would return an empty page object, not null).
				await expect(
					client.listInvalidBlockRefs({ page: 9999 }),
				).resolves.toBeNull();

				// Clear: removing the referencing doc removes the refs entirely;
				// the planted marker must drop off the list.
				await client.removeDocByID(holderDocId);
				await client.removeDocByID(targetDocId);
				const cleared = await waitFor(
					() => client.listInvalidBlockRefs(),
					(r) => !mentionsHolder(r),
				);
				expect(mentionsHolder(cleared)).toBe(false);
			},
		);

		it("encrypted status: typed envelope shape (fixture-free, stateless)", async () => {
			// Shape only — never the workspace's actual values beyond the
			// guard reads — so the pin survives encryption being enabled
			// later. The per-box loop only executes when the workspace
			// already carries encrypted boxes; on a boxless one the row
			// shape is pinned by the stage-B round-trip instead. The kernel
			// provably always sets every field, but the passthrough fields
			// (migrationPending/migrationBoxes/
			// hasHistoryDependency) are deliberately not asserted here.
			const status = await client.getEncryptedNotebookStatus();
			expect(typeof status.enabled).toBe("boolean");
			expect(["Disabled", "Enabled", "RecoveryRequired"]).toContain(
				status.state,
			);
			expect(typeof status.count).toBe("number");
			expect(Array.isArray(status.boxes)).toBe(true);
			for (const row of status.boxes) {
				expect(typeof row.id).toBe("string");
				expect(typeof row.name).toBe("string");
				expect(typeof row.unlocked).toBe("boolean");
				expect([
					"Locked",
					"Unlocking",
					"Unlocked",
					"Locking",
					"Error",
				]).toContain(row.state);
			}
		});

		it("createEncryptedNotebook: precondition rejection on an encryption-off workspace", async (ctx) => {
			// Guard stays typed: the live workspace state is read through
			// getEncryptedNotebookStatus, not a raw envelope beside it.
			const status = await client.getEncryptedNotebookStatus();
			if (status.enabled) {
				// On an enabled workspace the same call would create a real
				// notebook; the client-side behavior (body shape, code:-1
				// surfacing as SiYuanApiError) is pinned by unit tests, so
				// 310 is kernel deployment state, not client logic.
				ctx.skip();
				return;
			}
			const failure = await client
				.createEncryptedNotebook(`pi-kb-enc-${ts}`, "x")
				.then(
					() => null,
					(err: unknown) => err,
				);
			expect(failure).toBeInstanceOf(SiYuanApiError);
			expect((failure as SiYuanApiError).code).toBe(-1);
		});

		it("unlockAndOpenNotebook: well-formed unknown id rejects before any state change", async () => {
			// The id matches the kernel's node-ID pattern (14 digits + 7
			// lowercase alphanumerics) but exists nowhere: Language(319)
			// fires before any crypto or state change — lsNotebooks is
			// byte-identical before/after (observed live @ 3.8.3). A
			// malformed id would fail earlier with "invalid ID argument"
			// instead, and a real encrypted-box id would fail later with
			// 311/316 — both are different pins.
			const failure = await client
				.unlockAndOpenNotebook("20240101000000-zzzzzzz", "x")
				.then(
					() => null,
					(err: unknown) => err,
				);
			expect(failure).toBeInstanceOf(SiYuanApiError);
			expect((failure as SiYuanApiError).code).toBe(-1);
		});

		it.skipIf(!STAGE_B_ENABLED)(
			"encrypted lifecycle: create/close/unlock round-trip (self-cleaning)",
			// Argon2id KEK derivation costs ~1 s per unlock call.
			{ timeout: 60_000 },
			async (ctx) => {
				// Stage B needs an encryption-enabled workspace — the master
				// password alone is not enough; enabling is a host deployment
				// action. On an off workspace the round-trip would only hit the
				// 310 rejection already pinned in stage A, so skip.
				const status = await client.getEncryptedNotebookStatus();
				if (!status.enabled) {
					console.warn(
						"workspace encryption disabled — skipping stage-B round-trip",
					);
					ctx.skip();
					return;
				}

				// Delta counts only — the shared kernel carries other notebooks.
				const notebookCount = async () => (await client.listNotebooks()).length;
				const baseline = await notebookCount();

				// Create → mounted and unlocked.
				const name = `pi-kb-enc-${ts}`;
				const created = await client.createEncryptedNotebook(
					name,
					MASTER_PASSWORD,
				);
				expect(created.id).toBeTruthy();
				expect(created.name).toBe(name);
				encryptedBox = created.id;

				// closeNotebook on an encrypted box locks it — the same locked
				// state the kernel's lock-notebook route reaches.
				await expect(client.closeNotebook(created.id)).resolves.toBeNull();

				// Locked box, status row: locked, name empty — the kernel fills
				// the row's name from opened boxes only.
				const lockedStatus = await client.getEncryptedNotebookStatus();
				const lockedRow = lockedStatus.boxes.find((b) => b.id === created.id);
				expect(lockedRow?.unlocked).toBe(false);
				expect(lockedRow?.state).toBe("Locked");
				expect(lockedRow?.name).toBe("");

				// Wrong password on a LOCKED box is rejected (code-only — never
				// the localized msg). Only meaningful locked: an already-unlocked
				// box never re-verifies the password.
				const wrong = await client
					.unlockAndOpenNotebook(created.id, `wrong-${ts}`)
					.then(
						() => null,
						(err: unknown) => err,
					);
				expect(wrong).toBeInstanceOf(SiYuanApiError);
				expect((wrong as SiYuanApiError).code).toBe(-1);

				// Correct password unlocks and mounts the box again; the status
				// row now reports unlocked with the box's name filled in.
				await expect(
					client.unlockAndOpenNotebook(created.id, MASTER_PASSWORD),
				).resolves.toBeNull();
				const unlockedStatus = await client.getEncryptedNotebookStatus();
				const unlockedRow = unlockedStatus.boxes.find(
					(b) => b.id === created.id,
				);
				expect(unlockedRow?.unlocked).toBe(true);
				expect(unlockedRow?.state).toBe("Unlocked");
				expect(unlockedRow?.name).toBe(name);

				// While an encrypted box exists: the plain-notebook rejection.
				// fixtureABox is a real plain notebook, live at this point in the
				// ordered suite.
				const plain = await client
					.unlockAndOpenNotebook(fixtureABox, MASTER_PASSWORD)
					.then(
						() => null,
						(err: unknown) => err,
					);
				expect(plain).toBeInstanceOf(SiYuanApiError);
				expect((plain as SiYuanApiError).code).toBe(-1);

				// Teardown through the shipped method: removeNotebook works on
				// encrypted boxes in either lock state.
				await expect(client.removeNotebook(created.id)).resolves.toBeNull();
				expect(await notebookCount()).toBe(baseline);
				encryptedBox = "";
				// The unlock did not disturb the plain fixture: still open.
				const rows = await client.listNotebooks();
				expect(rows.find((nb) => nb.id === fixtureABox)?.closed).toBe(false);
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
				// record reality — the pass criterion is the post-6th-failure 429,
				// not the literal ordinal.
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
