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
  { method: "GET", pattern: /^\/object_info(\/[A-Za-z0-9_]+)?$/, maxBytes: 64 * 1024 * 1024, timeoutMs: 30_000, expectJson: true },
  { method: "POST", pattern: /^\/prompt$/, maxBytes: BODY_PROMPT, timeoutMs: 120_000, expectJson: true },
  { method: "GET", pattern: /^\/history\/[0-9a-fA-F-]{36}$/, maxBytes: 4 * 1024 * 1024, timeoutMs: 15_000, expectJson: true },
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

const audit = (method: string, path: string, status: number, ms: number) => {
  console.log(`${new Date().toISOString()} ${method} ${path} -> ${status} ${ms}ms`);
};

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
    // Sanitized diagnostic for operators: no URLs, no headers, no credentials.
    // `cause.code` is the underlying transport reason (ENOTFOUND, ECONNRESET,
    // CERT_*, UND_ERR_* etc.) when undici/Node provides one.
    const detail = e?.cause?.code ?? e?.cause?.message ?? e?.name ?? "error";
    console.warn(`[rgm-gateway] upstream fetch failed: ${e?.name ?? "Error"} (${detail})`);
    if (e?.name === "AbortError") throw new HttpError(504, "upstream_timeout");
    throw new HttpError(502, "upstream_unreachable");
  } finally {
    clearTimeout(timer);
  }
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

      const res = new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": upstream.contentType.split(";")[0] },
      });
      audit(req.method, path, upstream.status, ms());
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
          ws.send(event.data as string | Uint8Array);
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
