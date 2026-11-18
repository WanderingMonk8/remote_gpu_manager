// @bun
// host-gateway/gateway.ts
import { timingSafeEqual } from "crypto";
var VERSION = "0.1.0-m1";
var env = (name, fallback) => {
  const v = process.env[name];
  if (v && v.length > 0)
    return v;
  if (fallback !== undefined)
    return fallback;
  throw new Error(`Missing required environment variable ${name}`);
};
var GATEWAY_PORT = Number(env("GATEWAY_PORT", "8189"));
var GATEWAY_UPSTREAM = env("GATEWAY_UPSTREAM").replace(/\/+$/, "");
if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(GATEWAY_UPSTREAM)) {
  GATEWAY_UPSTREAM = `https://${GATEWAY_UPSTREAM}`;
  console.warn(`[rgm-gateway] GATEWAY_UPSTREAM had no scheme; defaulting to ${GATEWAY_UPSTREAM}`);
}
var BASIC_AUTH = process.env.GATEWAY_BASIC_AUTH ?? "";
var SKIP_BROWSER_WARNING = (process.env.GATEWAY_SKIP_BROWSER_WARNING ?? "1") === "1";
var CONTROL_TOKEN = process.env.GATEWAY_CONTROL_TOKEN ?? "";
var STARTED_AT = Date.now();
var upstreamUrl = new URL(GATEWAY_UPSTREAM);
if (upstreamUrl.protocol !== "http:" && upstreamUrl.protocol !== "https:") {
  throw new Error("GATEWAY_UPSTREAM must be http(s)");
}
var AUTHORIZATION = BASIC_AUTH.length > 0 ? `Basic ${Buffer.from(BASIC_AUTH, "utf8").toString("base64")}` : null;
var BODY_PROMPT = 1 * 1024 * 1024;
var BODY_QUEUE = 64 * 1024;
var BODY_UPLOAD = 100 * 1024 * 1024;
var ROUTES = [
  { method: "GET", pattern: /^\/system_stats$/, maxBytes: 16 * 1024, timeoutMs: 1e4, expectJson: true },
  { method: "GET", pattern: /^\/object_info(\/[A-Za-z0-9_]+)?$/, maxBytes: 64 * 1024 * 1024, timeoutMs: 30000, expectJson: true },
  { method: "POST", pattern: /^\/prompt$/, maxBytes: BODY_PROMPT, timeoutMs: 120000, expectJson: true },
  { method: "GET", pattern: /^\/history\/[0-9a-fA-F-]{36}$/, maxBytes: 4 * 1024 * 1024, timeoutMs: 15000, expectJson: true },
  { method: "GET", pattern: /^\/view$/, maxBytes: 100 * 1024 * 1024, timeoutMs: 60000 },
  { method: "GET", pattern: /^\/queue$/, maxBytes: 256 * 1024, timeoutMs: 1e4, expectJson: true },
  { method: "POST", pattern: /^\/queue$/, maxBytes: BODY_QUEUE, timeoutMs: 1e4, expectJson: true },
  { method: "POST", pattern: /^\/interrupt$/, maxBytes: 4096, timeoutMs: 1e4, expectJson: true },
  { method: "POST", pattern: /^\/upload\/image$/, maxBytes: BODY_UPLOAD, timeoutMs: 120000 }
];
var WS_PATH = /^\/ws$/;
function matchRoute(method, path) {
  for (const rule of ROUTES) {
    if (rule.method === method && rule.pattern.test(path))
      return rule;
  }
  return null;
}
var audit = (method, path, status, ms) => {
  console.log(`${new Date().toISOString()} ${method} ${path} -> ${status} ${ms}ms`);
};
function upstreamHeaders(extra = {}) {
  const h = { ...extra };
  if (AUTHORIZATION)
    h["Authorization"] = AUTHORIZATION;
  if (SKIP_BROWSER_WARNING)
    h["ngrok-skip-browser-warning"] = "1";
  return h;
}
async function readBounded(req, maxBytes) {
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
  status;
  code;
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
var errJson = (status, code) => Response.json({ error: code }, { status, headers: { "Content-Type": "application/json" } });
async function fetchUpstream(path, init, rule) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), rule.timeoutMs);
  try {
    const res = await fetch(GATEWAY_UPSTREAM + path, {
      ...init,
      signal: controller.signal,
      redirect: "manual"
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > rule.maxBytes) {
      throw new HttpError(502, "upstream_response_too_large");
    }
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      body: buf
    };
  } catch (err) {
    if (err instanceof HttpError)
      throw err;
    const e = err;
    const detail = e?.cause?.code ?? e?.cause?.message ?? e?.cause ?? e?.message ?? e?.name ?? "error";
    console.warn(`[rgm-gateway] upstream fetch failed: ${e?.name ?? "Error"} (${String(detail).slice(0, 300)})`);
    if (e?.name === "AbortError")
      throw new HttpError(504, "upstream_timeout");
    throw new HttpError(502, "upstream_unreachable");
  } finally {
    clearTimeout(timer);
  }
}
async function handleControl(req, path) {
  if (!CONTROL_TOKEN)
    return errJson(404, "control_not_enabled");
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${CONTROL_TOKEN}`;
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  const match = a.length === b.length && timingSafeEqual(a, b);
  if (!match)
    return errJson(401, "control_auth_required");
  if (path === "/gateway/v1/status") {
    const probeStart = Date.now();
    try {
      const controller = new AbortController;
      const timer = setTimeout(() => controller.abort(), 1e4);
      const res = await fetch(GATEWAY_UPSTREAM + "/system_stats", {
        headers: upstreamHeaders(),
        signal: controller.signal
      });
      clearTimeout(timer);
      return Response.json({
        gateway: { version: VERSION, uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000) },
        upstream: { configured: GATEWAY_UPSTREAM, reachable: res.ok, status: res.status, latencyMs: Date.now() - probeStart }
      });
    } catch (err) {
      return Response.json({
        gateway: { version: VERSION, uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000) },
        upstream: { configured: GATEWAY_UPSTREAM, reachable: false, lastError: err?.name ?? "error" }
      }, { status: 502 });
    }
  }
  return errJson(404, "route_not_allowed");
}
var server = Bun.serve({
  hostname: "127.0.0.1",
  port: GATEWAY_PORT,
  async fetch(req, server) {
    const started = Date.now();
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const ms = () => Date.now() - started;
    try {
      if (path.startsWith("/gateway/")) {
        const res = await handleControl(req, path);
        audit(req.method, path, res.status, ms());
        return res;
      }
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
      const rule = matchRoute(req.method, path);
      if (!rule) {
        const res = errJson(403, "route_not_allowed");
        audit(req.method, path, res.status, ms());
        return res;
      }
      const body = req.method === "POST" ? new Uint8Array(await readBounded(req, rule.maxBytes)) : undefined;
      const contentType = req.headers.get("content-type") ?? "application/json";
      const upstreamInit = {
        method: req.method,
        headers: upstreamHeaders(body ? { "Content-Type": contentType } : {}),
        body
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
        headers: { "Content-Type": upstream.contentType.split(";")[0] }
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
        headers: upstreamHeaders()
      });
      ws.data.upstream = upstream;
      const handshake = setTimeout(() => {
        try {
          upstream.close();
        } catch {}
        try {
          ws.close(1011, "upstream_handshake_timeout");
        } catch {}
      }, 1e4);
      upstream.addEventListener("open", () => clearTimeout(handshake), { once: true });
      upstream.addEventListener("error", () => {
        clearTimeout(handshake);
        try {
          ws.close(1011, "upstream_error");
        } catch {}
      });
      upstream.addEventListener("close", (event) => {
        clearTimeout(handshake);
        try {
          ws.close(event.code === 1005 ? 1000 : event.code, "upstream_closed");
        } catch {}
      });
      upstream.addEventListener("message", (event) => {
        try {
          ws.send(event.data);
        } catch {}
      });
    },
    message(ws, message) {
      const upstream = ws.data.upstream;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        try {
          upstream.send(message);
        } catch {}
      }
    },
    close(ws, code, reason) {
      const upstream = ws.data.upstream;
      ws.data.upstream = null;
      if (upstream && upstream.readyState <= WebSocket.OPEN) {
        try {
          upstream.close(Number.isFinite(code) ? code : 1000, reason?.slice(0, 120) || "client_closed");
        } catch {}
      }
    }
  }
});
console.log(`remote-gpu-manager gateway ${VERSION} on 127.0.0.1:${GATEWAY_PORT} -> ${GATEWAY_UPSTREAM} (auth: ${AUTHORIZATION ? "basic" : "NONE"})`);
