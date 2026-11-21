import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { chooseDriveFiles } from "./drive-picker";
import { driveSelectionIssue, validGpuPreference } from "./automation";

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/><rect x="2.5" y="9" width="2" height="6"/><rect x="19.5" y="9" width="2" height="6"/><path d="M9.5 2.5v2M12 2.5v2M14.5 2.5v2M9.5 19.5v2M12 19.5v2M14.5 19.5v2"/></svg>`;

export function setup(ctx: SpindleFrontendContext) {
  const STYLES = `
    .rgm-panel { display: grid; min-width: 0; gap: 10px; padding: 16px; color: var(--lumiverse-text); }
    .rgm-panel h3 { margin: 0; font-size: 15px; }
    .rgm-panel p { margin: 0; color: var(--lumiverse-text-muted); font-size: 12px; line-height: 1.5; }
    .rgm-panel input { width: 100%; box-sizing: border-box; padding: 7px 9px; border: 1px solid var(--lumiverse-border); border-radius: 8px; background: var(--lumiverse-fill); color: var(--lumiverse-text); font: inherit; }
    .rgm-panel input:focus { outline: 2px solid var(--lumiverse-primary); outline-offset: 1px; }
    .rgm-actions { display: flex; flex-wrap: wrap; min-width: 0; gap: 8px; }
    .rgm-runtime-actions button { flex: 1 1 110px; min-width: 0; }
    .rgm-panel button { padding: 7px 12px; border: 1px solid var(--lumiverse-border); border-radius: 8px; background: var(--lumiverse-fill-subtle); color: var(--lumiverse-text); font: inherit; font-weight: 600; cursor: pointer; }
    .rgm-panel button:hover { background: var(--lumiverse-fill); }
    .rgm-panel button.rgm-primary { border-color: var(--lumiverse-primary); color: var(--lumiverse-primary); }
    .rgm-status { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--lumiverse-border); font-size: 12px; font-weight: 600; }
    .rgm-status[data-tone="ok"] { color: var(--lumiverse-success, #4caf50); }
    .rgm-status[data-tone="bad"] { color: var(--lumiverse-error, #e57373); }
    .rgm-status[data-tone="unknown"] { color: var(--lumiverse-text-muted); }
    .rgm-out { margin: 0; max-height: 220px; overflow: auto; white-space: pre-wrap; font-size: 11px; color: var(--lumiverse-text-muted); }
    .rgm-panel label { display: grid; gap: 4px; font-size: 12px; }
    .rgm-panel select { padding: 7px; }
  `;
  const removeStyle = ctx.dom.addStyle(STYLES);

  const drawer = ctx.ui.registerDrawerTab({
    id: "remote_gpu_manager",
    title: "Remote GPU Manager",
    shortName: "GPU",
    headerTitle: "Remote GPU Manager",
    description: "Warm-worker connectivity, lifecycle status and remote assets for the Colab GPU worker (MOSS / Anima).",
    keywords: ["gpu", "colab", "comfyui", "remote", "moss", "anima", "image generation"],
    iconSvg: ICON_SVG,
  });

  drawer.root.innerHTML = `
    <div class="rgm-panel">
      <h3>Remote GPU Manager</h3>
      <p>Check connectivity to the configured worker or manage an enabled Colab runtime below.</p>
      <input class="rgm-gw-url" type="text" spellcheck="false" placeholder="Gateway URL, e.g. http://127.0.0.1:8189" />
      <div class="rgm-actions">
        <button class="rgm-save-url" type="button">Save URL</button>
        <button class="rgm-check rgm-primary" type="button">Check worker</button>
      </div>
      <div class="rgm-status" data-tone="unknown">Not checked yet.</div>
      <pre class="rgm-out"></pre>
      <h3>Colab automation</h3>
      <p class="rgm-workbook-status" role="status">Checking workbook revision...</p>
      <p>Credentials are saved in your encrypted enclave. Starting allocates a Colab runtime; stop it when finished.</p>
      <details><summary>Automation credentials</summary>
        <p>Credential fields stay blank for security even when saved. Leave a field blank to keep its saved value.</p>
        <p class="rgm-credentials-status" role="status">Checking for saved credentials...</p>
        <label>Gateway control token<input data-secret="controlToken" type="password" autocomplete="off" /></label>
        <label>Google OAuth client ID<input data-secret="clientId" type="password" autocomplete="off" /></label>
        <label>Google OAuth client secret<input data-secret="clientSecret" type="password" autocomplete="off" /></label>
        <label>Google refresh token<input data-secret="refreshToken" type="password" autocomplete="off" /></label>
        <label>Tailscale auth key<input data-secret="tailnetKey" type="password" autocomplete="off" /></label>
        <label>Tunnel Basic Auth username<input data-secret="basicUser" type="text" autocomplete="off" /></label>
        <label>Tunnel Basic Auth password<input data-secret="basicPass" type="password" autocomplete="off" /></label>
        <button class="rgm-save-secrets" type="button">Save credentials</button>
      </details>
      <details><summary>Drive model cache</summary>
        <p>Use a web OAuth client, browser API key, and project number from the same Google Cloud project as the Colab OAuth client. Select the three MOSS SFT model files, together or one at a time.</p>
        <label>Google web OAuth client ID<input class="rgm-picker-client" type="password" autocomplete="off" /></label>
        <label>Google Picker API key<input class="rgm-picker-key" type="password" autocomplete="off" /></label>
        <label>Google Cloud project number<input class="rgm-picker-project" type="password" autocomplete="off" /></label>
        <p>Saved Picker settings are masked. You can replace them when needed.</p>
        <button class="rgm-save-picker" type="button">Save Picker settings</button>
        <p class="rgm-picker-settings-status" role="status"></p>
        <button class="rgm-picker" type="button">Select cache files</button>
        <p class="rgm-drive-status" role="status">No selection made in this session.</p>
      </details>
      <label>Colab GPU
        <select class="rgm-gpu"><option value="T4|SHAPE_STANDARD">T4 — standard (default)</option></select>
      </label>
      <button class="rgm-gpu-refresh" type="button">Load eligible GPUs</button>
      <p class="rgm-gpu-status" role="status">Eligibility and availability depend on your Colab account. Check your plan for compute-unit usage and costs.</p>
      <div class="rgm-actions rgm-runtime-actions">
        <button class="rgm-start" type="button">Start Colab</button>
        <button class="rgm-stop" type="button">Stop Colab</button>
        <button class="rgm-force-stop" type="button">Force stop</button>
        <button class="rgm-runtime-status" type="button">Check runtime</button>
        <button class="rgm-recover" type="button">Recover allocation</button>
      </div>
      <label>Idle shutdown
        <select class="rgm-idle"><option value="0">Disabled</option><option value="5">5 minutes</option><option value="10" selected>10 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option></select>
      </label>
      <button class="rgm-set-idle" type="button">Set idle timeout</button>
      <p class="rgm-idle-status" role="status">Default: 10 minutes. Set a timeout to save it.</p>
      <div class="rgm-automation-status rgm-status" data-tone="unknown">Automation not checked.</div>
    </div>`;

  const out = drawer.root.querySelector(".rgm-out") as HTMLPreElement | null;
  const statusBox = drawer.root.querySelector(".rgm-status") as HTMLDivElement | null;
  const urlInput = drawer.root.querySelector(".rgm-gw-url") as HTMLInputElement | null;
  const automationStatus = drawer.root.querySelector(".rgm-automation-status") as HTMLDivElement | null;
  const credentialsStatus = drawer.root.querySelector(".rgm-credentials-status") as HTMLParagraphElement | null;
  const driveStatus = drawer.root.querySelector(".rgm-drive-status") as HTMLParagraphElement | null;
  const pickerSettingsStatus = drawer.root.querySelector(".rgm-picker-settings-status") as HTMLParagraphElement | null;
  const gpuSelect = drawer.root.querySelector(".rgm-gpu") as HTMLSelectElement;
  const gpuStatus = drawer.root.querySelector(".rgm-gpu-status") as HTMLParagraphElement | null;
  const idleSelect = drawer.root.querySelector(".rgm-idle") as HTMLSelectElement;
  const idleStatus = drawer.root.querySelector(".rgm-idle-status") as HTMLParagraphElement;
  let idleDirty = false;
  idleSelect.addEventListener("change", () => { idleDirty = true; });
  let gpuDirty = false;
  let gpuSavePending = false;
  let eligibleGpuValues: Set<string> | null = null;
  function restoreGpu(value: string) {
    let option = [...gpuSelect.options].find(item => item.value === value);
    if (!option) {
      option = document.createElement("option");
      option.value = value;
      const [accelerator, shape] = value.split("|");
      option.textContent = `${accelerator} - ${shape.replace(/^SHAPE_/, "").toLowerCase()} (saved${eligibleGpuValues ? "; not currently eligible" : "; eligibility not checked"})`;
      option.disabled = eligibleGpuValues !== null;
      gpuSelect.appendChild(option);
    }
    gpuSelect.value = value;
  }
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSecrets: Record<string, string> | null = null;
  let pickerDirty = false;
  const send = (type: string, extra: object = {}) => ctx.sendToBackend({ type, ...extra });
  const poll = () => send("automation_poll");
  const pickerConfig = () => {
    const field = (selector: string) => (drawer.root.querySelector(selector) as HTMLInputElement).value.trim();
    return { clientId: field(".rgm-picker-client"), apiKey: field(".rgm-picker-key"), projectNumber: field(".rgm-picker-project") };
  };
  drawer.root.querySelectorAll<HTMLInputElement>(".rgm-picker-client, .rgm-picker-key, .rgm-picker-project")
    .forEach(input => input.addEventListener("input", () => { pickerDirty = true; }));
  drawer.root.querySelector(".rgm-save-picker")?.addEventListener("click", () => {
    send("automation_picker_config_save", { config: pickerConfig() });
  });
  drawer.root.querySelector(".rgm-save-secrets")?.addEventListener("click", () => {
    const secrets: Record<string, string> = {};
    drawer.root.querySelectorAll<HTMLInputElement>("[data-secret]").forEach(input => {
      secrets[input.dataset.secret!] = input.value;
    });
    pendingSecrets = secrets;
    send("automation_save", { secrets });
  });
  drawer.root.querySelector(".rgm-picker")?.addEventListener("click", async () => {
    try {
      const config = pickerConfig();
      if (!config.clientId || !config.apiKey || !/^\d+$/.test(config.projectNumber)) {
        if (driveStatus) driveStatus.textContent = "Enter the Picker settings and save them before selecting files.";
        return;
      }
      send("automation_picker_config_save", { config });
      const files = await chooseDriveFiles(config);
      const issue = driveSelectionIssue(files);
      if (issue) {
        if (driveStatus) {
          const selected = files.map(file => typeof file?.name === "string" ? file.name : "(name not provided)").join(", ");
          const guidance: Record<string, string> = {
            drive_selection_empty: "No files were returned by Google Picker.",
            drive_selection_too_many: "Select no more than 16 files at once.",
            drive_selection_metadata_missing: "Google Picker did not provide valid file information.",
            drive_selection_unrecognized: "At least one selected filename does not match a supported model file.",
            drive_selection_duplicate: "Two selected files have the same name. Select only one copy of each file.",
          };
          driveStatus.textContent = `${guidance[issue] ?? "Selection not saved."} Selected: ${selected || "none"}.`;
        }
        return;
      }
      if (driveStatus) driveStatus.textContent = `Saving ${files.length} selected file${files.length === 1 ? "" : "s"}…`;
      send("automation_save_drive", { files });
    } catch (error) {
      if (automationStatus) {
        automationStatus.dataset.tone = "bad";
        const message = (error as Error)?.message ?? "picker_failed";
        automationStatus.textContent = /^[a-z_]+$/.test(message) ? message : "picker_failed";
      }
      if (driveStatus) driveStatus.textContent = "File selection did not complete. Please try again.";
    }
  });
  gpuSelect.addEventListener("change", () => {
    gpuDirty = true;
    const [accelerator, shape] = gpuSelect.value.split("|");
    gpuSavePending = true;
    gpuSelect.disabled = true;
    if (gpuStatus) gpuStatus.textContent = "Saving GPU preference...";
    send("automation_gpu_choice_save", { choice: { accelerator, shape } });
  });
  drawer.root.querySelector(".rgm-gpu-refresh")?.addEventListener("click", () => {
    if (gpuStatus) gpuStatus.textContent = "Checking eligible GPUs…";
    send("automation_gpu_specs");
  });
  drawer.root.querySelector(".rgm-start")?.addEventListener("click", () => {
    const [accelerator, shape] = gpuSelect.value.split("|");
    if (gpuSavePending) {
      if (gpuStatus) gpuStatus.textContent = "Wait for the GPU preference to finish saving.";
      return;
    }
    if (!accelerator || !shape || gpuSelect.selectedOptions[0]?.disabled) {
      if (gpuStatus) gpuStatus.textContent = "Choose an eligible GPU first.";
      return;
    }
    const nonDefault = accelerator !== "T4" || shape !== "SHAPE_STANDARD";
    if (!window.confirm(`Start a ${accelerator} ${shape.replace(/^SHAPE_/, "")} runtime? This may consume compute units or incur charges depending on your Colab plan. Check your plan before continuing.`)) return;
    send("automation_start", { choice: { accelerator, shape, confirmNonDefault: nonDefault } });
  });
  drawer.root.querySelector(".rgm-stop")?.addEventListener("click", () => send("automation_stop"));
  drawer.root.querySelector(".rgm-force-stop")?.addEventListener("click", () => {
    if (window.confirm("Force stop this Colab runtime even if work is active or its status is unknown?")) {
      send("automation_stop", { force: true });
    }
  });
  drawer.root.querySelector(".rgm-recover")?.addEventListener("click", () => {
    if (window.confirm("Only continue if you verified in Google Colab that the previous runtime was terminated and no allocation is still in progress. A delayed allocation could still appear and incur charges. Recover the allocation safeguard?")) send("automation_recover");
  });
  drawer.root.querySelector(".rgm-runtime-status")?.addEventListener("click", () => { send("automation_status"); });
  drawer.root.querySelector(".rgm-set-idle")?.addEventListener("click", () => {
    idleDirty = true;
    send("automation_idle", { minutes: Number(idleSelect.value) });
  });

  drawer.root.querySelector(".rgm-save-url")?.addEventListener("click", () => {
    if (urlInput?.value.trim()) ctx.sendToBackend({ type: "set_gateway_url", url: urlInput.value.trim() });
  });
  drawer.root.querySelector(".rgm-check")?.addEventListener("click", () => {
    if (statusBox) { statusBox.dataset.tone = "unknown"; statusBox.textContent = "Probing…"; }
    ctx.sendToBackend({ type: "status" });
  });

  const unsub = ctx.onBackendMessage((payload: any) => {
    if (payload?.action === "automation_workbook_info") {
      const status = drawer.root.querySelector(".rgm-workbook-status");
      if (status) status.textContent = payload.type === "automation_result" && /^[a-f0-9]{64}$/.test(payload.result?.sha256)
        ? `Final workbook SHA-256: ${payload.result.sha256.slice(0, 12)} (extension copy).`
        : "Could not identify the extension workbook.";
      return;
    }
    if (payload?.action === "automation_idle_get") {
      if (payload.type === "automation_result" && payload.result?.minutes !== null && !idleDirty) {
        idleSelect.value = String(payload.result.minutes);
        idleStatus.textContent = "Saved idle timeout loaded; it will be applied before starting Colab.";
      } else if (payload.type === "automation_error") idleStatus.textContent = "Could not load the saved idle timeout.";
      return;
    }
    if (payload?.action === "automation_idle") {
      idleStatus.textContent = payload.type === "automation_result"
        ? "Idle timeout applied and saved."
        : `Idle timeout could not be saved or applied: ${payload.error}.`;
    }
    if (payload?.action === "automation_gpu_specs") {
      if (payload.type === "automation_error") {
        if (gpuStatus) gpuStatus.textContent = `Could not load eligible GPUs: ${payload.error}.`;
        return;
      }
      if (payload.type === "automation_result") {
        const specs = Array.isArray(payload.result?.specs) ? payload.result.specs : [];
        const prior = gpuSelect.value;
        eligibleGpuValues = new Set();
        gpuSelect.replaceChildren();
        for (const spec of specs) {
          if (!validGpuPreference(spec)) continue;
          const option = document.createElement("option");
          option.value = `${spec.accelerator}|${spec.shape}`;
          option.textContent = `${spec.accelerator} - ${spec.shape.replace(/^SHAPE_/, "").toLowerCase()}`;
          eligibleGpuValues.add(option.value);
          gpuSelect.appendChild(option);
        }
        restoreGpu(prior);
        if (gpuStatus) gpuStatus.textContent = eligibleGpuValues.has(prior)
          ? "These GPUs are eligible for your account; availability is not guaranteed. Check your plan for compute-unit usage and costs."
          : "Your selected GPU is not currently eligible. Choose another eligible GPU or check again later.";
        return;
      }
    }
    if (payload?.action === "automation_gpu_choice_get") {
      if (payload.type === "automation_result" && validGpuPreference(payload.result?.choice) && !gpuDirty) {
        const choice = payload.result.choice;
        restoreGpu(`${choice.accelerator}|${choice.shape}`);
        if (gpuStatus) gpuStatus.textContent = gpuSelect.selectedOptions[0]?.disabled
          ? "Your saved GPU is not currently eligible. Choose another eligible GPU or check again later."
          : "Saved GPU preference loaded. Eligibility and availability depend on your Colab account.";
      } else if (payload.type === "automation_error" && gpuStatus) {
        gpuStatus.textContent = "Could not load the saved GPU preference.";
      }
      return;
    }
    if (payload?.action === "automation_gpu_choice_save") {
      gpuSavePending = false;
      gpuSelect.disabled = false;
      if (gpuStatus) gpuStatus.textContent = payload.type === "automation_result"
        ? "GPU preference saved. Eligibility and availability depend on your Colab account."
        : "GPU preference could not be saved; this choice applies only to this session.";
      return;
    }
    if (payload?.action === "automation_credentials_status") {
      if (credentialsStatus) credentialsStatus.textContent = payload.type === "automation_error"
        ? `Could not check saved credentials: ${payload.error}.`
        : payload.result?.saved ? "Credentials are saved for this account."
        : "No credentials are saved for this account.";
      return;
    }
    if (payload?.action === "automation_drive_status") {
      if (driveStatus) {
        if (payload.type === "automation_error") driveStatus.textContent = `Could not load saved cache selection: ${payload.error}.`;
        else if (payload.result?.saved && payload.result.missing?.length === 0) driveStatus.textContent = "All three cache files are saved. You do not need to select them again.";
        else if (payload.result?.saved) driveStatus.textContent = `Saved cache selection is incomplete. Still needed: ${payload.result.missing.join(", ")}.`;
        else driveStatus.textContent = "No cache files are saved yet.";
      }
      return;
    }
    if (payload?.action === "automation_picker_config_get") {
      if (payload.type === "automation_result" && payload.result?.config && !pickerDirty) {
        const config = payload.result.config;
        (drawer.root.querySelector(".rgm-picker-client") as HTMLInputElement).value = config.clientId;
        (drawer.root.querySelector(".rgm-picker-key") as HTMLInputElement).value = config.apiKey;
        (drawer.root.querySelector(".rgm-picker-project") as HTMLInputElement).value = config.projectNumber;
        if (pickerSettingsStatus) pickerSettingsStatus.textContent = "Saved Picker settings loaded.";
      } else if (payload.type === "automation_error" && pickerSettingsStatus) {
        pickerSettingsStatus.textContent = "Could not load saved Picker settings.";
      }
      return;
    }
    if (payload?.action === "automation_picker_config_save") {
      if (pickerSettingsStatus) pickerSettingsStatus.textContent = payload.type === "automation_result"
        ? "Picker settings saved."
        : `Picker settings were not saved (${payload.error}). Check all three fields and try again.`;
      return;
    }
    if (automationStatus && payload?.type === "automation_error") {
      automationStatus.dataset.tone = "bad";
      const messages: Record<string, string> = {
        missing_control_token: "Enter the gateway control token.",
        missing_client_id: "Enter the Google OAuth client ID.",
        missing_client_secret: "Enter the Google OAuth client secret.",
        missing_refresh_token: "Enter the Google refresh token.",
        missing_tailnet_key: "Enter the Tailscale auth key.",
        missing_basic_user: "Enter the tunnel Basic Auth username.",
        missing_basic_pass: "Enter the tunnel Basic Auth password.",
        invalid_basic_user: "The tunnel Basic Auth username cannot contain spaces or a colon.",
        invalid_credentials: "Check the credential fields and try again.",
        recovery_runtime_present: "A manager runtime is still present. Stop it before recovery.",
        recovery_intent_required: "No recoverable allocation record was found.",
        gateway_workbook_update_required: "The gateway must support extension-supplied workbooks before Colab can start. No runtime was allocated.",
      };
      automationStatus.textContent = messages[payload.error] ?? `${payload.action}: ${payload.error}`;
      if (payload.action === "automation_save") pendingSecrets = null;
      if (payload.action === "automation_save_drive" && driveStatus) {
        driveStatus.textContent = "Selection not saved. Check the status message below.";
      }
    }
    if (automationStatus && payload?.type === "automation_result") {
      const result = payload.result ?? {};
      if (payload.action === "automation_save_drive" && result.saved && driveStatus) {
        driveStatus.textContent = result.complete
          ? "All three cache files are saved. You can now start Colab."
          : `Selection saved. Still needed: ${(result.missing ?? []).join(", ")}. Select the remaining files.`;
      }
      if (payload.action === "automation_save" && result.saved && credentialsStatus) credentialsStatus.textContent = "Credentials are saved for this account.";
      if (payload.action === "automation_save" && result.saved && pendingSecrets) {
        const submitted = pendingSecrets;
        drawer.root.querySelectorAll<HTMLInputElement>("[data-secret]").forEach(input => {
          if (input.value === submitted[input.dataset.secret!]) input.value = "";
        });
        pendingSecrets = null;
      }
      automationStatus.dataset.tone = result.status === "failed" || result.workerHealthy === false ? "bad" : "unknown";
      const display = result.status ?? result.state ?? (result.recovered ? "allocation recovered" : result.saved ? "saved" : result.confirmed ? "stopped" : "updated");
      automationStatus.textContent = `${payload.action}: ${display}${result.error ? ` (${result.error})` : ""}${result.workerHealthy === true ? " — worker healthy" : result.workerHealthy === false ? " — worker health check failed" : ""}`;
      if (payload.action === "automation_status") {
        if (result.worker) automationStatus.textContent += `; worker ${String(result.worker).replace(/_/g, " ")}`;
        if (result.jupyter) automationStatus.textContent += `; Jupyter connection ${result.jupyter}`;
        if (result.job) automationStatus.textContent += `; jobs ${result.job.state}${result.job.lastActivity ? `, last activity ${new Date(result.job.lastActivity).toLocaleTimeString()}` : ""}`;
        if (result.idle?.lastWorkAt) automationStatus.textContent += `; last gateway work ${new Date(result.idle.lastWorkAt).toLocaleTimeString()}`;
        if (result.lastRuntimeObservation) automationStatus.textContent += `; last runtime observation ${String(result.lastRuntimeObservation.event).replace(/_/g, " ")} at ${new Date(result.lastRuntimeObservation.at).toLocaleTimeString()}`;
      }
      if (payload.action === "automation_start" || (payload.action === "automation_poll" && result.status === "running")) {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, 3000);
      }
    }
    if (!statusBox || !out) return;
    if (payload?.type === "status") {
      const gwOk = payload.gateway?.ok;
      const upOk = payload.upstream?.ok;
      statusBox.dataset.tone = gwOk && upOk ? "ok" : "bad";
      const hint = payload.gateway?.hint ?? payload.upstream?.hint;
      statusBox.textContent =
        `${gwOk ? (payload.gateway?.status ? `Gateway OK (${payload.gateway.status})` : "Gateway OK") : "Gateway unreachable"} · ` +
        `${upOk ? "Worker OK" : `Worker unreachable/degraded (${payload.upstream?.status ?? 0})`}` +
        (hint ? `\n${hint}` : "");
      out.textContent = JSON.stringify({ gateway: payload.gateway, upstream: payload.upstream }, null, 2);
    } else if (payload?.type === "gateway_url_saved") {
      statusBox.dataset.tone = "unknown";
      statusBox.textContent = `Saved: ${payload.url}`;
    } else if (payload?.type === "gateway_url_error") {
      statusBox.dataset.tone = "bad";
      statusBox.textContent = `URL rejected: ${payload.error}`;
    }
  });

  send("automation_picker_config_get");
  send("automation_gpu_choice_get");
  send("automation_drive_status");
  send("automation_credentials_status");
  send("automation_idle_get");
  send("automation_workbook_info");

  return () => {
    if (pollTimer) clearTimeout(pollTimer);
    unsub();
    removeStyle();
    drawer.destroy();
  };
}
