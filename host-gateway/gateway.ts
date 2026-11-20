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
 *   - Discovery/health requests never allocate a GPU. Provisioning exists only
 *     behind the explicit capability flag GATEWAY_LIFECYCLE=1 (ADR-006); manual
 *     mode is the default, and the Colab lifecycle adapter never runs without it.
 */

import { timingSafeEqual } from "node:crypto";
import { runBootstrap } from "./bootstrap";

const VERSION = "0.2.0-m4";

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

/* ---------------- lifecycle adapter (ADR-006) ---------------- */
/* Colab start/stop for the extension. Opt-in via GATEWAY_LIFECYCLE=1; manual
 * mode is the default. Custody per ADR-006: the extension reads the refresh
 * token from the Spindle enclave and hands it to this control channel once per
 * boot. It lives in memory only - never on disk, never in a log, never in a
 * response. */

const LIFECYCLE_ENABLED = (process.env.GATEWAY_LIFECYCLE ?? "") === "1";
const BOOTSTRAP_ENABLED = process.env.GATEWAY_BOOTSTRAP === "1";
const BOOTSTRAP_PYTHON = process.env.GATEWAY_BOOTSTRAP_PYTHON ?? "python3";
const BOOTSTRAP_SCRIPT = process.env.GATEWAY_BOOTSTRAP_SCRIPT ?? "tools/colab-bootstrap-worker.py";
const COLAB_BASE = (process.env.COLAB_BASE ?? "https://colaboratory.googleapis.com").replace(/\/+$/, "");
const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const RUNTIME_PREFIX = "rgm-gw-";
const SPEC_ACCELERATOR = process.env.RUNTIME_ACCELERATOR ?? "T4";
const SPEC_SHAPE = process.env.RUNTIME_SHAPE ?? "STANDARD";
const CREATE_TIMEOUT_MS = Number(process.env.RUNTIME_CREATE_TIMEOUT_MS ?? 300_000);
const IDLE_CHECK_MS = Math.max(1_000, Number(process.env.RUNTIME_IDLE_CHECK_MS ?? 30_000));

// PRD R-06 default: 10 min after last real work; 0 disables. The dashboard
// offers 5/10/15/30; PUT accepts those, plus sub-minute values for tests.
let idleMinutes = Number(process.env.RUNTIME_IDLE_MINUTES ?? 10);
if (!Number.isFinite(idleMinutes) || idleMinutes < 0) idleMinutes = 10;

const upstreamUrl = new URL(GATEWAY_UPSTREAM);
if (upstreamUrl.protocol !== "http:" && upstreamUrl.protocol !== "https:") {
  throw new Error("GATEWAY_UPSTREAM must be http(s)");
}

let AUTHORIZATION =
  BASIC_AUTH.length > 0 ? `Basic ${Buffer.from(BASIC_AUTH, "utf8").toString("base64")}` : null;

/* Adopting a worker URL at runtime is opt-in and constrained: HTTPS only, and the
 * host must match one of these suffixes. Without this the control plane would be
 * an arbitrary-URL proxy (SSRF), which the gateway deliberately is not. */
