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

  constructor(baseUrl: string, token: string) {
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
  }
}
