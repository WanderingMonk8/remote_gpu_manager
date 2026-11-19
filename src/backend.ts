/**
 * Remote GPU Manager — Spindle backend.
 *
 * Responsibilities (current scope: M2/Vast offers + instances):
 *  - Report the status of the loopback host gateway and the upstream worker to the
 *    frontend panel.
 *  - Store the user's Vast.ai API key in the Spindle Secure Enclave (AES-256-GCM,
 *    per-user).
 *
 *  - Authorized Vast.ai actions: offer search (read-only), instance list (read-only),
 *    start/stop (PUT state), destroy (DELETE, requires approved:true), instance logs
 *    (PUT request_logs + result_url poll), and one paid action — deploying an offer
 *    (PUT asks/{offer_id}/, requires approved:true and a price cap from the
 *    user-facing confirm panel).
 *  - The API key is NEVER logged, NEVER persisted to regular storage, and NEVER
 *    returned to the frontend; only whitelisted verdicts/display fields leak back.
 */

declare const spindle: import("lumiverse-spindle-types").SpindleAPI;

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8189";
const ENCLAVE_KEY = "vast.api_key";
// Redundant persistence — userStorage (survives reinstall) preferred, but extension storage is the
// proven fallback; if both throw we keep going with in-memory defaults rather than killing the worker.
async function durableReadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const u: any = await spindle.userStorage.getJson<T | null>(path, { fallback: null as any });
    if (u !== null && u !== undefined) return u as T;
  } catch (err) {
    spindle.log?.info?.(`durableReadJson userStorage failed (${path}): ${String(err)}`);
  }
  try {
    const legacy: any = await spindle.storage.getJson<T | null>(path, { fallback: null as any });
    if (legacy !== null && legacy !== undefined) return legacy as T;
  } catch (err) {
    spindle.log?.info?.(`durableReadJson storage failed (${path}): ${String(err)}`);
  }
  return fallback;
}
async function durableWriteJson(path: string, value: unknown): Promise<void> {
  try {
    await spindle.userStorage.setJson(path, value);
    return;
  } catch (err) {
    spindle.log?.info?.(`durableWriteJson userStorage failed (${path}): ${String(err)}`);
  }
  try {
    await spindle.storage.setJson(path, value);
  } catch (err) {
    spindle.log?.info?.(`durableWriteJson storage failed (${path}): ${String(err)}`);
  }
}
const FAILED_HOSTS_KEY = "failed-hosts.json";
const ABSOLUTE_MAX_FAILED_HOSTS = 256;
const MODEL_SELECTION_KEY = "model-selection.json";
const VALID_MODEL_IDS = new Set([
  "anima-turbo-1.1", "anima-turbo-1.0", "anima-base-1.0",
  "anima-aesthetic-1.1", "anima-aesthetic-1.0", "anima-aesthetic-1.0b",
  "anima-preview", "anima-preview2", "anima-preview3-base",
  "moss-sft-int8", "moss-base-int8", "moss-sft-bf16", "moss-base-bf16", "adapter-ref",
]);
const DEFAULT_MODEL_SELECTION = ["anima-turbo-1.1", "anima-aesthetic-1.1", "moss-sft-int8", "moss-base-int8", "adapter-ref"];
async function getFailedHosts(): Promise<number[]> {
  const saved = await durableReadJson<{ hosts?: number[] }>(FAILED_HOSTS_KEY, { hosts: [] });
  const list = Array.isArray(saved?.hosts) ? saved.hosts : [];
  return list.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}
async function addFailedHost(machineId: number): Promise<number[]> {
  const hosts = await getFailedHosts();
  if (!hosts.includes(machineId)) hosts.unshift(machineId);
  const trimmed = hosts.slice(0, ABSOLUTE_MAX_FAILED_HOSTS);
  await durableWriteJson(FAILED_HOSTS_KEY, { hosts: trimmed });
  return trimmed;
}
async function clearFailedHosts(): Promise<void> {
  await durableWriteJson(FAILED_HOSTS_KEY, { hosts: [] });
}
/** Hard guarantee against accidental double deploys (user double-click, replay, both UI paths). */
let deployInFlight = false;
const LIMITS_KEY = "instance-limits.json";
const ABSOLUTE_MAX_INSTANCES = 8;
async function getMaxInstances(): Promise<number> {
  const saved = await durableReadJson<{ maxInstances?: number }>(LIMITS_KEY, { maxInstances: 1 });
  const n = Number(saved?.maxInstances);
  if (!Number.isFinite(n)) return 1;
  return Math.min(ABSOLUTE_MAX_INSTANCES, Math.max(1, Math.floor(n)));
}

async function getGatewayUrl(): Promise<string> {
  const saved = await durableReadJson<{ url?: string }>("gateway-url.json", {});
  return saved.url ?? DEFAULT_GATEWAY_URL;
}

async function probe(path: string, headers: Record<string, string> = {}): Promise<{
  ok: boolean;
  status: number;
  body?: unknown;
}> {
  const base = await getGatewayUrl();
  try {
    const res = await spindle.cors(base + path, { method: "GET", headers });
    let body: unknown;
    try {
      body = JSON.parse(res.body);
    } catch {
      body = undefined;
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { error: String(err) } };
  }
}

async function vastProbe(key: string): Promise<{ ok: boolean; status: number; body?: unknown }> {
  // Read-only search with a tiny offer limit. No creation, no billing action.
  try {
    const res = await spindle.cors(
      "https://console.vast.ai/api/v0/bundles",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: 1,
          type: "on-demand",
          allocated_storage: 5,
        }),
      },
    );
    let body: unknown;
    try {
      body = JSON.parse(res.body);
    } catch {
      body = undefined;
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { error: String(err) } };
  }
}

interface VastCallResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

