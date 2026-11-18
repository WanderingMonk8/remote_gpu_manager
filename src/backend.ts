/**
 * Remote GPU Manager — Spindle backend.
 *
 * Responsibilities (current scope: M1/Vast-setup):
 *  - Report the status of the loopback host gateway and the upstream worker to the
 *    frontend panel.
 *  - Store the user's Vast.ai API key in the Spindle Secure Enclave (AES-256-GCM,
 *    per-user). The key is NEVER logged, NEVER persisted to regular storage, and
 *    NEVER returned to the frontend; only `configured: boolean` leaks back.
 *
 * This module makes NO paid calls. Credential test performs only the read-only
 * searchOffers with limit=1 against the public Vast API.
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
          type: "ondemand",
          verified: { eq: true },
          rentable: { eq: true },
          rented: { eq: false },
          gpu_name: { in: ["RTX_3090", "RTX_4090"] },
          dph_total: { lte: 1.0 },
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
  if (num("maxDphTotal") !== undefined) out.maxDphTotal = num("maxDphTotal");
  if (num("minDphTotal") !== undefined) out.minDphTotal = num("minDphTotal");
  if (arr("gpuNames")?.length) out.gpuNames = arr("gpuNames");
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
  if (num("maxStorageCostPerGBMonth") !== undefined) out.maxStorageCostPerGBMonth = num("maxStorageCostPerGBMonth");
  if (num("minDirectPorts") !== undefined) out.minDirectPorts = num("minDirectPorts");
  if (num("limit") !== undefined) out.limit = num("limit");
  return out;
}

const DEFAULT_POLICY: Required<Omit<OfferPolicyPayload, "verification" | "datacenterOnly" | "staticIpOnly" | "minDphTotal" | "maxRamGB" | "maxVramGB" | "minInetUpMBs" | "minInetDownMBs" | "minDurationSeconds" | "minCpuCores" | "minCpuMhz" | "maxStorageCostPerGBMonth" | "minDirectPorts">> = {
  maxDphTotal: 0.5,
  gpuNames: ["RTX_3090", "RTX_4090", "RTX_5090", "RTX_A5000"],
  minVramGB: 24,
  minRamGB: 32,
  minDiskGB: 80,
  minReliability: 0.99,
  geolocations: [],
  excludeRented: true,
  limit: 20,
};

async function searchVastOffers(apiKey: string, policy: OfferPolicyPayload = DEFAULT_POLICY) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const body: Record<string, any> = {
    limit: p.limit,
    type: "on-demand",
    rented: { eq: p.excludeRented },
    external: { eq: false },
    verified: { eq: true },
    rentable: { eq: true },
    gpu_name: { in: p.gpuNames },
    disk_space: { gte: p.minDiskGB },
    gpu_ram: { gte: Math.round(p.minVramGB * 1024) },
    cpu_ram: { gte: Math.round(p.minRamGB * 1024) },
    dph_total: { gte: p.minDphTotal ?? 0, lte: p.maxDphTotal },
    allocated_storage: Math.max(8, p.minDiskGB ?? 8),
  };
  if (p.maxVramGB !== undefined) body.gpu_ram.lte = Math.round(p.maxVramGB * 1024);
  if (p.maxRamGB !== undefined) body.cpu_ram.lte = Math.round(p.maxRamGB * 1024);
  if (p.minReliability !== undefined) body.reliability = { gte: p.minReliability };
  if (p.minDurationSeconds !== undefined) body.duration = { gte: p.minDurationSeconds };
  if (p.minInetDownMBs !== undefined) body.inet_down = { gte: p.minInetDownMBs };
  if (p.minInetUpMBs !== undefined) body.inet_up = { gte: p.minInetUpMBs };
  if (p.geolocations && p.geolocations.length > 0) body.geolocation = { in: p.geolocations };
  if (p.minCpuCores !== undefined) body.cpu_cores = { gte: p.minCpuCores };
  if (p.minCpuMhz !== undefined) body.cpu_ghz = { gte: p.minCpuMhz };
  if (p.verification === "verified") body.verification = { eq: "verified" };
  else if (p.verification === "unverified") body.verification = { eq: "unverified" };
  if (p.datacenterOnly) body.datacenter = { eq: true };
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