const UPSTREAM_ALLOW = (process.env.GATEWAY_UPSTREAM_ALLOW ?? ".ts.net,.trycloudflare.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
// Tests point the gateway at a loopback mock; production stays HTTPS-only.
const ALLOW_HTTP_UPSTREAM = (process.env.GATEWAY_UPSTREAM_ALLOW_HTTP ?? "") === "1";

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
    public detail?: string,
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

  if (path.startsWith("/gateway/v1/runtime")) {
    if (!LIFECYCLE_ENABLED) return errJson(403, "lifecycle_disabled");
    try {
      return await handleRuntime(req, path);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : "lifecycle_error";
      const detail = err instanceof HttpError ? err.detail : undefined;
      return Response.json(detail ? { error: code, detail } : { error: code }, { status });
    }
  }

  if (path === "/gateway/v1/upstream") {
    if (req.method === "GET") {
      return Response.json({ upstream: GATEWAY_UPSTREAM, auth: Boolean(AUTHORIZATION) });
    }
    if (req.method !== "PUT" && req.method !== "POST") {
      return errJson(405, "method_not_allowed");
    }
    let body: any;
    try {
      body = JSON.parse(new TextDecoder().decode(await readBounded(req, 8192)));
    } catch {
      return errJson(400, "invalid_json");
    }
    const raw = String(body?.url ?? "").trim();
    if (!raw) return errJson(400, "url_required");
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return errJson(400, "url_invalid");
    }
    if (parsed.protocol !== "https:" && !(ALLOW_HTTP_UPSTREAM && parsed.protocol === "http:")) {
      return errJson(400, "https_required");
    }
    const host = parsed.hostname.toLowerCase();
    if (!UPSTREAM_ALLOW.some((suffix) => host.endsWith(suffix))) {
      return errJson(403, "host_not_allowed");
    }
    const basic = typeof body?.basic_auth === "string" ? body.basic_auth.trim() : "";
    if (basic && !/^[^:\s]+:.+$/.test(basic)) {
      return errJson(400, "basic_auth_invalid");
    }
    const previous = GATEWAY_UPSTREAM;
    GATEWAY_UPSTREAM = parsed.origin;
    if (basic) {
      AUTHORIZATION = `Basic ${Buffer.from(basic, "utf8").toString("base64")}`;
    }
    console.log(
      `[rgm-gateway] upstream adopted: ${previous} -> ${GATEWAY_UPSTREAM} ` +
        `(auth: ${AUTHORIZATION ? "basic" : "NONE"})`,
    );
    return Response.json({ ok: true, upstream: GATEWAY_UPSTREAM, auth: Boolean(AUTHORIZATION) });
  }

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

/* ---------------- lifecycle adapter (ADR-006) ---------------- */

interface ColabCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}
let creds: ColabCreds | null = null;

let accessToken: { value: string; expiresAt: number } | null = null;

interface OwnedRuntime {
  name: string; // runtimes/xxx — the only handle DELETE accepts
  url: string; // connectionInfo.url (proxy host; the token is separate)
  spec: { variant: string; accelerator: string; shape: string };
  adoptedAt: string;
  tokenExpireTime: string;
}
let owned: OwnedRuntime | null = null;
let provisioning = false;
let bootstrapJob: { status: "running" | "finished"; httpStatus?: number; result?: unknown } | null = null;
// An interrupted create may still succeed at Google. Never issue another create
// in this process until the ambiguous operation is resolved by an operator.
let uncertainCreate = false;
let lastWorkAt = Date.now();

function noteWork(): void {
  lastWorkAt = Date.now();
}

// PRD R-05: submission, result retrieval, authorized asset installation.
// GET /queue polling is deliberately NOT work — the timer rechecks the queue.
function isWorkRoute(method: string, path: string): boolean {
  if (method === "POST") return path === "/prompt" || path === "/upload/image";
  if (method === "GET") return path === "/view" || /^\/history\/[0-9a-fA-F-]{36}$/.test(path);
  return false;
}

async function ensureAccessToken(): Promise<string> {
  if (accessToken && accessToken.expiresAt > Date.now() + 60_000) return accessToken.value;
  if (!creds) throw new HttpError(401, "auth_required", "POST /gateway/v1/runtime/credentials first");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) throw new HttpError(401, "auth_required", "token refresh refused");
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new HttpError(401, "auth_required", "token response had no access_token");
  accessToken = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000 };
  return accessToken.value;
}

async function colabRequest(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<{ status: number; json: any }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await ensureAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(COLAB_BASE + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error)?.name === "AbortError") throw new HttpError(504, "timeout");
      throw new HttpError(502, "offline");
    }
    clearTimeout(timer);
    if (res.status !== 401) {
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    }
    accessToken = null; // stale — refresh once, then retry
  }
  throw new HttpError(401, "auth_required");
}

