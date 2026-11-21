// @bun
// host-gateway/gateway.ts
import { timingSafeEqual } from "crypto";
import { open, readFile, rename, unlink } from "fs/promises";

// host-gateway/bootstrap.ts
async function runBootstrap(command, request, timeoutMs = 30 * 60000) {
  const proc = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  try {
    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
    const reader = proc.stdout.getReader();
    const chunks = [];
    let size = 0;
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) {
        proc.kill();
        throw new Error("bootstrap_output_too_large");
      }
      chunks.push(value);
    }
    const exit = await proc.exited;
    if (exit !== 0)
      throw new Error("bootstrap_failed");
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (result?.ok !== true || typeof result.funnel !== "string" || !result.state || typeof result.state !== "object" || Array.isArray(result.state)) {
      throw new Error("bootstrap_invalid_response");
    }
    return { funnel: result.funnel, state: result.state };
  } catch {
    throw new Error("bootstrap_failed");
  } finally {
    clearTimeout(timeout);
    proc.kill();
  }
}

// host-gateway/gateway.ts
var VERSION = "0.2.0-m4";
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
var LIFECYCLE_ENABLED = (process.env.GATEWAY_LIFECYCLE ?? "") === "1";
var BOOTSTRAP_ENABLED = process.env.GATEWAY_BOOTSTRAP === "1";
var BOOTSTRAP_PYTHON = process.env.GATEWAY_BOOTSTRAP_PYTHON ?? "python3";
var BOOTSTRAP_SCRIPT = process.env.GATEWAY_BOOTSTRAP_SCRIPT ?? "tools/colab-bootstrap-worker.py";
var INTENT_FILE = process.env.RUNTIME_INTENT_FILE ?? "";
var COLAB_BASE = (process.env.COLAB_BASE ?? "https://colaboratory.googleapis.com").replace(/\/+$/, "");
var OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
var DRIVE_BASE = (process.env.DRIVE_BASE ?? "https://www.googleapis.com/drive/v3").replace(/\/+$/, "");
var RUNTIME_PREFIX = "rgm-gw-";
var SPEC_ACCELERATOR = process.env.RUNTIME_ACCELERATOR ?? "T4";
var SPEC_SHAPE = process.env.RUNTIME_SHAPE ?? "STANDARD";
var CREATE_TIMEOUT_MS = Number(process.env.RUNTIME_CREATE_TIMEOUT_MS ?? 300000);
var IDLE_CHECK_MS = Math.max(1000, Number(process.env.RUNTIME_IDLE_CHECK_MS ?? 30000));
var idleMinutes = Number(process.env.RUNTIME_IDLE_MINUTES ?? 10);
if (!Number.isFinite(idleMinutes) || idleMinutes < 0)
  idleMinutes = 10;
