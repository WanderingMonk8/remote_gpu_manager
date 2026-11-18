/**
 * Remote GPU Manager — Spindle backend (M1).
 *
 * Responsibilities in M1 are deliberately thin: report the status of the
 * loopback host gateway and the upstream worker to the frontend panel.
 * Lifecycle management, dashboard, profiles and asset operations land in
 * M2–M4. This module makes NO runtime provisioning calls.
 */

declare const spindle: import("lumiverse-spindle-types").SpindleAPI;

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8189";

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
    // Upstream health via the gateway's allowlisted proxy route. Discovery
    // semantics: this performs NO provisioning; it is a single health read.
    const upstream = await probe("/system_stats");
    spindle.sendToFrontend(
      {
        type: "status",
        gateway: { ...gateway },
        upstream: { ...upstream },
      },
      userId,
    );
    return;
  }
});

spindle.log.info("remote-gpu-manager backend loaded (M1: status probe only; no provisioning)");
