/** Distinguish lookup failures without exposing hostnames or transport details. */
export function upstreamErrorCode(error: unknown): "upstream_timeout" | "upstream_dns_unresolved" | "upstream_unreachable" {
  const e = error as { name?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "upstream_timeout";
  const details = [e?.cause?.code, e?.cause?.message, e?.message].filter(value => typeof value === "string").join(" ");
  return /\b(?:ENOTFOUND|EAI_AGAIN|EAI_NONAME)\b/i.test(details) ? "upstream_dns_unresolved" : "upstream_unreachable";
}
