/**
 * Error contract for SiYuanKernelClient.
 * `SiYuanKernelError` is the base class and is never thrown directly; callers
 * can branch on the subclasses with `instanceof` (e.g. a circuit breaker that
 * counts `SiYuanAuthError` but excludes `SiYuanRateLimitError`).
 */

/** Base class for every error thrown on the request path. Never thrown directly. */
export class SiYuanKernelError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SiYuanKernelError";
	}
}

/** Non-2xx status the kernel did not classify more specifically, a 2xx whose body is not a gulu envelope (`code`/`msg` absent or `code !== 0`), or a 2xx success envelope whose guarded unwrap failed (a promised `data` field is missing or `null`). */
export class SiYuanApiError extends SiYuanKernelError {
	readonly status: number;
	/** Envelope `code`; undefined when the body carried no parseable envelope or when a guarded unwrap failed on a success envelope. Discriminator at `status: 200` / `code: undefined`: the client's own `msg` text means a guarded unwrap failed, no `msg` means the body was not a parseable envelope. */
	readonly code?: number | undefined;
	/** Envelope `msg`, or the client's own text when a guarded unwrap failed (the kernel sends no `msg` there); undefined when the body carried no parseable envelope. */
	readonly msg?: string | undefined;

	constructor(status: number, code?: number, msg?: string) {
		const detail = `HTTP ${status}${
			code === undefined ? "" : `, code ${code}`
		}${msg ? `: ${msg}` : ""}`;
		super(`SiYuan API error (${detail})`);
		this.name = "SiYuanApiError";
		this.status = status;
		this.code = code;
		this.msg = msg;
	}
}

/** 401 or 403 from the kernel. */
export class SiYuanAuthError extends SiYuanKernelError {
	readonly status: number;

	constructor(status: number) {
		super(`SiYuan auth rejected the request (HTTP ${status})`);
		this.name = "SiYuanAuthError";
		this.status = status;
	}
}

/** 429 from the kernel's auth throttle. Sibling of SiYuanAuthError, never a subclass. */
export class SiYuanRateLimitError extends SiYuanKernelError {
	readonly status: number;
	/** `Retry-After` in seconds as sent by the kernel; undefined when absent/unparseable. */
	readonly retryAfterSeconds?: number | undefined;

	constructor(status: number, retryAfterSeconds?: number) {
		super(
			retryAfterSeconds === undefined
				? "SiYuan rate-limited the request (HTTP 429)"
				: `SiYuan rate-limited the request (HTTP 429, Retry-After ${retryAfterSeconds}s)`,
		);
		this.name = "SiYuanRateLimitError";
		this.status = status;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/** An attempt exceeded the per-attempt timeout. */
export class SiYuanTimeoutError extends SiYuanKernelError {
	/** The per-attempt budget that elapsed, in ms. */
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`SiYuan request timed out after ${timeoutMs}ms`);
		this.name = "SiYuanTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

/** fetch itself rejected (DNS, connection refused, …), after the retry budget was exhausted. */
export class SiYuanNetworkError extends SiYuanKernelError {
	constructor(options?: ErrorOptions) {
		super("SiYuan kernel unreachable", options);
		this.name = "SiYuanNetworkError";
	}
}
