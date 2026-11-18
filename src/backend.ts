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
 *    start/stop (PUT state), destroy (DELETE, requires approved:true), and one paid
 *    action — deploying an offer (PUT asks/{offer_id}/, requires approved:true and a
 *    price cap from the user-facing confirm panel).
 *  - The API key is NEVER logged, NEVER persisted to regular storage, and NEVER
 *    returned to the frontend; only whitelisted verdicts/display fields leak back.
 */

declare const spindle: import("lumiverse-spindle-types").SpindleAPI;

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8189";
const ENCLAVE_KEY = "vast.api_key";

async function getGatewayUrl(): Promise<string> {
  const saved = await spindle.storage.getJson<{ url?: string }>("gateway-url.json", { fallback: {} });
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

/** Authenticated Vast.ai call. Never logs the key; only whitelisted error text leaks. */
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
  if (payload?.type === "set_gateway_url" && typeof payload.url === "string") {
    const url = payload.url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[A-Za-z0-9._:[\]-]+$/.test(url)) {
      spindle.sendToFrontend({ type: "gateway_url_error", error: "URL must be http(s)://host[:port]" }, userId);
      return;
    }
    await spindle.storage.setJson("gateway-url.json", { url });
    spindle.sendToFrontend({ type: "gateway_url_saved", url }, userId);
    return;
  }

  if (payload?.type === "status") {
    const gateway = await probe("/gateway/v1/status");
    const upstream = await probe("/system_stats");
    spindle.sendToFrontend({ type: "status", gateway: { ...gateway }, upstream: { ...upstream } }, userId);
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

  // Deploy an offer as a new PAID instance. Frontend confirm panel must pass approved:true and a price cap.
  // Validates hard limits here too; the user's explicit approval is what authorizes spend.
  if (payload?.type === "vast_deploy_offer") {
    if (payload.approved !== true) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "deploy requires approved:true (frontend must get explicit user approval first)" }, userId);
      return;
    }
    const offerId = Number(payload.offerId);
    const image = typeof payload.image === "string" ? payload.image.trim() : "";
    const diskGB = Number(payload.diskGB);
    const maxPricePerHour = Number(payload.maxPricePerHour);
    const label = typeof payload.label === "string" && payload.label.trim() ? payload.label.trim().slice(0, 64) : "lumiverse-remote-gpu";
    if (!Number.isInteger(offerId) || offerId <= 0) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "offerId must be a positive integer" }, userId);
      return;
    }
    // image: dockerhub-style or registry path with optional :tag — no URLs, credentials or ports
    if (!/^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/.test(image) || image.length < 3 || image.length > 400) {
      spindle.sendToFrontend({ type: "vast_deploy_offer_result", ok: false, error: "image must be a plain image reference like yanwk/comfyui-boot:cu130-slim" }, userId);
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
    const res = await vastApi(apiKey, "PUT", `/api/v0/asks/${offerId}/`, {
      image,
      disk: diskGB,
      label,
      target_state: "running",
    });
    const b: any = res.body;
    const success = res.ok && b?.success !== false;
    const newId = Number(b?.new_contract ?? b?.instance_id ?? b?.id ?? 0) || null;
    spindle.log.info(`vast_deploy_offer offer=${offerId} image=${image} diskGB=${diskGB} maxPricePerHour=${maxPricePerHour} success=${success} new_contract=${newId ?? "-"}`);
    spindle.sendToFrontend({
      type: "vast_deploy_offer_result",
      ok: success,
      offerId,
      instanceId: newId,
      error: success ? undefined : res.error ?? b?.msg ?? b?.error ?? "Vast.ai refused to create the instance",
    }, userId);
    return;
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
      const offers = await searchVastOffers(apiKey, policy);
      spindle.sendToFrontend({ type: "vast_search_offers_result", ok: true, offers, policy }, userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      spindle.log.info(`vast_search_offers failed: ${msg}`);
      spindle.sendToFrontend({ type: "vast_search_offers_result", ok: false, error: msg }, userId);
    }
    return;
  }
});

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
      duration: o.duration,
    }));
}

spindle.log.info("remote-gpu-manager backend loaded (M1/vast: status probe + enclave API-key storage)");