function colabError(status: number, json: any): HttpError {
  const googleStatus = String(json?.error?.status ?? "");
  const message = String(json?.error?.message ?? "").slice(0, 200);
  if (status === 401 || status === 403) return new HttpError(401, "auth_required", message);
  if (status === 429) return new HttpError(429, "quota_exceeded", message);
  if (googleStatus === "FAILED_PRECONDITION") return new HttpError(403, "policy_restricted", message);
  if (status === 503 || googleStatus === "UNAVAILABLE") return new HttpError(503, "offline", message);
  return new HttpError(502, "colab_error", message);
}

async function pickEligibleSpec(): Promise<{ variant: string; accelerator: string; shape: string }> {
  const { status, json } = await colabRequest("GET", "/v1beta/runtimespecs");
  if (status !== 200) throw colabError(status, json);
  const specs: any[] = json?.runtimeSpecs ?? [];
  const hit = specs.find(
    (e: any) =>
      e?.eligible &&
      e?.key?.variant === "VARIANT_GPU" &&
      e?.key?.accelerator === SPEC_ACCELERATOR &&
      e?.key?.shape === `SHAPE_${SPEC_SHAPE}`,
  );
  if (!hit) {
    throw new HttpError(403, "policy_restricted", `${SPEC_ACCELERATOR} ${SPEC_SHAPE} is not eligible for this account right now`);
  }
  return hit.key;
}

function maskRuntime(r: OwnedRuntime) {
  return {
    name: r.name,
    url: r.url,
    spec: r.spec,
    adoptedAt: r.adoptedAt,
    tokenExpiresAt: r.tokenExpireTime,
    tokenPresent: Boolean(r.url), // the token itself never leaves this process
  };
}

// Adopt a runtime this gateway created before a restart. Only names carrying
// our prefix are ever touched; another session's runtime is never managed.
async function reconcile(): Promise<void> {
  if (!creds) return;
  const { status, json } = await colabRequest("GET", "/v1beta/runtimes");
  if (status !== 200) throw colabError(status, json);
  const mine: any[] = (json?.runtimes ?? []).filter((r: any) => r?.name?.startsWith(`runtimes/${RUNTIME_PREFIX}`));
  if (mine.length > 1) {
    throw new HttpError(409, "multiple_owned_runtimes", "Resolve multiple manager runtimes before continuing");
  }
  if (mine.length > 0) {
    const r = mine[0];
    owned = {
      name: r.name,
      url: r.connectionInfo?.url ?? "",
      spec: r.runtimeSpec ?? { variant: "VARIANT_GPU", accelerator: SPEC_ACCELERATOR, shape: `SHAPE_${SPEC_SHAPE}` },
      adoptedAt: new Date().toISOString(),
      tokenExpireTime: r.connectionInfo?.expireTime ?? "",
    };
    console.log(`[rgm-gateway] lifecycle: adopted existing runtime ${owned.name}`);
  }
}