/**
 * Translate the extension's friendly env string into the dict shape vast actually consumes:
 *   "-p 8188 -p 8080/tcp -e lumiverse_models=a,b" -> { "-p 8188": "1", "lumiverse_models": "a,b" }
 * Anything unparseable is dropped with a log line rather than silently ignored.
 */
function parseVastEnv(input: string | undefined): Record<string, string> | undefined {
  if (!input) return undefined;
  const out: Record<string, string> = {};
  const tokens = input.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "-p" || tok === "-v" || tok === "-n") {
      const val = tokens[++i];
      if (val && /^[0-9a-z:/_]+$/i.test(val)) out[`${tok} ${val}`] = "1";
      else spindle.log.info(`vast_deploy_offer: dropping unparsable ${tok} ${val ?? ""}`);
      continue;
    }
    if (tok === "-e") {
      const kv = tokens[++i];
      const eq = kv?.indexOf("=") ?? -1;
      if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1).replace(/^['"]|['"]$/g, "");
      continue;
    }
    // bare KEY=VALUE token — vast passes through as-is ("VAR=value")
    if (tok.includes("=") && !tok.startsWith("-")) {
      const eq = tok.indexOf("=");
      const key = tok.slice(0, eq);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        out[key] = tok.slice(eq + 1).replace(/^['"]|['"]$/g, "");
        continue;
      }
    }
    if (tok.startsWith("-")) spindle.log.info(`vast_deploy_offer: dropping unrecognized env token ${tok}`);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Ask→instance creation step lives in-line in the deploy branch (paid action, requires approval). */
async function vastApi(apiKey: string, method: "GET" | "POST" | "PUT" | "DELETE", path: string, jsonBody?: unknown): Promise<VastCallResult> {
  try {
    const res = await spindle.cors(
      `https://console.vast.ai${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
      },
    );
    let body: unknown;
    try {
      body = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      body = undefined;
    }
    if (res.status < 200 || res.status >= 300) {
      const b: any = body;
      const detail = b?.msg ?? b?.detail ?? b?.error ?? `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: String(detail), body };
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

/** Whitelisted, display-safe instance view — raw rows (may carry jupyter tokens) never leave this process. */
function sanitizeInstance(raw: any) {
  if (!raw || typeof raw !== "object") return null;
  const status = raw.actual_status ?? raw.cur_state ?? raw.status ?? raw.state ?? "unknown";
  const started = Number(raw.start_date ?? 0) || null;
  return {
    id: Number(raw.id) || 0,
    label: typeof raw.label === "string" ? raw.label.slice(0, 64) : null,
    gpuName: typeof raw.gpu_name === "string" ? raw.gpu_name : null,
    gpuCount: Number(raw.num_gpus ?? 1) || 1,
    gpuRamMB: Number(raw.gpu_ram ?? 0) || null,
    cpuRamMB: Number(raw.cpu_ram ?? 0) || null,
    vramGB: raw.gpu_ram ? Math.round((Number(raw.gpu_ram) / 1024) * 10) / 10 : null,
    status: String(status),
    intendedStatus: raw.intended_status ?? null,
    dphTotal: typeof raw.dph_total === "number" ? raw.dph_total : Number(raw.dph_total) || null,
    startDate: started,
    uptimeMins: typeof raw.uptime_mins === "number" ? raw.uptime_mins : (started ? Math.max(0, Math.floor((Date.now() / 1000 - started) / 60)) : null),
    machineId: raw.machine_id ?? null,
    geolocation: typeof raw.geolocation === "string" ? raw.geolocation : null,
    diskUsageGB: typeof raw.disk_usage === "number" ? raw.disk_usage : (Number(raw.disk_usage) || null),
  };
}

async function vastListInstances(apiKey: string) {
  const out: any[] = [];
  let token: string | undefined;
  for (let page = 0; page < 3; page++) {
    const qs = token ? `?limit=64&after_token=${encodeURIComponent(token)}` : "?limit=64";
    const res = await vastApi(apiKey, "GET", `/api/v1/instances/${qs}`);
    if (!res.ok) throw new Error(res.error ?? `HTTP ${res.status}`);
    const b: any = res.body;
    const rows: any[] = Array.isArray(b) ? b : Array.isArray(b?.instances) ? b.instances : [];
    out.push(...rows);
    token = typeof b?.next_token === "string" && b.next_token ? b.next_token : undefined;
    if (!token) break;
  }
  return out.map(sanitizeInstance).filter((x): x is NonNullable<typeof x> => !!x && x.id > 0);
}

spindle.onFrontendMessage(async (payload: any, userId?: string) => {
  try {
    await handleFrontendMessage(payload, userId);
  } catch (err) {
    // Never let an unhandled rejection kill the runtime — surface it instead.
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    spindle.log?.info?.(`backend handler error (${payload?.type ?? "?"}): ${msg}`);
    try {
      spindle.sendToFrontend({ type: "backend_error", requestType: payload?.type ?? null, error: msg }, userId);
    } catch { /* last-ditch: even sendToFrontend can fail; swallow */ }
  }
});
void handleFrontendMessage;
async function handleFrontendMessage(payload: any, userId?: string): Promise<void> {
  if (payload?.type === "set_gateway_url" && typeof payload.url === "string") {
    const url = payload.url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[A-Za-z0-9._:[\]-]+$/.test(url)) {
      spindle.sendToFrontend({ type: "gateway_url_error", error: "URL must be http(s)://host[:port]" }, userId);
      return;
    }
    await durableWriteJson("gateway-url.json", { url });
    spindle.sendToFrontend({ type: "gateway_url_saved", url }, userId);
    return;
  }

  if (payload?.type === "status") {
    const gateway = await probe("/gateway/v1/status");
    const upstream = await probe("/system_stats");
    spindle.sendToFrontend({ type: "status", gateway: { ...gateway }, upstream: { ...upstream } }, userId);
    return;
  }

  // Blacklist a host (machine_id) — used by the UI after a failed instance on that host.
  // Blacklisted hosts are excluded from fallback-race candidates (never the primary search list).
  if (payload?.type === "vast_blacklist_host" && typeof payload.machineId === "number" && payload.machineId > 0) {
    const hosts = await addFailedHost(Math.floor(payload.machineId));
    spindle.sendToFrontend({ type: "vast_blacklist_host_result", ok: true, machineId: Math.floor(payload.machineId), count: hosts.length }, userId);
    return;
  }
  if (payload?.type === "vast_list_failed_hosts") {
    const hosts = await getFailedHosts();
    spindle.sendToFrontend({ type: "vast_list_failed_hosts_result", ok: true, hosts }, userId);
    return;
  }
  if (payload?.type === "vast_clear_failed_hosts") {
    await clearFailedHosts();
    spindle.sendToFrontend({ type: "vast_clear_failed_hosts_result", ok: true }, userId);
    return;
  }

  // Persisted (global) model selection. Must match the worker's registry — unknown IDs are rejected.
  if (payload?.type === "vast_get_model_selection") {
    const saved = await durableReadJson<{ ids?: string[] }>(MODEL_SELECTION_KEY, { ids: DEFAULT_MODEL_SELECTION });
    const ids = Array.isArray(saved?.ids) ? saved.ids.filter((i) => VALID_MODEL_IDS.has(i)) : DEFAULT_MODEL_SELECTION;
    spindle.sendToFrontend({ type: "vast_get_model_selection_result", ok: true, ids: ids.length ? ids : DEFAULT_MODEL_SELECTION }, userId);
    return;
  }
  if (payload?.type === "vast_set_model_selection") {
    const raw = (payload.ids ?? []) as unknown[];
    const ids = [...new Set(raw.filter((i): i is string => typeof i === "string" && VALID_MODEL_IDS.has(i)))];
    if (!ids.length) {
      spindle.sendToFrontend({ type: "vast_set_model_selection_result", ok: false, error: "pick at least one model" }, userId);
      return;
    }
    await durableWriteJson(MODEL_SELECTION_KEY, { ids });
    spindle.sendToFrontend({ type: "vast_set_model_selection_result", ok: true, ids }, userId);
    return;
  }

  // Read the user's configured cap on concurrent instances.
  if (payload?.type === "vast_get_limits") {
    const maxInstances = await getMaxInstances();
    spindle.sendToFrontend({ type: "vast_get_limits_result", ok: true, maxInstances }, userId);
    return;
  }

  if (payload?.type === "vast_set_limits") {
    const n = Math.floor(Number(payload.maxInstances));
    if (!Number.isFinite(n) || n < 1 || n > ABSOLUTE_MAX_INSTANCES) {
      spindle.sendToFrontend({ type: "vast_set_limits_result", ok: false, error: `limit must be an integer between 1 and ${ABSOLUTE_MAX_INSTANCES}` }, userId);
      return;
    }
    await durableWriteJson(LIMITS_KEY, { maxInstances: n });
    spindle.log.info(`vast_set_limits maxInstances=${n}`);
    spindle.sendToFrontend({ type: "vast_set_limits_result", ok: true, maxInstances: n }, userId);
    return;
  }

  if (payload?.type === "vast_get_status") {
    const configured = await spindle.enclave.has(ENCLAVE_KEY, userId);
    spindle.sendToFrontend({ type: "vast_get_status_result", configured }, userId);
    return;
  }

  if (payload?.type === "vast_test_key" && typeof payload.key === "string") {
    const key = payload.key.trim();
    if (!key) {
      spindle.sendToFrontend({ type: "vast_test_key_result", ok: false, status: 0, body: { error: "empty key" } }, userId);
      return;
    }
    const probeResult = await vastProbe(key);
    // Explicitly never return the key or anything derived from it; only the probe verdict.
    spindle.sendToFrontend(
      { type: "vast_test_key_result", ok: probeResult.ok, status: probeResult.status, body: { verdict: probeResult.ok ? "credentials accepted" : "credentials rejected" } },
      userId,
    );
    return;
  }

  if (payload?.type === "vast_save_key" && typeof payload.key === "string") {
    const key = payload.key.trim();
    if (!key) {
      spindle.sendToFrontend({ type: "vast_save_key_result", ok: false, error: "empty key" }, userId);
      return;
    }
    // Read-only verification before persisting — we never save a key we haven't validated.
    const probeResult = await vastProbe(key);
    if (!probeResult.ok) {
      spindle.sendToFrontend({ type: "vast_save_key_result", ok: false, error: "Credentials rejected by Vast.ai (read-only test failed — check the key and try again)." }, userId);
      return;
    }
    await spindle.enclave.put(ENCLAVE_KEY, key, userId);
    spindle.sendToFrontend({ type: "vast_save_key_result", ok: true }, userId);
    return;
  }

  if (payload?.type === "vast_clear_key") {
    await spindle.enclave.delete(ENCLAVE_KEY, userId);
    spindle.sendToFrontend({ type: "vast_clear_key_result", ok: true }, userId);
    return;
  }

  // Read-only inspection of one OWNED instance — public IP, direct port mapping, status.
  // Used by the UI (details button) and later by the host-gateway to route to the worker.
  if (payload?.type === "vast_show_instance" && typeof payload.id === "number") {
    const id = Math.floor(payload.id);
    const apiKey = await spindle.enclave.get(ENCLAVE_KEY, userId);
    if (!apiKey) {
      spindle.sendToFrontend({ type: "vast_show_instance_result", ok: false, error: "no Vast.ai key saved yet" }, userId);
      return;
    }
    const res = await vastApi(apiKey, "GET", `/api/v0/instances/${id}/?owner=me`);
    if (!res.ok) {
      spindle.sendToFrontend({ type: "vast_show_instance_result", ok: false, error: res.error ?? `HTTP ${res.status}` }, userId);
      return;
    }
    const b: any = res.body?.instances ?? res.body;
    const ports: Array<[number, number]> = Array.isArray(b?.ports)
      ? b.ports.map((p: any) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : null)).filter(Boolean)
      : [];
    spindle.sendToFrontend({
      type: "vast_show_instance_result",
      ok: true,
      id,
      view: {
        id: Number(b?.id ?? id) || id,
        label: typeof b?.label === "string" ? b.label.slice(0, 64) : null,
        gpuName: typeof b?.gpu_name === "string" ? b.gpu_name : null,
        numGpus: Number(b?.num_gpus ?? 1) || 1,
        publicIpaddr: typeof b?.public_ipaddr === "string" ? b.public_ipaddr : null,
        ports,
        sshHost: typeof b?.ssh_host === "string" ? b.ssh_host : null,
        sshPort: typeof b?.ssh_port === "number" ? b.ssh_port : null,
        status: String(b?.actual_status ?? b?.cur_state ?? "unknown"),
        intendedStatus: b?.intended_status ?? null,
        uptimeMins: typeof b?.uptime_mins === "number" ? b.uptime_mins : null,
        dphTotal: typeof b?.dph_total === "number" ? b.dph_total : Number(b?.dph_total) || null,
      },
    }, userId);
    return;
  }

  // Fetch an instance's log text (read-only). vast requires a two-step request_logs -> result_url -> GET flow.
  if (payload?.type === "vast_logs_instance" && typeof payload.id === "number") {
    const id = Math.floor(payload.id);
    const apiKey = await spindle.enclave.get(ENCLAVE_KEY, userId);
    if (!apiKey) {
      spindle.sendToFrontend({ type: "vast_logs_instance_result", ok: false, error: "no Vast.ai key saved yet" }, userId);
      return;
    }
    // vast returns the event/build log by default; the container's runtime stdout is under daemon_logs.
    // Fetch daemon logs first — fall back to the plain build/event log if they're unavailable.
    const requestLogs = async (body: Record<string, unknown>): Promise<string | undefined> => {
      const r = await vastApi(apiKey, "PUT", `/api/v0/instances/request_logs/${id}/`, body);
      const bb: any = r.body;
      return bb?.result_url as string | undefined;
    };
    const url = (await requestLogs({ daemon_logs: "true" })) ?? (await requestLogs({}));
    if (!url) {
      spindle.sendToFrontend({ type: "vast_logs_instance_result", ok: false, error: "vast returned no result_url yet — try again in a minute" }, userId);
      return;
    }
    let text = "";
    for (let attempt = 0; attempt < 6 && !text; attempt++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const r2 = await spindle.cors(url, { method: "GET" });
        if (r2.status === 200 && typeof r2.body === "string" && r2.body.trim().length > 0) text = r2.body;
      } catch (err) {
        spindle.log.info(`vast_logs_instance poll ${attempt} failed: ${String(err)}`);
      }
    }
    if (!text) {
      spindle.sendToFrontend({ type: "vast_logs_instance_result", ok: false, error: "logs not ready yet (vast returned 404/empty repeatedly) — hit Logs again in a minute; the bootstrap may still be preparing" }, userId);
      return;
    }
    const tail = text.length > 32000 ? text.slice(-32000) : text;
    spindle.sendToFrontend({ type: "vast_logs_instance_result", ok: true, id, text: tail }, userId);
    return;
  }

  // List the user's own instances (read-only). Display-safe whitelist only.
  if (payload?.type === "vast_list_instances") {
    const apiKey = await spindle.enclave.get(ENCLAVE_KEY, userId);
    if (!apiKey) {
      spindle.sendToFrontend({ type: "vast_list_instances_result", ok: false, error: "no Vast.ai key saved yet" }, userId);
      return;
    }
    try {
      const instances = await vastListInstances(apiKey);
      spindle.sendToFrontend({ type: "vast_list_instances_result", ok: true, instances }, userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      spindle.log.info(`vast_list_instances failed: ${msg}`);
      spindle.sendToFrontend({ type: "vast_list_instances_result", ok: false, error: msg }, userId);
    }
    return;
  }

  // Start / stop an owned instance. Not a create; no new billing of a different resource.
  if (payload?.type === "vast_instance_action" && typeof payload.id === "number" && (payload.action === "start" || payload.action === "stop")) {
    const apiKey = await spindle.enclave.get(ENCLAVE_KEY, userId);
    if (!apiKey) {
      spindle.sendToFrontend({ type: "vast_instance_action_result", ok: false, error: "no Vast.ai key saved yet" }, userId);
      return;
    }
    const state = payload.action === "start" ? "running" : "stopped";
    const res = await vastApi(apiKey, "PUT", `/api/v0/instances/${Math.floor(payload.id)}/`, { state });
    const b: any = res.body;
    const ok = res.ok && (b?.success ?? true) !== false;
    spindle.log.info(`vast_instance_action ${payload.action} id=${payload.id} ok=${ok}`);
    spindle.sendToFrontend({ type: "vast_instance_action_result", ok, id: Math.floor(payload.id), action: payload.action, error: ok ? undefined : res.error ?? b?.msg ?? "Vast rejected the request" }, userId);
    return;
  }

  // Destroy an owned instance. Destructive — frontend must two-step confirm; backend requires explicit `approved: true`.
  if (payload?.type === "vast_destroy_instance" && typeof payload.id === "number") {
    if (payload.approved !== true) {
      spindle.sendToFrontend({ type: "vast_destroy_instance_result", ok: false, error: "destroy requires approved:true (frontend must confirm with the user)" }, userId);
      return;
    }
    const apiKey = await spindle.enclave.get(ENCLAVE_KEY, userId);
    if (!apiKey) {
      spindle.sendToFrontend({ type: "vast_destroy_instance_result", ok: false, error: "no Vast.ai key saved yet" }, userId);
      return;
    }
    const res = await vastApi(apiKey, "DELETE", `/api/v0/instances/${Math.floor(payload.id)}/`, {});
    const b: any = res.body;
    const ok = res.ok && (b?.success ?? true) !== false;
    spindle.log.info(`vast_destroy_instance id=${payload.id} ok=${ok}`);
    spindle.sendToFrontend({ type: "vast_destroy_instance_result", ok, id: Math.floor(payload.id), error: ok ? undefined : res.error ?? b?.msg ?? "Vast rejected the request" }, userId);
    return;
  }

  // Shared ask→instance creation step (single offer). Returns structured verdict.
  // Classify create outcomes: certain failure vs. ambiguous (network/timeout/5xx/unparseable) —
  // an ambiguous create may have rented the machine, so callers MUST reconcile, never blindly retry.
  const vastCreateOnOffer = async (
    apiKey: string,
    offerId: number,
    body: Record<string, unknown>,
  ): Promise<{ success: boolean; newId: number | null; msg: string; ambiguous: boolean }> => {
    const res = await vastApi(apiKey, "PUT", `/api/v0/asks/${offerId}/`, body);
    const b: any = res.body;
    const ambiguousNet = res.status === 0;
    const ambiguous5xx = res.status >= 500;
    const ambiguousBody = res.ok && b === undefined;
    if (ambiguousNet || ambiguous5xx || ambiguousBody) {
      return { success: false, newId: null, msg: res.error ?? `ambiguous response (status ${res.status})`, ambiguous: true };
    }
    const success = res.ok && b?.success !== false;
    const newId = Number(b?.new_contract ?? b?.instance_id ?? b?.id ?? 0) || null;
    const msg = String(res.error ?? b?.msg ?? b?.error ?? "Vast.ai refused to create the instance");
    return { success, newId, msg, ambiguous: false };
  };

  // Deploy an offer as a new PAID instance. Frontend confirm panel must pass approved:true and a price cap.
  // If payload.fallback.enabled, a failed create races onto freshly searched similar offers
  // (same GPU, >= target VRAM/count, price <= target x (1 + pct/100)), cheapest first.
  // Single-flight: at most ONE deploy workflow at a time; plus a hard ownership wall so a
  // second instance is never created by accident (explicit allowMultiple override required).
  if (payload?.type === "vast_deploy_offer") {
    if (deployInFlight) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "a deploy is already in flight — wait for it to finish before trying again" }, userId);
      return;
    }
    deployInFlight = true;
    try {

    if (payload.approved !== true) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "deploy requires approved:true (frontend must get explicit user approval first)" }, userId);
      return;
    }
    const offerId = Number(payload.offerId);
    const image = typeof payload.image === "string" ? payload.image.trim() : "";
    const diskGB = Number(payload.diskGB);
    const maxPricePerHour = Number(payload.maxPricePerHour);
    const label = typeof payload.label === "string" && payload.label.trim() ? payload.label.trim().slice(0, 64) : "lumiverse-remote-gpu";
    const onstart = typeof payload.onstart === "string" && payload.onstart.trim() ? payload.onstart.trim() : undefined;
    const env = typeof payload.env === "string" && payload.env.trim() ? payload.env.trim() : undefined;
    const parsedEnv = parseVastEnv(env);
    if (env && !parsedEnv) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "env had nothing usable in it — check the -p/-e syntax (e.g. -p 8188 -e KEY=VAL)" }, userId);
      return;
    }
    if (parsedEnv && !/^-/.test(env!)) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "env must start with '-' (e.g. -p 8188 OPEN_BUTTON_PORT=8188 -e KEY=VAL)" }, userId);
      return;
    }
    if (onstart && onstart.length > 4048) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "onstart must be ≤ 4048 characters" }, userId);
      return;
    }
    const fbRaw = (payload.fallback ?? {}) as any;
    const fbEnabled = fbRaw.enabled === true;
    const fbPctNum = Number(fbRaw.fluctuationPct);
    const fbPct = Number.isFinite(fbPctNum) ? Math.min(50, Math.max(1, fbPctNum)) : 15;
    const tgt = (payload.target ?? {}) as any;
    const targetGpuName = typeof tgt.gpuName === "string" ? tgt.gpuName.trim().replace(/_+/g, " ").replace(/\s+/g, " ") : "";
    const targetNumGpus = Math.max(1, Math.floor(Number(tgt.numGpus) || 1));
    const targetVramGB = Math.max(0, Number(tgt.vramGB) || 0);
    const targetDph = Number(tgt.dphTotal);
    const targetKnown = !!targetGpuName && Number.isFinite(targetDph) && targetDph > 0;
    if (!Number.isInteger(offerId) || offerId <= 0) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "offerId must be a positive integer" }, userId);
      return;
    }
    // image: dockerhub-style or registry path with optional :tag — no URLs, credentials or ports
    if (!/^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/.test(image) || image.length < 3 || image.length > 400) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "image must be a plain image reference like vastai/pytorch:cuda-13.0.3-auto" }, userId);
      return;
    }
    if (!Number.isFinite(diskGB) || diskGB < 8 || diskGB > 200) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "diskGB must be between 8 and 200" }, userId);
      return;
    }
    if (!Number.isFinite(maxPricePerHour) || maxPricePerHour <= 0 || maxPricePerHour > 2) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "maxPricePerHour must be in (0, 2.00]" }, userId);
      return;
    }
    const apiKey = await spindle.enclave.get(ENCLAVE_KEY, userId);
    if (!apiKey) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "no Vast.ai key saved yet" }, userId);
      return;
    }
    // Ownership wall: refuse to exceed the user's configured concurrent-instance limit,
    // unless this deploy carries an explicit one-shot override (allowMultiple).
    let ownedIds = new Set<number>();
    try {
      const owned = await vastListInstances(apiKey);
      const limit = await getMaxInstances();
      ownedIds = new Set(owned.map((i) => i.id));
      if (owned.length >= limit && payload.allowMultiple !== true) {
        const list = owned.map((i) => `#${i.id} (${i.status})`).join(", ");
        spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: `you own ${owned.length} instance(s) at your limit of ${limit}: ${list} — destroy one, raise the limit (My instances → Max concurrent instances), or tick the override to deploy above it` }, userId);
        return;
      }
    } catch (err) {
      spindle.log.info(`vast_deploy_offer ownership check failed: ${String(err)} — refusing to deploy blind`);
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: `could not verify existing instances (${err instanceof Error ? err.message : String(err)}) — refusing to deploy blind. Refresh the list and try again.` }, userId);
      return;
    }
    const makeBody = (): Record<string, unknown> => ({
      image,
      disk: diskGB,
      label,
      target_state: "running",
      // vast's enum exposes ssh_direct for raw-TCP direct port access; this image has no sshd by default
      runtype: "ssh_direct",
      ...(onstart ? { onstart } : {}),
      ...(parsedEnv ? { env: parsedEnv } : {}),
    });

    // Ambiguous creates may have rented the machine — reconcile against the pre-flight
    // snapshot instead of blindly retrying. Never fires a second create.
    const reconcile = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          const cur = await vastListInstances(apiKey);
          const fresh = cur.find((x) => !ownedIds.has(x.id));
          if (fresh) return fresh;
        } catch { /* transient — keep polling */ }
      }
      return null;
    };

    const emitOk = (instanceId: number | null, deployedOfferId: number, dphTotal: number | undefined, attempts: number, fallbackUsed: boolean, reconciled = false) => {
      spindle.log.info(`vast_deploy_offer offer=${offerId} deployed=${deployedOfferId} image=${image} diskGB=${diskGB} maxPricePerHour=${maxPricePerHour} attempts=${attempts} fallback=${fallbackUsed} reconciled=${reconciled} new_contract=${instanceId ?? "-"}`);
      spindle.sendToFrontend({
        type: "vast_deploy_offer_result",
        ok: true,
        offerId,
        instanceId,
        deployedOfferId,
        dphTotal,
        attempts,
        fallbackUsed,
        reconciled,
      }, userId);
    };
    const emitFail = (error: string, attempts: number) => {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, offerId, error, attempts }, userId);
    };

    // 1) Requested offer first.
    const first = await vastCreateOnOffer(apiKey, offerId, makeBody());
    if (first.success) {
      emitOk(first.newId, offerId, targetKnown ? targetDph : undefined, 1, false);
      return;
    }
    if (first.ambiguous) {
      const fresh = await reconcile();
      if (fresh) {
        spindle.log.info(`vast_deploy_offer offer=${offerId} ambiguous — reconciled instance #${fresh.id}`);
        emitOk(fresh.id, offerId, fresh.dphTotal ?? undefined, 1, false, true);
        return;
      }
      emitFail(`create of offer #${offerId} was ambiguous (${first.msg}); no new instance visible after 3 reconciles — REFUSING to retry to avoid a duplicate. Check My instances now; destroy any straggler you didn't intend.`, 1);
      return;
    }
    spindle.log.info(`vast_deploy_offer offer=${offerId} failed (${first.msg}) fallbackEnabled=${fbEnabled} targetKnown=${targetKnown}`);
    if (!fbEnabled || !targetKnown) {
      emitFail(first.msg, 1);
      return;
    }

    // 2) Fallback race: fresh similar offers, cheapest first, strictly within +fbPct% of the TARGET offer's price.
    const ceiling = Math.min(2.0, targetDph * (1 + fbPct / 100));
    let attempts = 1;
    let lastMsg = first.msg;
    // The race must honor the SAME quality filters the user has set in the search UI, plus the
    // user's known-bad host blacklist — otherwise it re-lands on the very hosts they excluded.
    const fallbackPolicy = fbRaw?.policy ? normalizeOfferPolicy(fbRaw.policy) : {};
    const excludeMachineIds = await getFailedHosts();
    if (excludeMachineIds.length) spindle.log.info(`vast_deploy_offer excluding ${excludeMachineIds.length} blacklisted host(s)`);
    try {
      const candidates = (
        await searchVastOffers(apiKey, {
          ...fallbackPolicy,
          gpuNames: [targetGpuName],
          minVramGB: Math.floor(targetVramGB),
          maxDphTotal: Math.round(ceiling * 1000) / 1000,
          minDphTotal: 0,
          limit: 8,
          excludeRented: true,
          excludeMachineIds,
        } as any) as any[]
      )
        .filter((o: any) => Number(o?.id) > 0 && Number(o?.id) !== offerId)
        .map((o: any) => ({ id: Number(o.id), dphTotal: Number(o.dphTotal) || 0, gpuCount: Number(o.gpuCount ?? 1) || 1 }))
        .filter((o) => o.gpuCount === targetNumGpus) // keep the same GPU count as the target offer
        .sort((a, b) => a.dphTotal - b.dphTotal);
      for (const cand of candidates) {
        const a = await vastCreateOnOffer(apiKey, cand.id, makeBody());
        attempts++;
        lastMsg = a.msg;
        spindle.log.info(`vast_deploy_offer fallback attempt=${attempts} offer=${cand.id} price=${cand.dphTotal} ok=${a.success} msg=${a.msg}`);
        if (a.success) { emitOk(a.newId, cand.id, cand.dphTotal, attempts, true); return; }
        if (a.ambiguous) {
          const fresh = await reconcile();
          if (fresh) {
            spindle.log.info(`vast_deploy_offer fallback attempt=${attempts} offer=${cand.id} ambiguous — reconciled instance #${fresh.id}`);
            emitOk(fresh.id, cand.id, cand.dphTotal, attempts, true, true);
            return;
          }
          emitFail(`create of fallback offer #${cand.id} was ambiguous (${a.msg}); stopping to avoid a duplicate. Check My instances — destroy any straggler you didn't intend.`, attempts);
          return;
        }
        if (/credit|balance|permission|auth|invalid user key/i.test(a.msg)) break; // account-level — further attempts are pointless
      }
      emitFail(`no available ${targetGpuName}×${targetNumGpus} within +${fbPct}% of $${targetDph.toFixed(3)}/hr (tried ${attempts} offer(s)); last error: ${lastMsg}`, attempts);
    } catch (err) {
      emitFail(`fallback search failed: ${err instanceof Error ? err.message : String(err)}`, attempts);
    }
    return;
    } finally {
      deployInFlight = false;
    }
  }

  // Read-only offer search. The key never leaves this process; the frontend only
  // receives the top N offers, already stripped to display fields.
  if (payload?.type === "vast_search_offers") {
    const apiKey = await spindle.enclave.get(ENCLAVE_KEY, userId);
    if (!apiKey) {
      spindle.sendToFrontend({ type: "vast_search_offers_result", ok: false, error: "no Vast.ai key saved yet" }, userId);
      return;
    }
    try {
      const policy = normalizeOfferPolicy(payload.policy);
      const excludeMachineIds = await getFailedHosts();
      if (excludeMachineIds.length) spindle.log.info(`vast_search_offers excluding ${excludeMachineIds.length} blacklisted host(s)`);
      const policyWithExclusions = { ...policy, excludeMachineIds };
      const offers = await searchVastOffers(apiKey, policyWithExclusions);
      spindle.sendToFrontend({ type: "vast_search_offers_result", ok: true, offers, policy }, userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      spindle.log.info(`vast_search_offers failed: ${msg}`);
      spindle.sendToFrontend({ type: "vast_search_offers_result", ok: false, error: msg }, userId);
    }
    return;
  }
  // Unknown message — log and stay alive.
  spindle.log?.info?.(`unhandled frontend message type: ${payload?.type}`);
}