var upstreamUrl = new URL(GATEWAY_UPSTREAM);
if (upstreamUrl.protocol !== "http:" && upstreamUrl.protocol !== "https:") {
  throw new Error("GATEWAY_UPSTREAM must be http(s)");
}
var AUTHORIZATION = BASIC_AUTH.length > 0 ? `Basic ${Buffer.from(BASIC_AUTH, "utf8").toString("base64")}` : null;
var UPSTREAM_ALLOW = (process.env.GATEWAY_UPSTREAM_ALLOW ?? ".ts.net,.trycloudflare.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
var ALLOW_HTTP_UPSTREAM = (process.env.GATEWAY_UPSTREAM_ALLOW_HTTP ?? "") === "1";
var BODY_PROMPT = 1 * 1024 * 1024;
var BODY_QUEUE = 64 * 1024;
var BODY_UPLOAD = 100 * 1024 * 1024;
var ROUTES = [
  { method: "GET", pattern: /^\/system_stats$/, maxBytes: 16 * 1024, timeoutMs: 1e4, expectJson: true },
  { method: "GET", pattern: /^\/object_info(\/[A-Za-z0-9_]+)?$/, maxBytes: 64 * 1024 * 1024, timeoutMs: 120000, expectJson: true },
  { method: "POST", pattern: /^\/prompt$/, maxBytes: BODY_PROMPT, timeoutMs: 120000, expectJson: true },
  { method: "GET", pattern: /^\/history\/[0-9a-fA-F-]{36}$/, maxBytes: 4 * 1024 * 1024, timeoutMs: 60000, expectJson: true },
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
var audit = (method, path, status, ms, bytes) => {
  const size = typeof bytes === "number" ? ` bytes=${bytes}` : "";
  console.log(`${new Date().toISOString()} ${method} ${path} -> ${status} ${ms}ms${size}`);
};
async function proxyStreamingView(path, init, rule) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), rule.timeoutMs);
  let upstream;
  try {
    upstream = await fetch(GATEWAY_UPSTREAM + path, {
      ...init,
      signal: controller.signal,
      redirect: "manual"
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err;
    const detail = String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e?.name ?? "error").slice(0, 200);
    console.warn(`[rgm-gateway] ${path.split("?")[0]} upstream fetch failed: ${e?.name ?? "Error"} (${detail})`);
    if (e?.name === "AbortError")
      throw new HttpError(504, "upstream_timeout");
    throw new HttpError(502, "upstream_unreachable");
  }
  const contentType = (upstream.headers.get("content-type") ?? "application/octet-stream").split(";")[0];
  const declared = Number(upstream.headers.get("content-length") ?? "");
  const encoding = upstream.headers.get("content-encoding");
  const headers = { "Content-Type": contentType };
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
  const settle = (message) => {
    if (settled)
      return;
    settled = true;
    clearTimeout(timer);
    const total = declared > 0 ? `/${declared}` : "";
    console.log(`[rgm-gateway] /view body ${message} (${transferred}${total} bytes)`);
  };
  const stream = new ReadableStream({
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
          try {
            await reader.cancel("too large");
          } catch {}
          controller.error(new HttpError(502, "upstream_response_too_large"));
          settle("aborted: too large");
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        settle(`failed: ${String(err?.message ?? err).slice(0, 160)}`);
        try {
          controller.error(err);
        } catch {}
      }
    },
    cancel(reason) {
      settle(`cancelled by client: ${String(reason ?? "no reason").slice(0, 160)}`);
      try {
        reader.cancel(reason);
      } catch {}
    }
  });
  console.log(`[rgm-gateway] /view streaming ${upstream.status} (${declared > 0 ? `${declared} bytes` : "length unknown"})`);
  return new Response(stream, { status: upstream.status, headers });
}
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
  detail;
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
var errJson = (status, code) => Response.json({ error: code }, { status, headers: { "Content-Type": "application/json" } });
async function fetchUpstream(path, init, rule) {
  const maxAttempts = init.method === "GET" ? 3 : 1;
  for (let attempt = 1;attempt <= maxAttempts; attempt++) {
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
      const detailStr = String(detail).slice(0, 200);
      const retriable = e?.name !== "AbortError" && !/too large|invalid/i.test(detailStr);
      if (attempt < maxAttempts && retriable) {
        console.warn(`[rgm-gateway] upstream fetch failed (${detailStr}); retrying idempotent GET (${attempt}/${maxAttempts})`);
        await new Promise((r) => setTimeout(r, 250 * attempt));
        continue;
      }
      console.warn(`[rgm-gateway] upstream fetch failed: ${e?.name ?? "Error"} (${detailStr})`);
      if (e?.name === "AbortError")
        throw new HttpError(504, "upstream_timeout");
      throw new HttpError(502, "upstream_unreachable");
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HttpError(502, "upstream_unreachable");
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
  if (path.startsWith("/gateway/v1/runtime")) {
    if (!LIFECYCLE_ENABLED)
      return errJson(403, "lifecycle_disabled");
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
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(await readBounded(req, 8192)));
    } catch {
      return errJson(400, "invalid_json");
    }
    const raw = String(body?.url ?? "").trim();
    if (!raw)
      return errJson(400, "url_required");
    let parsed;
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
    console.log(`[rgm-gateway] upstream adopted: ${previous} -> ${GATEWAY_UPSTREAM} ` + `(auth: ${AUTHORIZATION ? "basic" : "NONE"})`);
    return Response.json({ ok: true, upstream: GATEWAY_UPSTREAM, auth: Boolean(AUTHORIZATION) });
  }
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
var creds = null;
var accessToken = null;
var owned = null;
var provisioning = false;
var stopping = false;
var workInFlight = 0;
var bootstrapJob = null;
var uncertainCreate = false;
var lastWorkAt = Date.now();
function noteWork() {
  lastWorkAt = Date.now();
}
function isWorkRoute(method, path) {
  if (method === "POST")
    return path === "/prompt" || path === "/upload/image";
  if (method === "GET")
    return path === "/view" || /^\/history\/[0-9a-fA-F-]{36}$/.test(path);
  return false;
}
async function ensureAccessToken() {
  if (accessToken && accessToken.expiresAt > Date.now() + 60000)
    return accessToken.value;
  if (!creds)
    throw new HttpError(401, "auth_required", "POST /gateway/v1/runtime/credentials first");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  if (!res.ok)
    throw new HttpError(401, "auth_required", "token refresh refused");
  const j = await res.json();
  if (!j.access_token)
    throw new HttpError(401, "auth_required", "token response had no access_token");
  accessToken = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 - 60000 };
  return accessToken.value;
}
async function colabRequest(method, path, body, timeoutMs = 30000) {
  for (let attempt = 0;attempt < 2; attempt++) {
    const token = await ensureAccessToken();
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(COLAB_BASE + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === "AbortError")
        throw new HttpError(504, "timeout");
      throw new HttpError(502, "offline");
    }
    clearTimeout(timer);
    if (res.status !== 401) {
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    }
    accessToken = null;
  }
  throw new HttpError(401, "auth_required");
}
function colabError(status, json) {
  const googleStatus = String(json?.error?.status ?? "");
  const message = String(json?.error?.message ?? "").slice(0, 200);
  if (status === 401 || status === 403)
    return new HttpError(401, "auth_required", message);
  if (status === 429)
    return new HttpError(429, "quota_exceeded", message);
  if (googleStatus === "FAILED_PRECONDITION")
    return new HttpError(403, "policy_restricted", message);
  if (status === 503 || googleStatus === "UNAVAILABLE")
    return new HttpError(503, "offline", message);
  return new HttpError(502, "colab_error", message);
}
async function eligibleGpuSpecs() {
  const { status, json } = await colabRequest("GET", "/v1beta/runtimespecs");
  if (status !== 200)
    throw colabError(status, json);
  if (!Array.isArray(json?.runtimeSpecs))
    throw new HttpError(502, "colab_invalid_response");
  return json.runtimeSpecs.filter((e) => e?.eligible === true && e?.key?.variant === "VARIANT_GPU" && typeof e.key.accelerator === "string" && /^[A-Z0-9_]{1,40}$/.test(e.key.accelerator) && typeof e.key.shape === "string" && /^SHAPE_[A-Z0-9_]{1,40}$/.test(e.key.shape)).map((e) => ({ variant: e.key.variant, accelerator: e.key.accelerator, shape: e.key.shape }));
}
async function pickEligibleSpec(accelerator, shape) {
  const hit = (await eligibleGpuSpecs()).find((e) => e.accelerator === accelerator && e.shape === shape);
  if (!hit) {
    throw new HttpError(403, "policy_restricted", `${accelerator} ${shape} is not eligible for this account right now`);
  }
  return hit;
}
function maskRuntime(r) {
  return {
    name: r.name,
    url: r.url,
    spec: r.spec,
    adoptedAt: r.adoptedAt,
    tokenExpiresAt: r.tokenExpireTime,
    tokenPresent: Boolean(r.url)
  };
}
async function reconcile() {
  if (!creds)
    return;
  const { status, json } = await colabRequest("GET", "/v1beta/runtimes");
  if (status !== 200)
    throw colabError(status, json);
  const mine = (json?.runtimes ?? []).filter((r) => r?.name?.startsWith(`runtimes/${RUNTIME_PREFIX}`));
  if (mine.length > 1) {
    throw new HttpError(409, "multiple_owned_runtimes", "Resolve multiple manager runtimes before continuing");
  }
  if (mine.length > 0) {
    const r = mine[0];
    if (INTENT_FILE) {
      try {
        const intent = JSON.parse(await readFile(INTENT_FILE, "utf8"));
        if (intent.name !== r.name)
          throw new Error("mismatch");
      } catch {
        throw new HttpError(409, "ownership_unverified", "Runtime does not match the persistent allocation intent");
      }
    }
    owned = {
      name: r.name,
      url: r.connectionInfo?.url ?? "",
      spec: r.runtimeSpec ?? { variant: "VARIANT_GPU", accelerator: SPEC_ACCELERATOR, shape: `SHAPE_${SPEC_SHAPE}` },
      adoptedAt: new Date().toISOString(),
      tokenExpireTime: r.connectionInfo?.expireTime ?? ""
    };
    console.log(`[rgm-gateway] lifecycle: adopted existing runtime ${owned.name}`);
  }
}
async function startRuntime(req) {
  if (provisioning || bootstrapJob?.status === "running")
    return errJson(409, "provisioning_in_progress");
  if (owned)
    return Response.json({ runtime: maskRuntime(owned), state: owned.url ? "ready" : "starting", reused: true });
  if (!creds)
    return errJson(401, "auth_required");
  if (uncertainCreate)
    return errJson(409, "allocation_uncertain");
  provisioning = true;
  try {
    let input = {};
    try {
      const body = new TextDecoder().decode(await readBounded(req, 4096));
      if (body)
        input = JSON.parse(body);
    } catch {
      return errJson(400, "invalid_json");
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      return errJson(400, "runtime_spec_invalid");
    const accelerator = input.accelerator ?? SPEC_ACCELERATOR;
    const shape = input.shape ?? `SHAPE_${SPEC_SHAPE}`;
    if (typeof accelerator !== "string" || !/^[A-Z0-9_]{1,40}$/.test(accelerator) || typeof shape !== "string" || !/^SHAPE_[A-Z0-9_]{1,40}$/.test(shape))
      return errJson(400, "runtime_spec_invalid");
    if ((accelerator !== "T4" || shape !== "SHAPE_STANDARD") && input.confirm_non_default !== true) {
      return errJson(400, "gpu_confirmation_required");
    }
    await reconcile();
    if (owned)
      return Response.json({ runtime: maskRuntime(owned), state: "ready", reused: true });
    if (INTENT_FILE) {
      try {
        await readFile(INTENT_FILE, "utf8");
        return errJson(409, "allocation_uncertain");
      } catch (error) {
        if (error.code !== "ENOENT")
          throw new Error("intent_unavailable");
      }
    }
    const spec = await pickEligibleSpec(accelerator, shape);
    const runtimeId = RUNTIME_PREFIX + crypto.randomUUID().slice(0, 8);
    if (INTENT_FILE) {
      try {
        const file = await open(INTENT_FILE, "wx", 384);
        try {
          await file.writeFile(JSON.stringify({ name: `runtimes/${runtimeId}` }));
          await file.sync();
        } finally {
          await file.close();
        }
      } catch (error) {
        if (error.code === "EEXIST")
          return errJson(409, "allocation_uncertain");
        throw new Error("intent_unavailable");
      }
    }
    let created;
    try {
      created = await colabRequest("POST", `/v1beta/runtimes?runtimeId=${runtimeId}`, { runtimeSpec: spec });
    } catch (error) {
      uncertainCreate = true;
      throw error;
    }
    const { status, json } = created;
    if (status !== 200 && status !== 201) {
      if (status >= 500 || status === 408)
        uncertainCreate = true;
      else if (INTENT_FILE)
        await unlink(INTENT_FILE);
      throw colabError(status, json);
    }
    const name = `runtimes/${runtimeId}`;
    owned = { name, url: "", spec, adoptedAt: new Date().toISOString(), tokenExpireTime: "" };
    const deadline = Date.now() + CREATE_TIMEOUT_MS;
    for (;; ) {
      const got = await colabRequest("GET", `/v1beta/${name}`);
      if (got.status === 200) {
        const url = got.json?.connectionInfo?.url;
        if (url) {
          owned = {
            name,
            url,
            spec: got.json?.runtimeSpec ?? spec,
            adoptedAt: new Date().toISOString(),
            tokenExpireTime: got.json?.connectionInfo?.expireTime ?? ""
          };
          console.log(`[rgm-gateway] lifecycle: runtime ready ${name} (${spec.accelerator} ${spec.shape})`);
          return Response.json({ runtime: maskRuntime(owned), state: "ready" });
        }
      } else if (got.status !== 404) {
        throw colabError(got.status, got.json);
      }
      if (Date.now() > deadline) {
        throw new HttpError(504, "timeout", "runtime created but connectionInfo never appeared");
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  } finally {
    provisioning = false;
  }
}
async function statusRuntime() {
  if (owned) {
    const got = await colabRequest("GET", `/v1beta/${owned.name}`);
    if (got.status === 404) {
      owned = null;
    } else if (got.status !== 200) {
      throw colabError(got.status, got.json);
    } else {
      owned = {
        ...owned,
        url: got.json?.connectionInfo?.url ?? owned.url,
        tokenExpireTime: got.json?.connectionInfo?.expireTime ?? owned.tokenExpireTime
      };
    }
  } else {
    await reconcile();
  }
  const remaining = idleMinutes > 0 ? Math.max(0, idleMinutes * 60000 - (Date.now() - lastWorkAt)) : null;
  return Response.json({
    runtime: owned ? maskRuntime(owned) : null,
    state: provisioning || owned && !owned.url ? "starting" : owned ? "ready" : "offline",
    idle: {
      minutes: idleMinutes,
      lastWorkAt: new Date(lastWorkAt).toISOString(),
      remainingSeconds: remaining === null ? null : Math.round(remaining / 1000)
    }
  });
}
async function recoverAllocation(req) {
  if (provisioning || stopping || bootstrapJob?.status === "running")
    return errJson(409, "provisioning_in_progress");
  if (!creds)
    return errJson(401, "auth_required");
  if (!INTENT_FILE)
    return errJson(409, "recovery_intent_required");
  let input;
  try {
    input = JSON.parse(new TextDecoder().decode(await readBounded(req, 4096)));
  } catch {
    return errJson(400, "recovery_confirmation_required");
  }
  if (input?.confirmed !== true)
    return errJson(400, "recovery_confirmation_required");
  provisioning = true;
  try {
    let raw;
    try {
      raw = await readFile(INTENT_FILE, "utf8");
    } catch {
      return errJson(409, "recovery_intent_required");
    }
    let name;
    try {
      name = JSON.parse(raw).name;
    } catch {
      return errJson(409, "recovery_intent_invalid");
    }
    if (typeof name !== "string" || !/^runtimes\/rgm-gw-[a-zA-Z0-9-]+$/.test(name))
      return errJson(409, "recovery_intent_invalid");
    const listed = await colabRequest("GET", "/v1beta/runtimes");
    if (listed.status !== 200)
      throw colabError(listed.status, listed.json);
    if (!listed.json || typeof listed.json !== "object" || Array.isArray(listed.json) || listed.json.runtimes !== undefined && !Array.isArray(listed.json.runtimes) || listed.json.nextPageToken)
      return errJson(502, "colab_invalid_response");
    const runtimes = listed.json.runtimes ?? [];
    if (runtimes.some((r) => r?.name?.startsWith(`runtimes/${RUNTIME_PREFIX}`)))
      return errJson(409, "recovery_runtime_present");
    const exact = await colabRequest("GET", `/v1beta/${name}`);
    if (exact.status === 200)
      return errJson(409, "recovery_runtime_present");
    if (exact.status !== 404)
      throw colabError(exact.status, exact.json);
    if (await readFile(INTENT_FILE, "utf8") !== raw)
      return errJson(409, "recovery_intent_changed");
    await rename(INTENT_FILE, `${INTENT_FILE}.resolved-${crypto.randomUUID()}`);
    owned = null;
    uncertainCreate = false;
    return Response.json({ recovered: true });
  } finally {
    provisioning = false;
  }
}
async function queueIsIdle() {
  const rule = ROUTES.find((r) => r.method === "GET" && r.pattern.test("/queue"));
  if (!rule)
    throw new Error("queue_unavailable");
  const q = await fetchUpstream("/queue", { method: "GET", headers: upstreamHeaders() }, rule);
  if (q.status < 200 || q.status >= 300)
    throw new Error("queue_unavailable");
  const data = JSON.parse(new TextDecoder().decode(q.body));
  if (!Array.isArray(data.queue_running) || !Array.isArray(data.queue_pending))
    throw new Error("queue_unavailable");
  return data.queue_running.length === 0 && data.queue_pending.length === 0;
}
async function stopRuntime(force = false) {
  if (provisioning || bootstrapJob?.status === "running" || stopping)
    return errJson(409, "provisioning_in_progress");
  if (!owned)
    return errJson(404, "no_owned_runtime");
  stopping = true;
  try {
    if (!force) {
      if (workInFlight)
        return errJson(409, "runtime_busy");
      const observedWork = lastWorkAt;
      try {
        if (!await queueIsIdle())
          return errJson(409, "runtime_busy");
      } catch {
        return errJson(409, "queue_unavailable");
      }
      if (lastWorkAt !== observedWork || workInFlight)
        return errJson(409, "runtime_busy");
    }
    const name = owned.name;
    const { status, json } = await colabRequest("DELETE", `/v1beta/${name}`);
    if (status !== 200 && status !== 204 && status !== 404)
      throw colabError(status, json);
    const check = await colabRequest("GET", `/v1beta/${name}`);
    if (check.status === 404) {
      owned = null;
      if (INTENT_FILE) {
        try {
          const intent = JSON.parse(await readFile(INTENT_FILE, "utf8"));
          if (intent.name === name)
            await unlink(INTENT_FILE);
        } catch (error) {
          if (error.code !== "ENOENT")
            console.warn("[rgm-gateway] lifecycle: intent cleanup failed");
        }
      }
      console.log(`[rgm-gateway] lifecycle: deleted ${name} (confirmed)`);
      return Response.json({ deleted: true, name, confirmed: true });
    }
    return Response.json({
      deleted: false,
      name,
      confirmed: false,
      detail: "delete accepted but runtime still listed; recheck GET /gateway/v1/runtime"
    }, { status: 202 });
  } finally {
    stopping = false;
  }
}
async function validateWorkbook(workbook) {
  if (!workbook || typeof workbook.content !== "string" || new TextEncoder().encode(workbook.content).byteLength > 1024 * 1024 || typeof workbook.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(workbook.sha256))
    return false;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(workbook.content));
  const actual = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== workbook.sha256)
    return false;
  try {
    const notebook = JSON.parse(workbook.content);
    if (!Array.isArray(notebook?.cells) || notebook.cells.length > 100 || ![2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 25].every((i) => notebook.cells[i]?.cell_type === "code" && Array.isArray(notebook.cells[i].source) && notebook.cells[i].source.every((line) => typeof line === "string")))
      return false;
    const marker = 'USE_DRIVE = True # @param {type:"boolean"}';
    return notebook.cells[4].source.join("").split(marker).length === 2;
  } catch {
    return false;
  }
}
async function bootstrapRuntime(req) {
  if (!BOOTSTRAP_ENABLED)
    return errJson(403, "bootstrap_disabled");
  if (provisioning)
    return errJson(409, "provisioning_in_progress");
  if (!owned)
    return errJson(404, "no_owned_runtime");
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBounded(req, 8 * 1024 * 1024)));
  } catch {
    return errJson(400, "invalid_json");
  }
  const { ts_authkey, basic_user, basic_pass, state, drive_files, workbook } = body ?? {};
  if (!await validateWorkbook(workbook))
    return errJson(400, "workbook_invalid");
  if (typeof ts_authkey !== "string" || typeof basic_user !== "string" || !/^[^:\s]+$/.test(basic_user) || typeof basic_pass !== "string" || !basic_pass || !state || typeof state !== "object" || Array.isArray(state) || Object.values(state).some((v) => typeof v !== "string")) {
    return errJson(400, "bootstrap_input_invalid");
  }
  provisioning = true;
  try {
    const got = await colabRequest("GET", `/v1beta/${owned.name}`);
    if (got.status !== 200)
      throw colabError(got.status, got.json);
    const connection = got.json?.connectionInfo;
    if (typeof connection?.url !== "string" || typeof connection?.token !== "string") {
      return errJson(409, "connection_not_ready");
    }
    const result = await runBootstrap([BOOTSTRAP_PYTHON, BOOTSTRAP_SCRIPT], {
      runtime: { name: owned.name, connectionInfo: { url: connection.url, token: connection.token } },
      workbook,
      credentials: { TS_AUTHKEY: ts_authkey, BASIC_AUTH_USER: basic_user, BASIC_AUTH_PASS: basic_pass },
      state,
      ...Array.isArray(drive_files) && drive_files.length ? { drive: { token: await ensureAccessToken(), files: drive_files } } : {}
    });
    const adopted = await handleControl(new Request("http://127.0.0.1/gateway/v1/upstream", {
      method: "PUT",
      headers: { Authorization: `Bearer ${CONTROL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: result.funnel, basic_auth: `${basic_user}:${basic_pass}` })
    }), "/gateway/v1/upstream");
    if (!adopted.ok) {
      return Response.json({ ok: true, workerHealthy: false, error: "bootstrap_endpoint_invalid", state: result.state }, { headers: { "Cache-Control": "no-store" } });
    }
    let workerHealthy = false;
    try {
      const rule = ROUTES.find((r) => r.method === "GET" && r.pattern.test("/system_stats"));
      if (rule) {
        const health = await fetchUpstream("/system_stats", { method: "GET", headers: upstreamHeaders() }, rule);
        workerHealthy = health.status >= 200 && health.status < 300;
      }
    } catch {}
    noteWork();
    return Response.json({ ok: true, workerHealthy, upstream: GATEWAY_UPSTREAM, state: result.state }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof HttpError)
      throw err;
    return errJson(502, "bootstrap_failed");
  } finally {
    provisioning = false;
  }
}
async function bootstrapControl(req) {
  if (!BOOTSTRAP_ENABLED)
    return errJson(403, "bootstrap_disabled");
  const headers = { "Cache-Control": "no-store" };
  if (req.method === "GET") {
    return Response.json({ ...bootstrapJob ?? { status: "idle" }, workbook_transfer: 1 }, { headers });
  }
  if (req.method === "DELETE") {
    if (bootstrapJob?.status === "running")
      return errJson(409, "provisioning_in_progress");
    bootstrapJob = null;
    return Response.json({ ok: true }, { headers });
  }
  if (req.method !== "POST")
    return errJson(405, "method_not_allowed");
  if (bootstrapJob)
    return errJson(409, "bootstrap_result_pending");
  bootstrapJob = { status: "running" };
  let input;
  try {
    input = await readBounded(req, 8 * 1024 * 1024);
  } catch {
    bootstrapJob = null;
    return errJson(400, "bootstrap_input_invalid");
  }
  const privateRequest = new Request("http://127.0.0.1/", { method: "POST", body: input });
  (async () => {
    try {
      const response = await bootstrapRuntime(privateRequest);
      bootstrapJob = { status: "finished", httpStatus: response.status, result: await response.json() };
    } catch {
      bootstrapJob = { status: "finished", httpStatus: 500, result: { error: "bootstrap_failed" } };
    }
  })();
  return Response.json({ status: "running" }, { status: 202, headers });
}
async function putCredentials(req) {
  let body;
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
var PRD_IDLE_CHOICES = new Set([5, 10, 15, 30]);
function setIdle(body) {
  const minutes = body?.minutes;
  if (minutes === null || minutes === 0) {
    idleMinutes = 0;
    return Response.json({ idleMinutes: 0, idle: "disabled" });
  }
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0.01 || minutes > 1440 || minutes >= 1 && !PRD_IDLE_CHOICES.has(minutes)) {
    return errJson(400, "idle_minutes_invalid");
  }
  idleMinutes = minutes;
  noteWork();
  return Response.json({ idleMinutes });
}
async function handleRuntime(req, path) {
  if (path === "/gateway/v1/runtime/workbook-check" && req.method === "POST") {
    try {
      const body = JSON.parse(new TextDecoder().decode(await readBounded(req, 2 * 1024 * 1024)));
      return await validateWorkbook(body?.workbook) ? Response.json({ ok: true }) : errJson(400, "workbook_invalid");
    } catch {
      return errJson(400, "workbook_invalid");
    }
  }
  if (path === "/gateway/v1/runtime/bootstrap")
    return bootstrapControl(req);
  if (path === "/gateway/v1/runtime/specs" && req.method === "GET") {
    return Response.json({ specs: await eligibleGpuSpecs() });
  }
  if (path === "/gateway/v1/runtime/cache-check" && req.method === "POST") {
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(await readBounded(req, 16384)));
    } catch {
      return errJson(400, "invalid_json");
    }
    const files = body?.files;
    if (!Array.isArray(files) || !files.length || files.length > 16 || files.some((f) => typeof f?.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(f.id) || typeof f.name !== "string" || !/^[A-Za-z0-9._-]+\.safetensors$/.test(f.name))) {
      return errJson(400, "drive_selection_invalid");
    }
    const token = await ensureAccessToken();
    for (const file of files) {
      const url = `${DRIVE_BASE}/files/${encodeURIComponent(file.id)}?fields=id,name,size,md5Checksum`;
      let response;
      try {
        response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
      } catch {
        return errJson(502, "drive_unreachable");
      }
      if (!response.ok)
        return errJson(403, "drive_access_required");
      let metadata;
      try {
        metadata = await response.json();
      } catch {
        return errJson(502, "drive_invalid_response");
      }
      if (metadata.name !== file.name || !metadata.size || !metadata.md5Checksum)
        return errJson(409, "drive_file_mismatch");
    }
    return Response.json({ ok: true, count: files.length });
  }
  if (path === "/gateway/v1/runtime/recover" && req.method === "POST")
    return recoverAllocation(req);
  if (path === "/gateway/v1/runtime/credentials") {
    if (req.method === "POST")
      return putCredentials(req);
    if (req.method === "DELETE") {
      creds = null;
      accessToken = null;
      console.log("[rgm-gateway] lifecycle: credentials cleared from memory");
      return Response.json({ ok: true, cleared: true });
    }
  }
  if (path === "/gateway/v1/runtime") {
    if (req.method === "POST")
      return startRuntime(req);
    if (req.method === "GET")
      return statusRuntime();
    if (req.method === "DELETE")
      return stopRuntime(new URL(req.url).searchParams.get("force") === "1");
  }
  if (path === "/gateway/v1/runtime/idle" && req.method === "PUT") {
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(await readBounded(req, 4096)));
    } catch {
      return errJson(400, "invalid_json");
    }
    return setIdle(body);
  }
  return errJson(404, "route_not_allowed");
}
if (LIFECYCLE_ENABLED) {
  setInterval(() => {
    (async () => {
      try {
        if (!owned || idleMinutes <= 0 || provisioning || bootstrapJob?.status === "running")
          return;
        if (Date.now() - lastWorkAt < idleMinutes * 60000)
          return;
        if (!await queueIsIdle()) {
          noteWork();
          return;
        }
        console.log(`[rgm-gateway] lifecycle: idle ${idleMinutes} min without work; deleting ${owned.name}`);
        await stopRuntime();
      } catch (err) {
        console.warn(`[rgm-gateway] lifecycle idle check skipped: ${String(err?.message ?? err).slice(0, 120)}`);
      }
    })();
  }, IDLE_CHECK_MS);
}
var server = Bun.serve({
  hostname: "127.0.0.1",
  port: GATEWAY_PORT,
  idleTimeout: 255,
  async fetch(req, server) {
    const started = Date.now();
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const ms = () => Date.now() - started;
    let countedWork = false;
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
      if (isWorkRoute(req.method, path)) {
        if (stopping)
          return errJson(503, "runtime_stopping");
        workInFlight++;
        countedWork = true;
        noteWork();
      }
      const body = req.method === "POST" ? new Uint8Array(await readBounded(req, rule.maxBytes)) : undefined;
      const contentType = req.headers.get("content-type") ?? "application/json";
      const upstreamInit = {
        method: req.method,
        headers: upstreamHeaders(body ? { "Content-Type": contentType } : {}),
        body
      };
      if (path === "/view") {
        const res = await proxyStreamingView(path + url.search, upstreamInit, rule);
        if (res.ok)
          noteWork();
        audit(req.method, path, res.status, ms());
        if (countedWork && res.body) {
          const reader = res.body.getReader();
          let released = false;
          const release = () => {
            if (!released) {
              released = true;
              workInFlight--;
              noteWork();
            }
          };
          const stream = new ReadableStream({
            async pull(controller) {
              try {
                const chunk = await reader.read();
                if (chunk.done) {
                  release();
                  controller.close();
                } else
                  controller.enqueue(chunk.value);
              } catch (error) {
                release();
                controller.error(error);
              }
            },
            async cancel(reason) {
              try {
                await reader.cancel(reason);
              } finally {
                release();
              }
            }
          });
          countedWork = false;
          return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
        }
        return res;
      }
      const upstream = await fetchUpstream(path + (req.method === "GET" ? url.search : ""), upstreamInit, rule);
      if (upstream.status >= 200 && upstream.status < 300 && isWorkRoute(req.method, path)) {
        noteWork();
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
        headers: resHeaders
      });
      audit(req.method, path, upstream.status, ms(), upstream.body.byteLength);
      return res;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : "gateway_error";
      const res = errJson(status, code);
      audit(req.method, path, status, ms());
      return res;
    } finally {
      if (countedWork)
        workInFlight--;
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
          const data = event.data;
          const bytes = typeof data === "string" ? new TextEncoder().encode(data).length : data?.byteLength ?? 0;
          const preview = typeof data === "string" ? data.slice(0, 80) : `binary ${bytes}B`;
          console.log(`[rgm-gateway] upstream ws message clientId=${clientId} bytes=${bytes} preview=${preview}`);
          ws.send(data);
        } catch {}
      });
    },
    message(ws, message) {
      noteWork();
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
console.log(`remote-gpu-manager gateway ${VERSION} on 127.0.0.1:${GATEWAY_PORT} -> ${GATEWAY_UPSTREAM} ` + `(auth: ${AUTHORIZATION ? "basic" : "NONE"}; lifecycle: ${LIFECYCLE_ENABLED ? "on" : "off (manual mode)"})`);
