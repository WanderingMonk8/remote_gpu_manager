import { describe, expect, test } from "bun:test";
import { upstreamErrorCode } from "../host-gateway/upstream-error";

describe("worker upstream diagnostics", () => {
  test("recognizes DNS errors without treating them as proof of a changed hostname", () => {
    expect(upstreamErrorCode({ cause: { code: "ENOTFOUND" } })).toBe("upstream_dns_unresolved");
    expect(upstreamErrorCode({ cause: { message: "getaddrinfo ENOTFOUND worker.example" } })).toBe("upstream_dns_unresolved");
    expect(upstreamErrorCode({ cause: { code: "EAI_AGAIN" } })).toBe("upstream_dns_unresolved");
  });
  test("preserves timeout and general network classifications", () => {
    expect(upstreamErrorCode({ name: "AbortError" })).toBe("upstream_timeout");
    expect(upstreamErrorCode({ cause: { code: "ECONNREFUSED" } })).toBe("upstream_unreachable");
  });
});