export interface OfferPolicyPayload {
  maxDphTotal?: number;
  minDphTotal?: number;
  gpuNames?: string[];
  minVramGB?: number;
  maxVramGB?: number;
  minRamGB?: number;
  maxRamGB?: number;
  minDiskGB?: number;
  minReliability?: number;
  minDurationSeconds?: number;
  minInetDownMBs?: number;
  minInetUpMBs?: number;
  geolocations?: string[];
  minCpuCores?: number;
  minCpuMhz?: number;
  verification?: "verified" | "unverified" | null;
  exclusiveExternalOnly?: boolean;
  rentableOnly?: boolean;
  verifiedOnly?: boolean;
  datacenterOnly?: boolean;
  staticIpOnly?: boolean;
  excludeRented?: boolean;
  excludeMachineIds?: number[]; // server-internal — user blacklist of known-bad hosts
  maxStorageCostPerGBMonth?: number;
  minDirectPorts?: number;
  limit?: number;
}

export function normalizeOfferPolicy(raw: unknown): OfferPolicyPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { limit: 20 };
  const out: OfferPolicyPayload = { limit: 20 };
  const num = (k: string) => (typeof (raw as any)[k] === "number" && Number.isFinite((raw as any)[k]) ? (raw as any)[k] as number : undefined);
  const bool = (k: string) => ((raw as any)[k] === true ? true : undefined);
  const arr = (k: string) => {
    const v = (raw as any)[k];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : undefined;
  };
  // Vast stores/queries gpu_name with spaces ("RTX 3090"); the CLI converts '_' -> ' ' for you. Do the same here.
  const gpuNames = arr("gpuNames")
    ?.map((n) => n.trim().replace(/^["']+|["']+$/g, "").replace(/_+/g, " ").replace(/\s+/g, " "))
    .filter((n) => n.length > 0);
  if (num("maxDphTotal") !== undefined) out.maxDphTotal = num("maxDphTotal");
  if (num("minDphTotal") !== undefined) out.minDphTotal = num("minDphTotal");
  if (gpuNames && gpuNames.length > 0) out.gpuNames = gpuNames;
  if (num("minVramGB") !== undefined) out.minVramGB = num("minVramGB");
  if (num("maxVramGB") !== undefined) out.maxVramGB = num("maxVramGB");
  if (num("minRamGB") !== undefined) out.minRamGB = num("minRamGB");
  if (num("maxRamGB") !== undefined) out.maxRamGB = num("maxRamGB");
  if (num("minDiskGB") !== undefined) out.minDiskGB = num("minDiskGB");
  if (num("minReliability") !== undefined) out.minReliability = num("minReliability");
  if (num("minDurationSeconds") !== undefined) out.minDurationSeconds = num("minDurationSeconds");
  if (num("minInetDownMBs") !== undefined) out.minInetDownMBs = num("minInetDownMBs");
  if (num("minInetUpMBs") !== undefined) out.minInetUpMBs = num("minInetUpMBs");
  if (arr("geolocations")?.length) out.geolocations = arr("geolocations");
  if (num("minCpuCores") !== undefined) out.minCpuCores = num("minCpuCores");
  if (num("minCpuMhz") !== undefined) out.minCpuMhz = num("minCpuMhz");
  const ver = (raw as any).verification;
  if (ver === "verified" || ver === "unverified" || ver === null) out.verification = ver;
  if (bool("datacenterOnly")) out.datacenterOnly = true;
  if (bool("staticIpOnly")) out.staticIpOnly = true;
  if ((raw as any).excludeRented === true) out.excludeRented = true;
  else if ((raw as any).excludeRented === false) out.excludeRented = false;
  if (bool("exclusiveExternalOnly")) out.exclusiveExternalOnly = true;
  if (bool("verifiedOnly")) out.verifiedOnly = true;
  if (bool("rentableOnly")) out.rentableOnly = true;
  if (num("maxStorageCostPerGBMonth") !== undefined) out.maxStorageCostPerGBMonth = num("maxStorageCostPerGBMonth");
  if (num("minDirectPorts") !== undefined) out.minDirectPorts = num("minDirectPorts");
  if (num("limit") !== undefined) out.limit = num("limit");
  return out;
}

const DEFAULT_POLICY: OfferPolicyPayload = {
  geolocations: [],
  excludeRented: true,
  limit: 20,
};

async function searchVastOffers(apiKey: string, policy: OfferPolicyPayload = DEFAULT_POLICY) {
  const p: OfferPolicyPayload = { ...DEFAULT_POLICY, ...(policy ?? {}) };
  const body: Record<string, any> = {
    limit: p.limit ?? 20,
    type: "on-demand",
    allocated_storage: 5,
  };
  if (p.excludeRented === true) body.rented = { eq: false };      // exclude rented boxes
  // unchecked = show all offers; don't constrain `rented` at all
  if (p.exclusiveExternalOnly === true) body.external = { eq: false };
  if (p.verifiedOnly === true) body.verified = { eq: true };
  if (p.rentableOnly === true) body.rentable = { eq: true };
  if (p.gpuNames && p.gpuNames.length > 0) body.gpu_name = { in: p.gpuNames };
  if (p.minVramGB !== undefined) body.gpu_ram = { gte: Math.round(p.minVramGB * 1024) };
  if (p.maxVramGB !== undefined) body.gpu_ram = { ...(body.gpu_ram ?? {}), lte: Math.round(p.maxVramGB * 1024) };
  if (p.minRamGB !== undefined) body.cpu_ram = { gte: Math.round(p.minRamGB * 1024) };
  if (p.maxRamGB !== undefined) body.cpu_ram = { ...(body.cpu_ram ?? {}), lte: Math.round(p.maxRamGB * 1024) };
  if (p.minDiskGB !== undefined) body.disk_space = { gte: p.minDiskGB };
  if (p.minDphTotal !== undefined || p.maxDphTotal !== undefined) body.dph_total = { gte: p.minDphTotal ?? 0, lte: p.maxDphTotal ?? 0.5 };
  if (p.minReliability !== undefined) body.reliability = { gte: p.minReliability };
  if (p.minDurationSeconds !== undefined) body.duration = { gte: p.minDurationSeconds };
  if (p.minInetDownMBs !== undefined) body.inet_down = { gte: p.minInetDownMBs };
  if (p.minInetUpMBs !== undefined) body.inet_up = { gte: p.minInetUpMBs };
  if (p.geolocations && p.geolocations.length > 0) body.geolocation = { in: p.geolocations };
  if (p.minCpuCores !== undefined) body.cpu_cores = { gte: p.minCpuCores };
  if (p.minCpuMhz !== undefined) body.cpu_ghz = { gte: p.minCpuMhz };
  if (p.verification === "verified") body.verification = { eq: "verified" };
  else if (p.verification === "unverified") body.verification = { eq: "unverified" };
  if (p.staticIpOnly) body.static_ip = { eq: true };
  if (p.excludeMachineIds?.length) body.machine_id = { notin: p.excludeMachineIds };
  if (p.maxStorageCostPerGBMonth !== undefined) body.storage_cost = { lte: p.maxStorageCostPerGBMonth };
  if (p.minDirectPorts !== undefined) body.direct_port_count = { gte: p.minDirectPorts };

  const res = await spindle.cors(
    "https://console.vast.ai/api/v0/bundles",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const parsed: any = (() => {
    try { return JSON.parse(res.body); } catch { return {}; }
  })();
  if (res.status < 200 || res.status >= 300) {
    const detail = parsed?.msg ?? parsed?.detail ?? parsed?.error ?? `HTTP ${res.status}`;
    throw new Error(`Vast.ai rejected the search query: ${detail}`);
  }
  if (!parsed?.offers?.length) {
    const debug = {
      status: res.status,
      bodyType: typeof res.body,
      bodyLength: typeof res.body === "string" ? res.body.length : -1,
      bodyPreview: typeof res.body === "string" ? res.body.slice(0, 2000) : String(res.body).slice(0, 2000),
      requestBody: body,
    };
    spindle.log.info(`vast offers search returned 0 matches; raw=${JSON.stringify(debug).slice(0, 3000)}`);
    return { __empty: true, debug } as any;
  }
  return parsed.offers
    .slice()
    .sort((a: any, b: any) => (Number(a?.dph_total ?? Infinity) - Number(b?.dph_total ?? Infinity)))
    .slice(0, 10)
    .map((o: any) => ({
      id: o.id,
      hostId: o.host_id ?? null,
      gpuName: o.gpu_name,
      gpuCount: o.num_gpus,
      vramMB: o.gpu_ram,
      ramMB: o.cpu_ram,
      diskGB: Math.round((o.disk_space ?? 0) * 10) / 10,
      dphTotal: o.dph_total,
      reliability: o.reliability,
      geolocation: o.geolocation,
      verification: o.verification,
      isVmDeverified: o.is_vm_deverified ?? null,
      machineId: o.machine_id ?? null,
      duration: o.duration,
    }));
}

spindle.log.info("remote-gpu-manager backend loaded (M1/vast: status probe + enclave API-key storage)");
