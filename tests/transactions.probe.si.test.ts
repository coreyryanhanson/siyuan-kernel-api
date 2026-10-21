/**
 * Live probe suite for `/api/transactions` — opt-in, host-only, manual.
 *
 * Runs only when SIYUAN_BASE_URL + SIYUAN_API_TOKEN are set AND
 * SIYUAN_INTEGRATION_PROBE=1; otherwise it self-skips so `vitest run` stays
 * green without a kernel. The dedicated flag keeps this suite out of a
 * plain SIYUAN_INTEGRATION=1 run — vitest executes files in parallel, and
 * this suite's queue measurements must not race `integration.si.test.ts`'s
 * kernel writes. Never wire this into CI: it mutates the live kernel.
 *
 * Run this file ALONE (`npx vitest run tests/transactions.probe.si.test.ts`) —
 * the commit-wait case measures the transaction queue and must not race
 * other suites' kernel writes. It does not arm the kernel's per-IP
 * throttle (no 429 is provoked), but it shares the lockout with any other
 * suite that does: a 429 in beforeAll means a lock is still held — stop.
 *
 * Expect an "Abnormal State" dialog in any open SiYuan GUI during the run:
 * the stale-id bulk-path cases make the kernel panic and recover inside a
 * transaction (recover → rollback → `txerr` push), and the frontend pops
 * the dialog on every `txerr`. The rollback is the pinned behavior — the
 * dialog is not evidence of data damage — but let the run finish, then
 * choose "Rebuild index" (harmless, and clears the deliberate index
 * residue the rollback cases leave behind).
 *
 * Every batch goes through the client's `transact()` method, every read
 * through the client. Three probe instruments are raw HTTP
 * because their routes are deliberately absent from the client surface:
 * `getBlockKramdown` (the non-healing by-id detector), `getBlockInfo`
 * (the kernel's one reindexing heal route), and `undoState`. No
 * `flushTransaction` drain is issued anywhere — every assertion reads
 * directly after the ack, which is itself part of what is pinned.
 *
 * Cases run in declaration order; each `it()` documents the behavior it
 * pins.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "../client.js";
import { SiYuanRateLimitError } from "../errors.js";
import {
	BASE_URL,
	EXPECTED_VERSION,
	TOKEN,
	rawPost,
	sleep,
	waitFor,
} from "./support.js";

const ENABLED = process.env.SIYUAN_INTEGRATION_PROBE === "1";
const CONFIGURED = BASE_URL !== "" && TOKEN !== "" && ENABLED;

/**
 * Parsed envelope of a raw instrument call. Unlike the integration suite's
 * fixture unwraps it does NOT throw on `code: -1`: several legs assert the
 * failure envelope itself.
 */
async function rawEnvelope(
	path: string,
	body: unknown,
): Promise<{ code: number; data: unknown; msg?: string }> {
	const res = await rawPost(path, body);
	return (await res.json()) as { code: number; data: unknown; msg?: string };
}

/** Notebook name prefix for the stray pre-clean and this run's box name. */
const BOX_PREFIX = "tx-probe-";

