/**
 * Remote GPU Manager — host-side gateway (M1).
 *
 * A narrowly scoped, loopback-only authenticated reverse proxy between
 * Lumiverse's native ComfyUI provider and an authenticated upstream ComfyUI
 * worker (typically an ngrok tunnel to an interactively started notebook, or a
 * local ComfyUI).
 *
 * Hard rules (see docs/adr-001-native-integration.md):
 *   - Binds 127.0.0.1 only. Never expose a public port.
 *   - Proxies ONLY the versioned ComfyUI route allowlist below. No arbitrary
 *     upstream proxying; no SSRF (upstream is fixed via env, not per request).
 *   - Injects `Authorization: Basic` + `ngrok-skip-browser-warning` upstream.
 *     Credentials are read from the environment (operator-managed), never from
 *     Lumiverse/extension requests, never logged.
 *   - Never logs prompts, image data, or query strings. One audit line per
 *     request: timestamp method path-without-query status latency.
 *   - Discovery/health requests never allocate a GPU — the gateway contains no
 *     provisioning logic (M4+ will add an authorized-host lifecycle adapter
 *     behind an explicit capability flag; manual mode is the default).
 */

import { timingSafeEqual } from "node:crypto";

const VERSION = "0.1.0-m1";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
};

const GATEWAY_PORT = Number(env("GATEWAY_PORT", "8189"));
let GATEWAY_UPSTREAM = env("GATEWAY_UPSTREAM").replace(/\/+$/, "");

// Default to https:// when the owner omits the scheme (common with ngrok hosts).
if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(GATEWAY_UPSTREAM)) {
  GATEWAY_UPSTREAM = `https://${GATEWAY_UPSTREAM}`;
  console.warn(`[rgm-gateway] GATEWAY_UPSTREAM had no scheme; defaulting to ${GATEWAY_UPSTREAM}`);
}
const BASIC_AUTH = process.env.GATEWAY_BASIC_AUTH ?? ""; // "user:password"
const SKIP_BROWSER_WARNING = (process.env.GATEWAY_SKIP_BROWSER_WARNING ?? "1") === "1";
const CONTROL_TOKEN = process.env.GATEWAY_CONTROL_TOKEN ?? "";
const STARTED_AT = Date.now();

const upstreamUrl = new URL(GATEWAY_UPSTREAM);
if (upstreamUrl.protocol !== "http:" && upstreamUrl.protocol !== "https:") {
  throw new Error("GATEWAY_UPSTREAM must be http(s)");
}

const AUTHORIZATION =
  BASIC_AUTH.length > 0 ? `Basic ${Buffer.from(BASIC_AUTH, "utf8").toString("base64")}` : null;

/* ---------------- allowlist ---------------- */

interface RouteRule {
  method: "GET" | "POST";
  pattern: RegExp;
  maxBytes: number;
  timeoutMs: number;
  /** Validate upstream JSON shape minimally (prefix check only). */
  expectJson?: boolean;
}

const BODY_PROMPT = 1 * 1024 * 1024;
const BODY_QUEUE = 64 * 1024;
const BODY_UPLOAD = 100 * 1024 * 1024;

const ROUTES: RouteRule[] = [
  { method: "GET", pattern: /^\/system_stats$/, maxBytes: 16 * 1024, timeoutMs: 10_000, expectJson: true },
  { method: "GET", pattern: /^\/object_info(\/[A-Za-z0-9_]+)?$/, maxBytes: 64 * 1024 * 1024, timeoutMs: 120_000, expectJson: true },
  { method: "POST", pattern: /^\/prompt$/, maxBytes: BODY_PROMPT, timeoutMs: 120_000, expectJson: true },
  { method: "GET", pattern: /^\/history\/[0-9a-fA-F-]{36}$/, maxBytes: 4 * 1024 * 1024, timeoutMs: 60_000, expectJson: true },
  { method: "GET", pattern: /^\/view$/, maxBytes: 100 * 1024 * 1024, timeoutMs: 60_000 },
  { method: "GET", pattern: /^\/queue$/, maxBytes: 256 * 1024, timeoutMs: 10_000, expectJson: true },
  { method: "POST", pattern: /^\/queue$/, maxBytes: BODY_QUEUE, timeoutMs: 10_000, expectJson: true },
  { method: "POST", pattern: /^\/interrupt$/, maxBytes: 4096, timeoutMs: 10_000, expectJson: true },
  { method: "POST", pattern: /^\/upload\/image$/, maxBytes: BODY_UPLOAD, timeoutMs: 120_000 },
];

