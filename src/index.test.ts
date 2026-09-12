import { describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "./index.js";

describe("SiYuanKernelClient constructor", () => {
  it("rejects empty baseUrl", () => {
    expect(() => new SiYuanKernelClient("", "token")).toThrow(TypeError);
  });

  it("rejects whitespace-only baseUrl", () => {
    expect(() => new SiYuanKernelClient("   ", "token")).toThrow(TypeError);
  });

  it("rejects empty token", () => {
    expect(() => new SiYuanKernelClient("http://127.0.0.1:6806", "")).toThrow(TypeError);
  });

  it("rejects whitespace-only token", () => {
    expect(() => new SiYuanKernelClient("http://127.0.0.1:6806", "  ")).toThrow(TypeError);
  });

  it("accepts valid inputs and trims them", () => {
    const client = new SiYuanKernelClient("  http://127.0.0.1:6806  ", " token ");
    expect(client.baseUrl).toBe("http://127.0.0.1:6806");
    expect(client.token).toBe("token");
  });

  it("strips a trailing slash from baseUrl", () => {
    const client = new SiYuanKernelClient("http://127.0.0.1:6806/", "token");
    expect(client.baseUrl).toBe("http://127.0.0.1:6806");
  });

  it("strips multiple trailing slashes from baseUrl", () => {
    const client = new SiYuanKernelClient("http://127.0.0.1:6806//", "token");
    expect(client.baseUrl).toBe("http://127.0.0.1:6806");
  });

  it("rejects a baseUrl that normalizes to empty", () => {
    expect(() => new SiYuanKernelClient("/", "token")).toThrow(TypeError);
  });
});