describe.skipIf(!CONFIGURED)(
	"`/api/transactions` live probe suite",
	// Sequential execution is load-bearing: each case's doc state and the
	// transaction-queue measurements assume no concurrent kernel writes.
	{ concurrent: false },
	() => {
		let client: SiYuanKernelClient;
		const ts = Date.now();
		let box = "";

		// --- op builders ---------------------------------------------------
		/** A `delete` op carries only its id. */
		const del = (id: string) => ({ action: "delete", id });
		/**
		 * A self-anchored move (`previousID` = the moved id itself) is a
		 * skip-class rejection: it aborts and rolls back the whole batch
		 * while the HTTP ack reads success.
		 */
		const skipMove = (id: string) => ({ action: "move", id, previousID: id });
		/** A real move: place `id` directly after `previousID`. */
		const moveAfter = (id: string, previousID: string) => ({
			action: "move",
			id,
			previousID,
		});

		// --- doc helpers ---------------------------------------------------
		/** Paragraph token: the paragraph's whole content is the token. */
		const token = (tag: string, i: number) =>
			`txprobe-${tag}-${String(i).padStart(2, "0")}`;

		/**
		 * Create an n-paragraph doc (content of paragraph i is exactly
		 * `token(tag, i)`) and return the content→id map read off the
		 * doc-root walk.
		 *
		 * Doc indexing runs asynchronously after creation, and the batched
		 * delete resolves ids through the blocktrees index — batching before
		 * the index catches up would measure the not-found no-op arm, not the
		 * behavior under test. So the fixture polls the by-id detector until
		 * every paragraph resolves — the same resolution path the deletes
		 * use. Fixture-setup wait only: the suite itself still issues no
		 * drain.
		 */
		async function paraDoc(
			tag: string,
			n: number,
		): Promise<{ docId: string; ids: Map<string, string> }> {
			const docId = await client.createDocWithMarkdown({
				notebook: box,
				path: `/${tag}`,
				markdown: Array.from({ length: n }, (_, i) => token(tag, i)).join(
					"\n\n",
				),
			});
			const walk = await client.getChildBlocks(docId);
			const ids = new Map<string, string>();
			for (const child of walk) {
				const content = String(child.content ?? "").trim();
				if (content.startsWith("txprobe-")) {
					ids.set(content, child.id as string);
				}
			}
			expect(ids.size).toBe(n);
			await waitFor(
				() => Promise.all([...ids.values()].map((id) => kramdown(id))),
				(codes) => codes.every((c) => c === 0),
			);
			return { docId, ids };
		}

		/** Map lookup that fails loudly instead of feeding `undefined` onward. */
		function pick(ids: Map<string, string>, key: string): string {
			const id = ids.get(key);
			if (id === undefined) {
				throw new Error(`fixture block missing for token ${key}`);
			}
			return id;
		}

		/** Doc-root walk as a plain id list, in document order — paragraph
		 * rows only: a fully-deleted doc keeps a content-less IAL row in
		 * the walk, which would otherwise read as a survivor. */
		const childIds = async (docId: string) =>
			(await client.getChildBlocks(docId))
				.filter((b) => b.type === "p")
				.map((b) => b.id as string);

		// --- probe instruments (raw; routes off the client surface) ---------
		/**
		 * The non-healing by-id detector: `getBlockKramdown` resolves the id
		 * through the blocktrees index without reindexing, so a damaged id
		 * answers `code: -1` while SQL and the doc-root walk read healthy.
		 * An empty `mode` string fails every id — send no `mode` field.
		 */
		async function kramdown(id: string): Promise<number> {
			return (await rawEnvelope("/api/block/getBlockKramdown", { id })).code;
		}

		/**
		 * The kernel's one reindexing heal route; it is blind to
		 * interior-row damage (the damage round-trip case pins that).
		 */
		async function blockInfo(id: string): Promise<number> {
			return (await rawEnvelope("/api/block/getBlockInfo", { id })).code;
		}

		/** Editor-scoped undo log state; dead as an evidence channel. */
		async function undoState(rootID: string): Promise<boolean> {
			const res = await rawEnvelope("/api/transactions/undoState", { rootID });
			expect(res.code).toBe(0);
			return (res.data as { canUndo?: boolean } | null)?.canUndo === true;
		}

		beforeAll(async () => {
			client = new SiYuanKernelClient(BASE_URL, TOKEN);

			// Residual-lock diagnostic: a 429 here means a previous run's
			// throttle lock is still held — stop instead of running into it.
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
			expect(await client.getVersion()).toBe(EXPECTED_VERSION);

			// Pre-clean stray probe notebooks from earlier failed runs.
			const boxes = (await client.listNotebooks()).notebooks;
			for (const stray of boxes.filter((b) => b.name.startsWith(BOX_PREFIX))) {
				await client.removeNotebook(stray.id);
			}

			box = (await client.createNotebook(`${BOX_PREFIX}${ts}`)).id;
		});

		afterAll(async () => {
			if (box === "") return;
			try {
				await client.removeNotebook(box);
				const after = (await client.listNotebooks()).notebooks;
				expect(after.some((b) => b.id === box)).toBe(false);
			} catch (err) {
				console.warn(`fixture teardown failed for ${box}:`, err);
			}
		});

		it(
			"skip-class op mid-batch: the whole batch rolls back behind a success ack",
			{ timeout: 30_000 },
			async () => {
				const { docId, ids } = await paraDoc("rollback", 3);
				const b1 = pick(ids, token("rollback", 0));
				const b3 = pick(ids, token("rollback", 2));

				// Resolving without throwing IS the success-ack observation:
				// any `code: -1` envelope surfaces as an error from transact.
				await client.transact([
					{ doOperations: [del(b1), skipMove(b3), del(b3)] },
				]);

				const after = await childIds(docId);
				expect(after).toContain(b1);
				expect(after).toContain(b3);
				expect(after).toHaveLength(3);
			},
		);

		it(
			"array-order execution: op 2 sees op 1's in-tx effects",
			{ timeout: 30_000 },
			async () => {
				const { docId, ids } = await paraDoc("order", 3);
				const p1 = pick(ids, token("order", 0));
				const p2 = pick(ids, token("order", 1));
				const p3 = pick(ids, token("order", 2));

				// op 1 moves p2 after p3 → [p1, p3, p2]; op 2 then moves p1
				// after p2's NEW position → [p3, p2, p1]. Run in any other
				// order the final arrangement differs — [p3, p2, p1] is only
				// reachable with in-tx sequential application.
				await client.transact([
					{ doOperations: [moveAfter(p2, p3), moveAfter(p1, p2)] },
				]);

				const after = await childIds(docId);
				expect(after).toEqual([p3, p2, p1]);
			},
		);

		it(
			"ack-time commit-wait: a 1-op batch behind a large queued batch acks only after the large batch committed",
			{ timeout: 60_000 },
			async () => {
				const { docId, ids } = await paraDoc("commitwait", 60);
				const all = [...ids.values()];

				// Fire the 45-op batch without awaiting, then send a 1-op
				// batch behind it after a short gap — short enough that the
				// big batch is still mid-queue, long enough that the client
				// transport cannot reorder two same-tick requests (at zero
				// gap it can, and then the queue FIFOs on the reversed
				// arrival order). The queue FIFOs on reqId, which the
				// client stamps monotonically at call time.
				let bigError: unknown;
				const big = client
					.transact([{ doOperations: all.slice(0, 45).map(del) }])
					.catch((err: unknown) => {
						bigError = err;
					});
				await sleep(10);
				await client.transact([{ doOperations: [del(all[45]!)] }]);

				// No drain between ack and walk: at the 1-op batch's ack the
				// big batch's entire effect is already visible — 46 gone.
				const after = await childIds(docId);
				expect(after).toHaveLength(14);

				// also resolves — the big batch acked success too; the catch
				// above only disarms the interim unhandled-rejection window.
				await big;
				expect(bigError).toBeUndefined();
			},
		);

		it(
			"31 ops, stale id mid-batch: per-op path fails open — stale id silently skipped, the rest applies",
			{ timeout: 60_000 },
			async () => {
				const { docId, ids } = await paraDoc("cliff31", 30);
				const present = [...ids.values()];
				const stale = "20261018120000-0000000000000";

				// 30 present ids + 1 stale mid-batch = 31 ops — per-op path.
				// All 30 deletes land; the stale id is silently skipped. The
				// walk may keep one content-less empty paragraph (a doc whose
				// every block is deleted gets an empty-paragraph residue), so
				// the assertion is that no ORIGINAL id survives.
				const ops = [...present];
				ops.splice(15, 0, stale);
				await client.transact([{ doOperations: ops.map(del) }]);

				const after = await childIds(docId);
				expect(after.some((id) => present.includes(id))).toBe(false);
			},
		);

		it(
			"32 ops, stale id mid-batch: bulk path fails closed — nothing lands behind a success ack",
			{ timeout: 60_000 },
			async () => {
				const { docId, ids } = await paraDoc("cliff32", 31);
				const present = [...ids.values()];
				const stale = "20261018120000-0000000000000";

				// 31 present ids + 1 stale mid-batch = 32 ops — bulk path.
				// Nothing lands; all 31 paragraphs survive.
				const ops = [...present];
				ops.splice(16, 0, stale);
				await client.transact([{ doOperations: ops.map(del) }]);

				const after = await childIds(docId);
				expect(after).toHaveLength(31);
			},
		);

		it(
			"32 ops, stale id first: bulk tree-load failure silently no-ops the whole batch",
			{ timeout: 60_000 },
			async () => {
				const { docId, ids } = await paraDoc("cliff32first", 31);
				const present = [...ids.values()];

				// Stale id first, 32 ops total: the bulk path loads one tree
				// from ops[0].ID — the stale id defeats the load, and the
				// whole batch silently no-ops.
				await client.transact([
					{
						doOperations: ["20261018120000-0000000000000", ...present].map(del),
					},
				]);

				const after = await childIds(docId);
				expect(after).toHaveLength(31);
			},
		);

		it(
			"rollback index damage round trip: invisible to SQL/walk, visible only by-id; retry no-ops; heal route blind; a committed write repairs and the retry lands",
			{ timeout: 120_000 },
			async () => {
				const { docId, ids } = await paraDoc("damage", 8);
				const p = (i: number) => pick(ids, token("damage", i));

				// Wait for the SQL index so the intact-rows assert below is
				// measuring the damage, not index lag.
				await waitFor(
					() =>
						client.query(
							`SELECT id FROM blocks WHERE root_id = '${docId}' AND type = 'p'`,
						),
					(rows) => rows.length === 8,
				);

				// Per-op path (<32 ops): both deletes execute (their index
				// rows are removed synchronously), then the skip-class move
				// rolls the whole batch back.
				await client.transact([
					{ doOperations: [del(p(0)), del(p(1)), skipMove(p(2))] },
				]);

				// The tree is intact — the walk reads all 8 paragraphs.
				const walk = await childIds(docId);
				expect(walk).toHaveLength(8);

				// The SQL rows are intact too — the rollback precedes index
				// queueing, so no tool-surface read shows anything wrong.
				const sqlP0 = await client.query(
					`SELECT id FROM blocks WHERE id = '${p(0)}'`,
				);
				expect(sqlP0).toHaveLength(1);

				// By-id resolution is the only damaged instrument: the two
				// executed ids answer not-found, the untouched control reads.
				expect(await kramdown(p(0))).toBe(-1);
				expect(await kramdown(p(1))).toBe(-1);
				expect(await kramdown(p(4))).toBe(0);

				// A retried delete of a damaged id acks success and silently
				// no-ops — the batch commits, the walk is unchanged.
				await client.transact([{ doOperations: [del(p(0))] }]);
				expect(await childIds(docId)).toHaveLength(8);

				// The kernel's own heal route cannot repair interior-row
				// damage: getBlockInfo answers not-found and the detector is
				// unchanged.
				expect(await blockInfo(p(0))).toBe(-1);
				expect(await kramdown(p(0))).toBe(-1);

				// A committed write to the touched doc re-upserts the whole
				// tree's rows: resolution is restored...
				await client.updateBlock({
					id: p(4),
					data: `${token("damage", 4)} repaired`,
				});
				expect(await kramdown(p(0))).toBe(0);

				// ...and the retried delete now lands.
				await client.transact([{ doOperations: [del(p(0))] }]);
				expect(await childIds(docId)).toHaveLength(7);
			},
		);

		it(
			"all-ops-executed residue: a whole-batch re-issue lands nothing at either size; only a committed write restores resolvability, and the re-issue then lands",
			{ timeout: 120_000 },
			async () => {
				const { docId, ids } = await paraDoc("exhausted", 40);
				const p = (i: number) => pick(ids, token("exhausted", i));

				// 31 ops stays on the per-op path: all 30 deletes execute
				// (every one of their index rows removed), then the skip-class
				// move rolls the batch back — every judged id is damaged.
				const thirty = Array.from({ length: 30 }, (_, i) => del(p(i)));
				await client.transact([{ doOperations: [...thirty, skipMove(p(35))] }]);
				expect(await childIds(docId)).toHaveLength(40);
				expect(await kramdown(p(0))).toBe(-1);

				// <32 re-issue: every op hits the damaged not-found arm —
				// silent no-ops behind a success ack, nothing re-upserted.
				await client.transact([{ doOperations: thirty }]);
				expect(await childIds(docId)).toHaveLength(40);
				expect(await kramdown(p(0))).toBe(-1);

				// ≥32 re-issue: the bulk path loads one tree from ops[0].ID —
				// the damaged id defeats the load, the whole batch no-ops.
				await client.transact([
					{
						doOperations: [...thirty, del(p(30)), del(p(31))],
					},
				]);
				expect(await childIds(docId)).toHaveLength(40);
				expect(await kramdown(p(0))).toBe(-1);
				expect(await kramdown(p(31))).toBe(0);

				// One committed write to the doc restores resolution...
				await client.updateBlock({
					id: p(39),
					data: `${token("exhausted", 39)} repaired`,
				});
				expect(await kramdown(p(0))).toBe(0);

				// ...and the re-issue now lands: all 30 deleted, 10 remain.
				await client.transact([{ doOperations: thirty }]);
				expect(await childIds(docId)).toHaveLength(10);
			},
		);

		it(
			"undo state: a batch without caller-supplied undoOperations leaves no editor undo record",
			{ timeout: 60_000 },
			async () => {
				const { docId, ids } = await paraDoc("undo", 4);
				const p = (i: number) => pick(ids, token("undo", i));

				expect(await undoState(docId)).toBe(false);

				await client.transact([{ doOperations: [del(p(0))] }]);
				expect(await undoState(docId)).toBe(false);

				await client.transact([{ doOperations: [skipMove(p(1))] }]);
				expect(await undoState(docId)).toBe(false);

				await client.transact([
					{ doOperations: [del("20261018120000-0000000000000"), del(p(2))] },
				]);
				expect(await undoState(docId)).toBe(false);
			},
		);
	},
);
