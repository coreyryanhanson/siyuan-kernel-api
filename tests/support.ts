/**
 * Shared fixtures for the two live, opt-in kernel suites
 * (`integration.si.test.ts`, `transactions.probe.si.test.ts`). Test-only:
 * `scripts/check-pack.mjs` excludes everything under `tests/` from the
 * publish tarball, so this file must never be imported from production code.
 */

export const BASE_URL = process.env.SIYUAN_BASE_URL ?? "";
export const TOKEN = process.env.SIYUAN_API_TOKEN ?? "";

/** Test constant, not a client constant — the client ships no pinned version. */
export const EXPECTED_VERSION = "3.8.8";

/** Kernel indexes may lag raw writes; bounded wait before giving up. */
const INDEX_WAIT_MS = 30_000;

export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `done` holds; throws once the index-wait budget is spent. */
export async function waitFor<T>(
	probe: () => Promise<T>,
	done: (value: T) => boolean,
): Promise<T> {
	const deadline = Date.now() + INDEX_WAIT_MS;
	let value = await probe();
	while (!done(value) && Date.now() <= deadline) {
		await sleep(1_000);
		value = await probe();
	}
	if (!done(value)) {
		throw new Error(`waitFor timed out after ${INDEX_WAIT_MS}ms`);
	}
	return value;
}

/**
 * Raw documented-HTTP call, bypassing the client — instrument/fixture only.
 * Returns the Response untouched so each suite applies its own envelope
 * policy: the probe asserts `code: -1` bodies as-is, the integration
 * fixtures unwrap successes and throw otherwise.
 */
export function rawPost(
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
