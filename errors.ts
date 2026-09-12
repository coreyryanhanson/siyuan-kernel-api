/**
 * Error contract for SiYuanKernelClient.
 * `SiYuanKernelError` is the base class and is never thrown directly; callers
 * can branch on the subclasses with `instanceof` (e.g. a circuit breaker that
 * counts `SiYuanAuthError` but excludes `SiYuanRateLimitError`).
 */

/** Base class for every error this client throws. Never thrown directly. */
export class SiYuanKernelError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SiYuanKernelError";
	}
}

/** Non-2xx status the kernel did not classify more specifically, or a 2xx whose body is not a gulu envelope (`code`/`msg` absent or `code !== 0`). */
export class SiYuanApiError extends SiYuanKernelError {
	readonly status: number;
	/** Envelope `code`; undefined when the body carried no parseable envelope. */
	readonly code?: number;
	/** Envelope `msg`; undefined when the body carried no parseable envelope. */
	readonly msg?: string;

	constructor(status: number, code?: number, msg?: string) {
		const detail =
			code === undefined
				? `HTTP ${status}`
				: `HTTP ${status}, code ${code}${msg ? `: ${msg}` : ""}`;
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
	readonly retryAfterSeconds?: number;

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
	constructor(timeoutMs: number) {
		super(`SiYuan request timed out after ${timeoutMs}ms`);
		this.name = "SiYuanTimeoutError";
	}
}

/** fetch itself rejected (DNS, connection refused, …), after the retry budget was exhausted. */
export class SiYuanNetworkError extends SiYuanKernelError {
	constructor(options?: ErrorOptions) {
		super("SiYuan kernel unreachable", options);
		this.name = "SiYuanNetworkError";
	}
}