const WS_PATH = /^\/ws$/;

function matchRoute(method: string, path: string): RouteRule | null {
  for (const rule of ROUTES) {
    if (rule.method === method && rule.pattern.test(path)) return rule;
  }
  return null;
}

/* ---------------- helpers ---------------- */

const audit = (method: string, path: string, status: number, ms: number, bytes?: number) => {
  const size = typeof bytes === "number" ? ` bytes=${bytes}` : "";
  console.log(`${new Date().toISOString()} ${method} ${path} -> ${status} ${ms}ms${size}`);
};

/**
 * Stream `GET /view` straight through instead of buffering it in the gateway.
 *
 * The generated image is the largest body on this path and the tunnel needs
 * 10-15 s to deliver it. Buffering first meant Lumiverse received no response
 * headers for that entire window — long enough for its fetch to give up and
 * issue a second `/view` that timed out the same way. Streaming sends headers
 * and bytes as soon as the worker starts responding.
 *
 * A peer hang-up is logged with the byte count, which is the only way to tell
 * "Lumiverse never received the image" from "Lumiverse received it and dropped
 * it afterwards".
 */
async function proxyStreamingView(
  path: string,
  init: RequestInit,
  rule: RouteRule,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), rule.timeoutMs);

  let upstream: Response;
  try {
    upstream = await fetch(GATEWAY_UPSTREAM + path, {
      ...init,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const detail = String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e?.name ?? "error").slice(0, 200);
    console.warn(`[rgm-gateway] ${path.split("?")[0]} upstream fetch failed: ${e?.name ?? "Error"} (${detail})`);
    if (e?.name === "AbortError") throw new HttpError(504, "upstream_timeout");
    throw new HttpError(502, "upstream_unreachable");
  }

  const contentType = (upstream.headers.get("content-type") ?? "application/octet-stream").split(";")[0];
  const declared = Number(upstream.headers.get("content-length") ?? "");
  const encoding = upstream.headers.get("content-encoding");
  const headers: Record<string, string> = { "Content-Type": contentType };
  // Only advertise a length when the bytes cannot be re-encoded in transit.
  if (!encoding && Number.isFinite(declared) && declared > 0) {
    headers["Content-Length"] = String(declared);
  }

  if (!upstream.body) {
    clearTimeout(timer);
    console.log(`[rgm-gateway] /view upstream ${upstream.status} with no body`);
    return new Response(null, { status: upstream.status, headers });
  }

  const reader = upstream.body.getReader();
  let transferred = 0;
  let settled = false;
  const settle = (message: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const total = declared > 0 ? `/${declared}` : "";
    console.log(`[rgm-gateway] /view body ${message} (${transferred}${total} bytes)`);
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          settle("delivered");
          return;
        }
        transferred += value.byteLength;
        if (transferred > rule.maxBytes) {
          try { await reader.cancel("too large"); } catch { /* ignore */ }
          controller.error(new HttpError(502, "upstream_response_too_large"));
          settle("aborted: too large");
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        settle(`failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
        try { controller.error(err); } catch { /* ignore */ }
      }
    },
    cancel(reason) {
      settle(`cancelled by client: ${String(reason ?? "no reason").slice(0, 160)}`);
      try { void reader.cancel(reason); } catch { /* ignore */ }
    },
  });

  console.log(
    `[rgm-gateway] /view streaming ${upstream.status} (${declared > 0 ? `${declared} bytes` : "length unknown"})`,
  );
  return new Response(stream, { status: upstream.status, headers });
}

function upstreamHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (AUTHORIZATION) h["Authorization"] = AUTHORIZATION;
  if (SKIP_BROWSER_WARNING) h["ngrok-skip-browser-warning"] = "1";
  return h;
}

function isHopByHop(header: string): boolean {
  return /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|content-length|content-encoding|access-control-)/i.test(header);
}

async function readBounded(req: Request, maxBytes: number): Promise<ArrayBuffer> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) {
    throw new HttpError(413, "request_body_too_large");
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new HttpError(413, "request_body_too_large");
  }
  return buf;
}

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

const errJson = (status: number, code: string) =>
  Response.json({ error: code }, { status, headers: { "Content-Type": "application/json" } });

async function fetchUpstream(
  path: string,
  init: RequestInit,
  rule: RouteRule,
): Promise<{ status: number; contentType: string; body: Uint8Array }> {
  // Idempotent GETs are retried on connection reset (ngrok edge RSTs datacenter
  // bursts; HF Space egress has proven flaky). POST /prompt is never retried —
  // a blind resubmission could duplicate an inference job.
  const maxAttempts = init.method === "GET" ? 3 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), rule.timeoutMs);
    try {
      const res = await fetch(GATEWAY_UPSTREAM + path, {
        ...init,
        signal: controller.signal,
        redirect: "manual",
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > rule.maxBytes) {
        throw new HttpError(502, "upstream_response_too_large");
      }
      return {
        status: res.status,
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
        body: buf,
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const e = err as Error & { cause?: { code?: string; message?: string } };
      const detail = e?.cause?.code
        ?? e?.cause?.message
        ?? e?.cause
        ?? e?.message
        ?? e?.name
        ?? "error";
      const detailStr = String(detail).slice(0, 200);
      const retriable = e?.name !== "AbortError" && !/too large|invalid/i.test(detailStr);
      if (attempt < maxAttempts && retriable) {
        console.warn(`[rgm-gateway] upstream fetch failed (${detailStr}); retrying idempotent GET (${attempt}/${maxAttempts})`);
        await new Promise((r) => setTimeout(r, 250 * attempt));
        continue;
      }
      console.warn(`[rgm-gateway] upstream fetch failed: ${e?.name ?? "Error"} (${detailStr})`);
      if (e?.name === "AbortError") throw new HttpError(504, "upstream_timeout");
      throw new HttpError(502, "upstream_unreachable");
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HttpError(502, "upstream_unreachable");
}

/* ---------------- control plane (loopback only) ---------------- */

async function handleControl(req: Request, path: string): Promise<Response> {
  if (!CONTROL_TOKEN) return errJson(404, "control_not_enabled");
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${CONTROL_TOKEN}`;
  // Constant-time comparison
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  const match = a.length === b.length && timingSafeEqual(a, b);
  if (!match) return errJson(401, "control_auth_required");

  if (path === "/gateway/v1/status") {
    const probeStart = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(GATEWAY_UPSTREAM + "/system_stats", {
        headers: upstreamHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return Response.json({
        gateway: { version: VERSION, uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000) },
        upstream: { configured: GATEWAY_UPSTREAM, reachable: res.ok, status: res.status, latencyMs: Date.now() - probeStart },
      });
    } catch (err) {
      return Response.json(
        {
          gateway: { version: VERSION, uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000) },
          upstream: { configured: GATEWAY_UPSTREAM, reachable: false, lastError: (err as Error)?.name ?? "error" },
        },
        { status: 502 },
      );
    }
  }
  return errJson(404, "route_not_allowed");
}

/* ---------------- server ---------------- */

type WsData = { upstream: WebSocket | null; clientId: string };

const server = Bun.serve<WsData>({
  hostname: "127.0.0.1",
  port: GATEWAY_PORT,

  // Bun's default is 10 seconds, and it does NOT exempt a request whose handler
  // is still waiting on upstream — the socket is simply closed.
  //
  // That is what broke 1024px generations: `/view` needed 11-13 s to pull the
  // image out of the tunnel, the gateway had written nothing yet, and Bun closed
  // the connection at ~10.7 s. Lumiverse then reported "socket connection was
  // closed unexpectedly" and threw the image away. 512px transfers finish under
  // 10 s, which is why they almost always succeeded.
  //
  // Cold `/object_info` can also take 20-120 s. 255 s is Bun's maximum and
  // comfortably covers both.
  idleTimeout: 255,

  async fetch(req, server) {
    const started = Date.now();
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const ms = () => Date.now() - started;

    try {
      /* ---- control plane ---- */
      if (path.startsWith("/gateway/")) {
        const res = await handleControl(req, path);
        audit(req.method, path, res.status, ms());
        return res;
      }

      /* ---- WebSocket upgrade ---- */
      if (WS_PATH.test(path)) {
        if (req.method !== "GET" || !req.headers.get("upgrade")?.toLowerCase().includes("websocket")) {
          const res = errJson(405, "ws_upgrade_required");
          audit(req.method, path, res.status, ms());
          return res;
        }
        const clientId = url.searchParams.get("clientId");
        if (!clientId || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) {
          const res = errJson(400, "clientId_required");
          audit(req.method, path, res.status, ms());
          return res;
        }
        const upgraded = server.upgrade(req, { data: { upstream: null, clientId } });
        audit(req.method, path, upgraded ? 101 : 400, ms());
        return upgraded ? undefined : errJson(400, "ws_upgrade_failed");
      }

      /* ---- HTTP proxy ---- */
      const rule = matchRoute(req.method, path);
      if (!rule) {
        const res = errJson(403, "route_not_allowed");
        audit(req.method, path, res.status, ms());
        return res;
      }

      const body =
        req.method === "POST" ? new Uint8Array(await readBounded(req, rule.maxBytes)) : undefined;

      const contentType = req.headers.get("content-type") ?? "application/json";
      const upstreamInit: RequestInit = {
        method: req.method,
        headers: upstreamHeaders(body ? { "Content-Type": contentType } : {}),
        body,
      };

      // `/view` streams so Lumiverse sees response headers immediately rather
      // than waiting out the whole 10-15 s tunnel transfer.
      if (path === "/view") {
        const res = await proxyStreamingView(path + url.search, upstreamInit, rule);
        audit(req.method, path, res.status, ms());
        return res;
      }

      const upstream = await fetchUpstream(path + (req.method === "GET" ? url.search : ""), upstreamInit, rule);

      if (rule.expectJson && upstream.status >= 200 && upstream.status < 300) {
        try {
          JSON.parse(new TextDecoder().decode(upstream.body));
        } catch {
          const res = errJson(502, "upstream_invalid_json");
          audit(req.method, path, res.status, ms());
          return res;
        }
      }

      const resHeaders = { "Content-Type": upstream.contentType.split(";")[0] };

      const res = new Response(upstream.body, {
        status: upstream.status,
        headers: resHeaders,
      });
      audit(req.method, path, upstream.status, ms(), upstream.body.byteLength);
      return res;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : "gateway_error";
      const res = errJson(status, code);
      audit(req.method, path, status, ms());
      return res;
    }
  },

  websocket: {
    async open(ws) {
      const { clientId } = ws.data;
      const upstreamUrlWs = `${GATEWAY_UPSTREAM.replace(/^http/, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`;
      const upstream = new WebSocket(upstreamUrlWs, {
        headers: upstreamHeaders(),
      } as unknown as string[]);
      ws.data.upstream = upstream;

      const handshake = setTimeout(() => {
        try { upstream.close(); } catch { /* ignore */ }
        try { ws.close(1011, "upstream_handshake_timeout"); } catch { /* ignore */ }
      }, 10_000);

      upstream.addEventListener("open", () => clearTimeout(handshake), { once: true });
      upstream.addEventListener("error", () => {
        clearTimeout(handshake);
        try { ws.close(1011, "upstream_error"); } catch { /* ignore */ }
      });
      upstream.addEventListener("close", (event) => {
        clearTimeout(handshake);
        try { ws.close(event.code === 1005 ? 1000 : event.code, "upstream_closed"); } catch { /* ignore */ }
      });
      upstream.addEventListener("message", (event) => {
        try {
          const data = event.data as string | Uint8Array;
          const bytes = typeof data === "string" ? new TextEncoder().encode(data).length : (data?.byteLength ?? 0);
          const preview = typeof data === "string" ? data.slice(0, 80) : `binary ${bytes}B`;
          console.log(`[rgm-gateway] upstream ws message clientId=${clientId} bytes=${bytes} preview=${preview}`);
          ws.send(data);
        } catch {
          /* client gone */
        }
      });
    },
    message(ws, message) {
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        try {
          upstream.send(message as string | ArrayBuffer);
        } catch {
          /* drop */
        }
      }
    },
    close(ws, code, reason) {
      const upstream = ws.data.upstream;
      ws.data.upstream = null;
      if (upstream && upstream.readyState <= WebSocket.OPEN) {
        try {
          upstream.close(Number.isFinite(code) ? code : 1000, reason?.slice(0, 120) || "client_closed");
        } catch {
          /* already closed */
        }
      }
    },
  },
});

console.log(
  `remote-gpu-manager gateway ${VERSION} on 127.0.0.1:${GATEWAY_PORT} -> ${GATEWAY_UPSTREAM} (auth: ${AUTHORIZATION ? "basic" : "NONE"})`,
);