async function startRuntime(): Promise<Response> {
  if (provisioning || bootstrapJob?.status === "running") return errJson(409, "provisioning_in_progress");
  if (owned) return Response.json({ runtime: maskRuntime(owned), state: owned.url ? "ready" : "starting", reused: true });
  if (!creds) return errJson(401, "auth_required");
  if (uncertainCreate) return errJson(409, "allocation_uncertain");
  provisioning = true;
  try {
    // A new gateway process must discover an existing runtime before allocating.
    await reconcile();
    if (owned) return Response.json({ runtime: maskRuntime(owned), state: "ready", reused: true });
    const spec = await pickEligibleSpec();
    const runtimeId = RUNTIME_PREFIX + crypto.randomUUID().slice(0, 8);
    let created: { status: number; json: any };
    try {
      created = await colabRequest("POST", `/v1beta/runtimes?runtimeId=${runtimeId}`, { runtimeSpec: spec });
    } catch (error) {
      uncertainCreate = true;
      throw error;
    }
    const { status, json } = created;
    if (status !== 200 && status !== 201) {
      if (status >= 500) uncertainCreate = true;
      throw colabError(status, json);
    }
    const name = `runtimes/${runtimeId}`;
    // Preserve the allocation handle even if connectionInfo polling fails.
    owned = { name, url: "", spec, adoptedAt: new Date().toISOString(), tokenExpireTime: "" };
    const deadline = Date.now() + CREATE_TIMEOUT_MS;
    for (;;) {
      const got = await colabRequest("GET", `/v1beta/${name}`);
      if (got.status === 200) {
        const url = got.json?.connectionInfo?.url;
        if (url) {
          owned = {
            name,
            url,
            spec: got.json?.runtimeSpec ?? spec,
            adoptedAt: new Date().toISOString(),
            tokenExpireTime: got.json?.connectionInfo?.expireTime ?? "",
          };
          console.log(`[rgm-gateway] lifecycle: runtime ready ${name} (${SPEC_ACCELERATOR} ${SPEC_SHAPE})`);
          return Response.json({ runtime: maskRuntime(owned), state: "ready" });
        }
      } else if (got.status !== 404) {
        throw colabError(got.status, got.json);
      }
      if (Date.now() > deadline) {
        throw new HttpError(504, "timeout", "runtime created but connectionInfo never appeared");
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  } finally {
    provisioning = false;
  }
}

async function statusRuntime(): Promise<Response> {
  if (owned) {
    // Refresh the short-lived proxy token and catch external deletion.
    const got = await colabRequest("GET", `/v1beta/${owned.name}`);
    if (got.status === 404) {
      owned = null; // deleted outside the gateway (e.g. Colab-side idle reaping)
    } else if (got.status !== 200) {
      throw colabError(got.status, got.json);
    } else {
      owned = {
        ...owned,
        url: got.json?.connectionInfo?.url ?? owned.url,
        tokenExpireTime: got.json?.connectionInfo?.expireTime ?? owned.tokenExpireTime,
      };
    }
  } else {
    await reconcile(); // adopt a runtime this gateway created before a restart
  }
  const remaining = idleMinutes > 0 ? Math.max(0, idleMinutes * 60_000 - (Date.now() - lastWorkAt)) : null;
  return Response.json({
    runtime: owned ? maskRuntime(owned) : null,
    state: provisioning || (owned && !owned.url) ? "starting" : owned ? "ready" : "offline",
    idle: {
      minutes: idleMinutes,
      lastWorkAt: new Date(lastWorkAt).toISOString(),
      remainingSeconds: remaining === null ? null : Math.round(remaining / 1000),
    },
  });
}

async function stopRuntime(): Promise<Response> {
  if (provisioning || bootstrapJob?.status === "running") return errJson(409, "provisioning_in_progress");
  if (!owned) return errJson(404, "no_owned_runtime");
  const name = owned.name;
  const { status, json } = await colabRequest("DELETE", `/v1beta/${name}`);
  if (status !== 200 && status !== 204 && status !== 404) throw colabError(status, json);
  // PRD R-06: status must confirm deletion, not merely a stop request.
  const check = await colabRequest("GET", `/v1beta/${name}`);
  if (check.status === 404) {
    owned = null;
    console.log(`[rgm-gateway] lifecycle: deleted ${name} (confirmed)`);
    return Response.json({ deleted: true, name, confirmed: true });
  }
  return Response.json(
    {
      deleted: false,
      name,
      confirmed: false,
      detail: "delete accepted but runtime still listed; recheck GET /gateway/v1/runtime",
    },
    { status: 202 },
  );
}

async function bootstrapRuntime(req: Request): Promise<Response> {
  if (!BOOTSTRAP_ENABLED) return errJson(403, "bootstrap_disabled");
  if (provisioning) return errJson(409, "provisioning_in_progress");
  if (!owned) return errJson(404, "no_owned_runtime");
  let body: any;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBounded(req, 8 * 1024 * 1024)));
  } catch {
    return errJson(400, "invalid_json");
  }
  const { ts_authkey, basic_user, basic_pass, state } = body ?? {};
  if (typeof ts_authkey !== "string" || typeof basic_user !== "string" ||
      !/^[^:\s]+$/.test(basic_user) || typeof basic_pass !== "string" || !basic_pass ||
      !state || typeof state !== "object" || Array.isArray(state) ||
      Object.values(state).some((v) => typeof v !== "string")) {
    return errJson(400, "bootstrap_input_invalid");
  }
  provisioning = true;
  try {
    const got = await colabRequest("GET", `/v1beta/${owned.name}`);
    if (got.status !== 200) throw colabError(got.status, got.json);
    const connection = got.json?.connectionInfo;
    if (typeof connection?.url !== "string" || typeof connection?.token !== "string") {
      return errJson(409, "connection_not_ready");
    }
    const result = await runBootstrap([BOOTSTRAP_PYTHON, BOOTSTRAP_SCRIPT], {
      runtime: { name: owned.name, connectionInfo: { url: connection.url, token: connection.token } },
      credentials: { TS_AUTHKEY: ts_authkey, BASIC_AUTH_USER: basic_user, BASIC_AUTH_PASS: basic_pass },
      state,
    });
    // Reuse the same URL allowlist and credential validation as manual adoption.
    const adopted = await handleControl(new Request("http://127.0.0.1/gateway/v1/upstream", {
      method: "PUT", headers: { Authorization: `Bearer ${CONTROL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: result.funnel, basic_auth: `${basic_user}:${basic_pass}` }),
    }), "/gateway/v1/upstream");
    if (!adopted.ok) return errJson(502, "bootstrap_endpoint_invalid");
    let workerHealthy = false;
    try {
      const rule = ROUTES.find((r) => r.method === "GET" && r.pattern.test("/system_stats"));
      if (rule) {
        const health = await fetchUpstream("/system_stats", { method: "GET", headers: upstreamHeaders() }, rule);
        workerHealthy = health.status >= 200 && health.status < 300;
      }
    } catch {
      // Return the identity even when the tunnel is not healthy yet so the
      // caller can save it before retrying or investigating.
    }
    noteWork();
    // The authenticated caller must put this node identity into the enclave.
    return Response.json({ ok: true, workerHealthy, upstream: GATEWAY_UPSTREAM, state: result.state },
      { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return errJson(502, "bootstrap_failed");
  } finally {
    provisioning = false;
  }
}

async function bootstrapControl(req: Request): Promise<Response> {
  if (!BOOTSTRAP_ENABLED) return errJson(403, "bootstrap_disabled");
  const headers = { "Cache-Control": "no-store" };
  if (req.method === "GET") {
    return Response.json(bootstrapJob ?? { status: "idle" }, { headers });
  }
  if (req.method === "DELETE") {
    if (bootstrapJob?.status === "running") return errJson(409, "provisioning_in_progress");
    bootstrapJob = null;
    return Response.json({ ok: true }, { headers });
  }
  if (req.method !== "POST") return errJson(405, "method_not_allowed");
  if (bootstrapJob) return errJson(409, "bootstrap_result_pending");
  bootstrapJob = { status: "running" };
  let input: ArrayBuffer;
  try {
    input = await readBounded(req, 8 * 1024 * 1024);
  } catch {
    bootstrapJob = null;
    return errJson(400, "bootstrap_input_invalid");
  }
  const privateRequest = new Request("http://127.0.0.1/", { method: "POST", body: input });
  void (async () => {
    try {
      const response = await bootstrapRuntime(privateRequest);
      bootstrapJob = { status: "finished", httpStatus: response.status, result: await response.json() };
    } catch {
      bootstrapJob = { status: "finished", httpStatus: 500, result: { error: "bootstrap_failed" } };
    }
  })();
  return Response.json({ status: "running" }, { status: 202, headers });
}

async function putCredentials(req: Request): Promise<Response> {
  let body: any;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBounded(req, 8192)));
  } catch {
    return errJson(400, "invalid_json");
  }
  const { client_id, client_secret, refresh_token } = body ?? {};
  if (![client_id, client_secret, refresh_token].every((v) => typeof v === "string" && v.length > 0)) {
    return errJson(400, "credentials_invalid");
  }
  creds = { clientId: client_id, clientSecret: client_secret, refreshToken: refresh_token };
  accessToken = null;
  console.log("[rgm-gateway] lifecycle: Colab credentials stored in memory (enclave custody per ADR-006)");
  return Response.json({ ok: true });
}

// PRD R-06 fixes the dashboard choices at 5/10/15/30 min or disabled. Values
// under one minute exist for tests and diagnostics; anything else is refused.
const PRD_IDLE_CHOICES = new Set([5, 10, 15, 30]);
function setIdle(body: any): Response {
  const minutes = body?.minutes;
  if (minutes === null || minutes === 0) {
    idleMinutes = 0;
    return Response.json({ idleMinutes: 0, idle: "disabled" });
  }
  if (
    typeof minutes !== "number" ||
    !Number.isFinite(minutes) ||
    minutes < 0.01 ||
    minutes > 1440 ||
    (minutes >= 1 && !PRD_IDLE_CHOICES.has(minutes))
  ) {
    return errJson(400, "idle_minutes_invalid");
  }
  idleMinutes = minutes;
  noteWork(); // a configuration change is operator intent, not idleness
  return Response.json({ idleMinutes });
}

async function handleRuntime(req: Request, path: string): Promise<Response> {
  if (path === "/gateway/v1/runtime/bootstrap") return bootstrapControl(req);
  if (path === "/gateway/v1/runtime/credentials") {
    if (req.method === "POST") return putCredentials(req);
    if (req.method === "DELETE") {
      creds = null;
      accessToken = null;
      console.log("[rgm-gateway] lifecycle: credentials cleared from memory");
      return Response.json({ ok: true, cleared: true });
    }
  }
  if (path === "/gateway/v1/runtime") {
    if (req.method === "POST") return startRuntime();
    if (req.method === "GET") return statusRuntime();
    if (req.method === "DELETE") return stopRuntime();
  }
  if (path === "/gateway/v1/runtime/idle" && req.method === "PUT") {
    let body: any;
    try {
      body = JSON.parse(new TextDecoder().decode(await readBounded(req, 4096)));
    } catch {
      return errJson(400, "invalid_json");
    }
    return setIdle(body);
  }
  return errJson(404, "route_not_allowed");
}

// Idle shutdown (PRD R-06): after N minutes without real work, release the
// owned runtime via the supported API. The queue is rechecked under the lock so
// a queued or running job always holds the runtime. Failure to verify keeps it.
if (LIFECYCLE_ENABLED) {
  setInterval(() => {
    void (async () => {
      try {
        if (!owned || idleMinutes <= 0 || provisioning || bootstrapJob?.status === "running") return;
        if (Date.now() - lastWorkAt < idleMinutes * 60_000) return;
        const queueRule = ROUTES.find((r) => r.method === "GET" && r.pattern.test("/queue"));
        if (!queueRule) return;
        // Same injected auth as the proxy path — a bare GET here returns 401.
        const q = await fetchUpstream("/queue", { method: "GET", headers: upstreamHeaders() }, queueRule);
        const j = JSON.parse(new TextDecoder().decode(q.body));
        const depth = (j.queue_running?.length ?? 0) + (j.queue_pending?.length ?? 0);
        if (depth > 0) {
          noteWork();
          return;
        }
        console.log(`[rgm-gateway] lifecycle: idle ${idleMinutes} min without work; deleting ${owned.name}`);
        await stopRuntime();
      } catch (err) {
        console.warn(`[rgm-gateway] lifecycle idle check skipped: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
      }
    })();
  }, IDLE_CHECK_MS);
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
        if (res.ok) noteWork(); // result retrieval is real work (PRD R-05)
        audit(req.method, path, res.status, ms());
        return res;
      }

      const upstream = await fetchUpstream(path + (req.method === "GET" ? url.search : ""), upstreamInit, rule);

      if (upstream.status >= 200 && upstream.status < 300 && isWorkRoute(req.method, path)) {
        noteWork(); // submission / result retrieval / authorized asset install
      }

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
      noteWork(); // an active execution session is real work (PRD R-05)
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
  `remote-gpu-manager gateway ${VERSION} on 127.0.0.1:${GATEWAY_PORT} -> ${GATEWAY_UPSTREAM} ` +
    `(auth: ${AUTHORIZATION ? "basic" : "NONE"}; lifecycle: ${LIFECYCLE_ENABLED ? "on" : "off (manual mode)"})`,
);
