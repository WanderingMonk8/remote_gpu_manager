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
});

spindle.log.info("remote-gpu-manager backend loaded (M1/vast: status probe + enclave API-key storage)");
