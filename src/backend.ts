/**
 * Remote GPU Manager — Spindle backend (M1).
 *
 * Responsibilities in M1 are deliberately thin: report the status of the
 * loopback host gateway and the upstream worker to the frontend panel.
 * The status probe performs exactly one allowlisted GET (/system_stats)
 * through the gateway — which itself forwards it upstream with injected
 * credentials. No provisioning calls, no token-guarded endpoints.
 */

import { AutomationController } from "./automation";
import { workflowFromInventory } from "./workflow-export";
import { bundledWorkbook } from "./workbook";
import { parseCivitaiUrl, parseCivitaiVersion } from "./civitai";
declare const spindle: import("lumiverse-spindle-types").SpindleAPI;

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8189";

const automation = new AutomationController(
  { get: (key, user) => spindle.enclave.get(key, user), put: (key, value, user) => spindle.enclave.put(key, value, user), delete: async (key, user) => { await spindle.enclave.delete(key, user); } },
  async (path, method, token, body) => {
    // Never send credentials to the configurable status-probe URL.
    const res = await spindle.cors(`${DEFAULT_GATEWAY_URL}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data: any;
    try { data = JSON.parse(res.body); } catch { throw new Error("gateway_invalid_response"); }
    if (res.status < 200 || res.status >= 300) {
      const code = typeof data?.error === "string" && /^[a-z_]+$/.test(data.error) ? data.error : "gateway_error";
      throw new Error(code);
    }
    return data;
  },
);

async function civitaiMetadata(path: string, user: string): Promise<any> {
  if (!/^\/api\/v1\/(?:models|model-versions)\/[1-9]\d{0,14}$/.test(path)) throw new Error("civitai_url_invalid");
  const token = await automation.civitaiToken(user);
  const response = await spindle.cors(`https://civitai.com${path}`, { method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (response.status === 401 || response.status === 403) throw new Error("civitai_access_required");
  if (response.status !== 200 || typeof response.body !== "string" || response.body.length > 2_000_000) throw new Error("civitai_lookup_failed");
  try { return JSON.parse(response.body); } catch { throw new Error("civitai_lookup_failed"); }
}

async function getGatewayUrl(): Promise<string> {
  const saved = await spindle.storage.getJson<{ url?: string }>("gateway-url.json", { fallback: {} });
  return saved.url ?? DEFAULT_GATEWAY_URL;
}

function hintForStatus(status: number, body?: unknown): string | undefined {
  if (status === 502 && (body as any)?.error === "upstream_dns_unresolved") {
    return "The gateway cannot resolve the worker's tunnel hostname. It may be new, offline, or no longer current. Wait for DNS propagation, then check the worker; if it persists, verify the active tunnel address.";
  }
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
  if (typeof payload?.type === "string" && payload.type.startsWith("automation_")) {
    try {
      if (!userId) throw new Error("user_required");
      let result: unknown;
      switch (payload.type) {
        case "automation_save":
          await automation.save(userId, payload.secrets);
          result = { saved: true };
          break;
        case "automation_civitai_lookup": {
          const parsed = parseCivitaiUrl(payload.url);
          if (parsed.versionId) {
            const version = parseCivitaiVersion(await civitaiMetadata(`/api/v1/model-versions/${parsed.versionId}`, userId));
            if (parsed.modelId && parsed.modelId !== version.modelId) throw new Error("civitai_model_mismatch");
            result = { version };
          } else {
            const model = await civitaiMetadata(`/api/v1/models/${parsed.modelId}`, userId);
            if (model?.type !== "Checkpoint" || !Array.isArray(model.modelVersions)) throw new Error("civitai_model_unsupported");
            const versions = model.modelVersions.filter((v: any) => Number.isSafeInteger(v?.id) && v.id > 0).slice(0, 100)
              .map((v: any) => ({ id: v.id, name: typeof v.name === "string" ? v.name.slice(0, 120) : "Version" }));
            if (!versions.length) throw new Error("civitai_lookup_failed");
            result = { modelId: parsed.modelId, versions };
          }
          break;
        }
        case "automation_civitai_version": {
          if (!Number.isSafeInteger(payload.versionId) || payload.versionId <= 0) throw new Error("civitai_url_invalid");
          result = { version: parseCivitaiVersion(await civitaiMetadata(`/api/v1/model-versions/${payload.versionId}`, userId)) };
          break;
        }
        case "automation_civitai_cache_get":
          result = { saved: Boolean(await automation.getCivitaiCache(userId)) }; break;
        case "automation_civitai_cache_save":
          await automation.saveCivitaiCache(userId, payload.files); result = { saved: true }; break;
        case "automation_civitai_selection_get":
          result = { selection: await automation.getCivitaiSelection(userId) }; break;
        case "automation_civitai_selection_save": {
          if (!Number.isSafeInteger(payload.versionId) || !Number.isSafeInteger(payload.fileId)) throw new Error("civitai_selection_invalid");
          const version = parseCivitaiVersion(await civitaiMetadata(`/api/v1/model-versions/${payload.versionId}`, userId));
          await automation.saveCivitaiSelection(userId, { version, fileId: payload.fileId });
          result = { selection: await automation.getCivitaiSelection(userId) }; break;
        }
        case "automation_civitai_token_save":
          await automation.saveCivitaiToken(userId, payload.token); result = await automation.civitaiTokenStatus(userId); break;
        case "automation_civitai_token_remove":
          await automation.removeCivitaiToken(userId); result = await automation.civitaiTokenStatus(userId); break;
        case "automation_civitai_token_status":
          result = await automation.civitaiTokenStatus(userId); break;
        case "automation_credentials_status":
          result = await automation.credentialsStatus(userId);
          break;
        case "automation_drive_status":
          result = await automation.driveStatus(userId);
          break;
        case "automation_save_drive":
          result = await automation.saveDriveFiles(userId, payload.files);
          break;
        case "automation_picker_config_save":
          await automation.savePickerConfig(userId, payload.config);
          result = { saved: true };
          break;
        case "automation_picker_config_get":
          result = { config: await automation.getPickerConfig(userId) };
          break;
        case "automation_start": {
          const settings = await automation.getWorkbookSettings(userId);
          if (settings.MODEL_CHOICE === "Custom Civitai") {
            const saved = await automation.getCivitaiSelection(userId);
            if (!saved) throw new Error("civitai_selection_required");
            if (!await automation.getCivitaiCache(userId)) {
              const fresh = parseCivitaiVersion(await civitaiMetadata(`/api/v1/model-versions/${saved.version.id}`, userId));
              const oldFile = saved.version.files.find(f => f.id === saved.fileId);
              const newFile = fresh.files.find(f => f.id === saved.fileId);
              if (!oldFile || !newFile || fresh.modelId !== saved.version.modelId || fresh.family !== saved.version.family ||
                  newFile.name !== oldFile.name || newFile.sizeKB !== oldFile.sizeKB || newFile.sha256 !== oldFile.sha256) throw new Error("civitai_metadata_changed");
            }
          }
          await automation.start(userId, payload.choice);
          result = { status: "running" };
          break;
        }
        case "automation_workbook_settings_get":
          result = { settings: await automation.getWorkbookSettings(userId) }; break;
        case "automation_workbook_settings_save":
          await automation.saveWorkbookSettings(userId, payload.settings);
          result = { saved: true }; break;
        case "automation_workflow_download": {
          const inventory: Record<string, unknown> = {};
          for (const node of ["UNETLoader", "CLIPLoader", "VAELoader"]) {
            const response = await spindle.cors(`${DEFAULT_GATEWAY_URL}/object_info/${node}`, { method: "GET" });
            if (response.status !== 200) throw new Error("workflow_worker_unreachable");
            let data: any;
            try { data = JSON.parse(response.body); } catch { throw new Error("workflow_inventory_invalid"); }
            inventory[node] = data?.[node];
          }
          result = { workflow: workflowFromInventory(inventory) };
          break;
        }
        case "automation_workbook_info":
          result = { sha256: (await bundledWorkbook()).sha256 };
          break;
        case "automation_gpu_specs": result = await automation.gpuSpecs(userId); break;
        case "automation_gpu_choice_get": result = { choice: await automation.getGpuPreference(userId) }; break;
        case "automation_gpu_choice_save":
          await automation.saveGpuPreference(userId, payload.choice);
          result = { saved: true };
          break;
        case "automation_last_startup_get": result = { failure: await automation.lastStartup(userId) }; break;
        case "automation_poll": {
          const pollResult = await automation.poll(userId);
          result = pollResult;
          if (pollResult.status === "finished" && pollResult.workerHealthy === true) {
            try { spindle.toast.success("Your Colab worker is ready.", { title: "Colab ready", userId }); }
            catch { /* A toast failure must not hide the completed bootstrap result. */ }
          }
          break;
        }
        case "automation_status": result = await automation.status(userId); break;
        case "automation_recover": result = await automation.recover(userId); break;
        case "automation_stop": result = await automation.stop(userId, payload.force === true); break;
        case "automation_idle_get": result = { minutes: await automation.getIdlePreference(userId) }; break;
        case "automation_idle": result = await automation.idle(userId, payload.minutes); break;
        default: throw new Error("unsupported_action");
      }
      spindle.sendToFrontend({ type: "automation_result", action: payload.type, result }, userId);
    } catch (err) {
      const message = (err as Error)?.message ?? "automation_failed";
      spindle.sendToFrontend({ type: "automation_error", action: payload.type,
        error: /^[a-z_]+$/.test(message) ? message : "automation_failed" }, userId);
    }
    return;
  }
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
      const hint = hintForStatus(res.status, body);
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
