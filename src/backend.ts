/**
 * Remote GPU Manager — Spindle backend (M1).
 *
 * Responsibilities in M1 are deliberately thin: report the status of the
 * loopback host gateway and the upstream worker to the frontend panel.
 * The status probe performs exactly one allowlisted GET (/system_stats)
 * through the gateway — which itself forwards it upstream with injected
 * credentials. No provisioning calls, no token-guarded endpoints.
 */

declare const spindle: import("lumiverse-spindle-types").SpindleAPI;

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8189";

async function getGatewayUrl(): Promise<string> {
  const saved = await spindle.storage.getJson<{ url?: string }>("gateway-url.json", { fallback: {} });
  return saved.url ?? DEFAULT_GATEWAY_URL;
}

function hintForStatus(status: number): string | undefined {
  switch (status) {
    case 401:
      return "Worker is reachable but rejected the upstream credentials — check GATEWAY_BASIC_AUTH matches the notebook tunnel Basic Auth.";
    case 404:
      return "HTTP 404 from the upstream host for the probe path — the host may not serve /system_stats (check the URL host & path), or the tunnel is an ngrok edge returning ERR_NGROK_3200 (tunnel offline). Not a token problem.";
    case 502:
      return "Gateway is up but its upstream fetch failed (network/DNS/TLS from inside the Space). See Space logs for '[rgm-gateway] upstream fetch failed'.";
    case 504:
      return "Upstream timed out — worker may be overloaded or the tunnel path is slow.";
    default:
      return undefined;
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
    const base = await getGatewayUrl();
    let gateway: { ok: boolean; status: number; hint?: string } = { ok: false, status: 0, hint: "No response from the gateway — check Space logs for '[rgm-gateway]' and the extension's saved Gateway URL." };
    let upstream: { ok: boolean; status: number; hint?: string; body?: unknown } = { ok: false, status: 0 };
    try {
      // Single allowlisted probe; any HTTP status means the gateway is up.
      const res = await spindle.cors(`${base}/system_stats`, {
        method: "GET",
        headers: { "ngrok-skip-browser-warning": "1" },
      });
      gateway = { ok: true, status: res.status };
      let body: unknown;
      try {
        body = JSON.parse(res.body);
      } catch {
        body = undefined;
      }
      const hint = hintForStatus(res.status);
      upstream = { ok: res.status >= 200 && res.status < 300, status: res.status, hint, body };
      if (!upstream.ok) gateway.hint = hint;
    } catch {
      // Host-side failure to reach the gateway address (status 0).
    }
    spindle.sendToFrontend({ type: "status", gateway, upstream }, userId);
    return;
  }
});

spindle.log.info("remote-gpu-manager backend loaded (M1: status probe only; no provisioning)");
