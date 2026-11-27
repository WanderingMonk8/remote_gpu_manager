import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { chooseDriveFiles } from "./drive-picker";
import { driveSelectionIssue, validGpuPreference } from "./automation";
import { requiredModelFiles, workbookSettings } from "./workbook-settings";

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/><rect x="2.5" y="9" width="2" height="6"/><rect x="19.5" y="9" width="2" height="6"/><path d="M9.5 2.5v2M12 2.5v2M14.5 2.5v2M9.5 19.5v2M12 19.5v2M14.5 19.5v2"/></svg>`;

export function setup(ctx: SpindleFrontendContext) {
  const STYLES = `
    .rgm-panel { display: grid; grid-template-columns: minmax(0, 1fr); width: 100%; min-width: 0; box-sizing: border-box; gap: 10px; padding: 16px; color: var(--lumiverse-text); }
    .rgm-panel *, .rgm-panel details, .rgm-workbook-settings, .rgm-workflow-lora-controls { min-width: 0; max-width: 100%; box-sizing: border-box; }
    .rgm-panel details, .rgm-panel label, .rgm-workbook-settings, .rgm-workflow-lora-controls { width: 100%; }
    .rgm-panel p, .rgm-status { overflow-wrap: anywhere; }
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
    .rgm-panel label { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; font-size: 12px; }
    .rgm-panel select { width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; padding: 7px; }
    .rgm-panel button { white-space: normal; overflow-wrap: anywhere; }
    .rgm-cache-files { overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
    .rgm-panel input[type=checkbox] { width: auto; }
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
      </details>
      <details><summary>Drive model cache</summary>
        <p>Use a web OAuth client, browser API key, and project number from the same Google Cloud project as the Colab OAuth client. Optionally select existing cache files for your chosen model. Missing files are downloaded on startup, which can increase Colab runtime costs.</p>
        <label>Google web OAuth client ID<input class="rgm-picker-client" type="password" autocomplete="off" /></label>
        <label>Google Picker API key<input class="rgm-picker-key" type="password" autocomplete="off" /></label>
        <label>Google Cloud project number<input class="rgm-picker-project" type="password" autocomplete="off" /></label>
        <p>Saved Picker settings are masked. You can replace them when needed.</p>
        <p class="rgm-picker-settings-status" role="status"></p>
        <p>Choose existing files by their exact filenames. Saved files are checked before Colab starts; missing files are downloaded.</p>
        <div class="rgm-cache-files" role="status"></div>
        <button class="rgm-picker" type="button">Select cache files</button>
        <p class="rgm-drive-status" role="status">No selection made in this session.</p>
      </details>
      <details><summary>Advanced workbook startup settings</summary>
        <p>Saved for future starts. Changes do not modify an already running worker. Choose the matching model and workflow in Lumiverse separately. BF16 weights need more memory. Anima 2.9B is a community model and requires a recent ComfyUI. Anima weights are licensed for non-commercial use.</p>
        <div class="rgm-workbook-settings"></div>
        <label>MOSS shift in downloaded workflow (optional)<input class="rgm-workflow-shift" type="number" min="0" max="100" step="0.01" placeholder="Model default (normally 5)" disabled /></label>
        <p>Leave blank to use the model default. Applies to newly downloaded MOSS workflows; re-import the workflow into Lumiverse after changing it.</p>
        <p class="rgm-workflow-shift-status" role="status">Loading shift setting...</p>
        <div class="rgm-civitai-settings" hidden>
          <details><summary>Civitai API token</summary>
        <p>The API token is optional and saved privately. Leave the field blank to keep the saved token.</p>
        <label>Civitai API token<input class="rgm-civitai-token" type="password" autocomplete="off" /></label>
        <div class="rgm-actions"><button class="rgm-civitai-token-remove" type="button">Remove token</button></div>
        <p class="rgm-civitai-token-status" role="status">Checking saved token...</p>
          </details>
          <p>Paste a Civitai model or version URL. Only Anima and MOSS SafeTensors checkpoints are supported. Selections are saved automatically for the next start. Optionally select an existing Drive copy to avoid downloading the checkpoint on each fresh runtime. Civitai SHA-256 is checked when available; otherwise only Drive integrity and the filename can be verified.</p>
          <label>Saved checkpoints<select class="rgm-civitai-history"><option value="">No saved checkpoints</option></select></label>
          <p>Choose a previously saved checkpoint, or add one using a Civitai URL below.</p>
          <label>Civitai model URL<input class="rgm-civitai-url" type="url" placeholder="https://civitai.com/models/..." /></label>
          <button class="rgm-civitai-lookup" type="button">Find versions</button>
          <label>Version<select class="rgm-civitai-versions"></select></label>
          <button class="rgm-civitai-load-version" type="button">Load version files</button>
          <label>Checkpoint file<select class="rgm-civitai-files"></select></label>
          <p class="rgm-civitai-detail" role="status">No custom checkpoint selected.</p>
          <button class="rgm-civitai-cache-picker" type="button">Select checkpoint in Drive (optional)</button>
          <p class="rgm-civitai-cache-status" role="status">Choose a custom checkpoint first.</p>
        </div>
        <p class="rgm-workbook-settings-status" role="status">Loading saved settings...</p>
        <div class="rgm-workflow-lora-controls">
          <p><strong>LoRA in downloaded workflow</strong></p>
          <p>After the worker starts, load its installed LoRAs and choose one. Its weight is included in the downloaded starter workflow; map the LoRA node in Lumiverse to override it. Download URLs above install files but do not select them.</p>
          <button class="rgm-workflow-lora-refresh" type="button">Load installed LoRAs</button>
          <label>LoRA<select class="rgm-workflow-lora" disabled><option value="">None</option></select></label>
          <label>LoRA weight<input class="rgm-workflow-lora-weight" type="number" min="-5" max="5" step="0.05" value="1" disabled /></label>
          <p class="rgm-workflow-lora-status" role="status">Loading saved LoRA setting...</p>
        </div>
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
      <button class="rgm-workflow-download" type="button">Download worker workflow</button>
      <p class="rgm-workflow-download-status" role="status">Downloads a starter workflow for the worker's available model.</p>
      <label>Idle shutdown
        <select class="rgm-idle"><option value="0">Disabled</option><option value="5">5 minutes</option><option value="10" selected>10 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option></select>
      </label>
      <p class="rgm-idle-status" role="status">Default: 10 minutes. Changes are saved automatically.</p>
      <div class="rgm-automation-status rgm-status" data-tone="unknown">Automation not checked.</div>
      <p class="rgm-last-startup" role="status"></p>
    </div>`;

  const out = drawer.root.querySelector(".rgm-out") as HTMLPreElement | null;
  const statusBox = drawer.root.querySelector(".rgm-status") as HTMLDivElement | null;
  const urlInput = drawer.root.querySelector(".rgm-gw-url") as HTMLInputElement | null;
  const automationStatus = drawer.root.querySelector(".rgm-automation-status") as HTMLDivElement | null;
  const lastStartupStatus = drawer.root.querySelector(".rgm-last-startup") as HTMLParagraphElement;
  const startupFailureText = (error: string) => error === "colab_no_runtimes"
    ? "Google reported that no runtime is currently available for the requested GPU. Try again later or choose another GPU."
    : error === "auth_required" ? "Google authorization failed. The saved refresh token may have expired or been revoked, or the OAuth client may lack access. Reauthorize Google and update the automation credentials."
    : error;
  const credentialsStatus = drawer.root.querySelector(".rgm-credentials-status") as HTMLParagraphElement | null;
  const driveStatus = drawer.root.querySelector(".rgm-drive-status") as HTMLParagraphElement | null;
  const pickerSettingsStatus = drawer.root.querySelector(".rgm-picker-settings-status") as HTMLParagraphElement | null;
  const gpuSelect = drawer.root.querySelector(".rgm-gpu") as HTMLSelectElement;
  const gpuStatus = drawer.root.querySelector(".rgm-gpu-status") as HTMLParagraphElement | null;
  const idleSelect = drawer.root.querySelector(".rgm-idle") as HTMLSelectElement;
  const idleStatus = drawer.root.querySelector(".rgm-idle-status") as HTMLParagraphElement;
  let idleDirty = false;
  idleSelect.addEventListener("change", () => { idleDirty = true; queueSave("automation_idle", () => ({ minutes: Number(idleSelect.value) })); });
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
  // Serialize writes by action so a slower earlier request cannot overwrite a newer choice.
  const AUTOSAVE_DELAY_MS = 1000;
  const saves = new Map<string, { active: boolean; pending: (() => object) | null; timer?: ReturnType<typeof setTimeout> }>();
  function queueSave(action: string, value: () => object, delay = 0) {
    let entry = saves.get(action);
    if (!entry) { entry = { active: false, pending: null }; saves.set(action, entry); }
    entry.pending = value;
    if (entry.timer) clearTimeout(entry.timer);
    const current = entry;
    current.timer = setTimeout(() => flushSave(action), delay);
  }
  function flushSave(action: string) {
    const entry = saves.get(action);
    if (!entry || entry.active || !entry.pending) return;
    const value = entry.pending; entry.pending = null; entry.active = true;
    send(action, value());
  }
  const workflowLora = drawer.root.querySelector(".rgm-workflow-lora") as HTMLSelectElement;
  const workflowShift = drawer.root.querySelector(".rgm-workflow-shift") as HTMLInputElement;
  const workflowShiftStatus = drawer.root.querySelector(".rgm-workflow-shift-status") as HTMLParagraphElement;
  let workflowShiftSaved = false, workflowShiftDirty = false, shiftVersion = 0, submittedShiftVersion = -1;
  workflowShift.addEventListener("input", () => {
    workflowShiftDirty = true; workflowShiftSaved = false;
    const version = ++shiftVersion;
    const shift = workflowShift.value === "" ? null : Number(workflowShift.value);
    if (shift !== null && (!Number.isFinite(shift) || shift < 0 || shift > 100)) {
      const pending = saves.get("automation_workflow_shift_save");
      if (pending) { pending.pending = null; if (pending.timer) clearTimeout(pending.timer); }
      workflowShiftStatus.textContent = "Enter a shift between 0 and 100, or leave it blank."; return;
    }
    workflowShiftStatus.textContent = "Saving shift...";
    queueSave("automation_workflow_shift_save", () => { submittedShiftVersion = version; return { shift }; }, AUTOSAVE_DELAY_MS);
  });
  const workflowLoraWeight = drawer.root.querySelector(".rgm-workflow-lora-weight") as HTMLInputElement;
  const workflowLoraStatus = drawer.root.querySelector(".rgm-workflow-lora-status") as HTMLParagraphElement;
  let workflowLoraSaved = false;
  let workflowLoraDirty = false;
  let workflowLoraVersion = 0;
  let workflowLoraSubmittedVersion = -1;
  function restoreWorkflowLora(name: string) {
    if (name && ![...workflowLora.options].some(option => option.value === name)) {
      const option = document.createElement("option"); option.value = name; option.textContent = `${name} (saved; load to verify)`; workflowLora.appendChild(option);
    }
    workflowLora.value = name;
  }
  function saveWorkflowLora(delay = 0) {
    workflowLoraDirty = true; workflowLoraSaved = false;
    const version = ++workflowLoraVersion;
    const lora = { name: workflowLora.value, weight: Number(workflowLoraWeight.value) };
    if (!workflowLoraWeight.value || !Number.isFinite(lora.weight) || lora.weight < -5 || lora.weight > 5) {
      const pending = saves.get("automation_workflow_lora_save");
      if (pending) { pending.pending = null; if (pending.timer) clearTimeout(pending.timer); }
      workflowLoraStatus.textContent = "Enter a weight between -5 and 5."; return;
    }
    workflowLoraStatus.textContent = "Saving LoRA setting...";
    queueSave("automation_workflow_lora_save", () => { workflowLoraSubmittedVersion = version; return { lora }; }, delay);
  }
  workflowLora.addEventListener("change", () => saveWorkflowLora());
  workflowLoraWeight.addEventListener("input", () => saveWorkflowLora(AUTOSAVE_DELAY_MS));
  drawer.root.querySelector(".rgm-workflow-lora-refresh")?.addEventListener("click", () => {
    workflowLoraStatus.textContent = "Checking installed LoRAs..."; send("automation_workflow_lora_options");
  });
  const settingsRoot = drawer.root.querySelector(".rgm-workbook-settings") as HTMLDivElement;
  const settingsStatus = drawer.root.querySelector(".rgm-workbook-settings-status") as HTMLParagraphElement;
  let settingsDirty = false;
  let civitaiVersion: any = null;
  let civitaiLookupDirty = false;
  let savedCivitaiSelection: any = null;
  const civitaiSettings = drawer.root.querySelector(".rgm-civitai-settings") as HTMLDivElement;
  const civitaiVersions = drawer.root.querySelector(".rgm-civitai-versions") as HTMLSelectElement;
  const civitaiFiles = drawer.root.querySelector(".rgm-civitai-files") as HTMLSelectElement;
  const civitaiDetail = drawer.root.querySelector(".rgm-civitai-detail") as HTMLParagraphElement;
  const civitaiUrl = drawer.root.querySelector(".rgm-civitai-url") as HTMLInputElement;
  const civitaiHistory = drawer.root.querySelector(".rgm-civitai-history") as HTMLSelectElement;
  civitaiHistory.addEventListener("change", () => {
    const [versionId, fileId] = civitaiHistory.value.split(":").map(Number);
    if (!versionId || !fileId) return;
    civitaiLookupDirty = false;
    civitaiDetail.textContent = "Selecting saved checkpoint...";
    send("automation_civitai_history_select", { versionId, fileId });
  });
  civitaiUrl.addEventListener("input", () => { civitaiLookupDirty = true; });
  function showCivitaiVersion(version: any, fileId?: number) {
    civitaiVersion = version;
    civitaiFiles.replaceChildren();
    for (const file of version.files) {
      const option = document.createElement("option"); option.value = String(file.id);
      option.textContent = `${file.name} ? ${(file.sizeKB / 1048576).toFixed(2)} GiB`;
      civitaiFiles.appendChild(option);
    }
    if (fileId) civitaiFiles.value = String(fileId);
    else if (civitaiFiles.value) saveCivitaiSelection();
    civitaiDetail.textContent = `${version.modelName} / ${version.name}; base ${version.baseModel}. Verify it is compatible with your Lumiverse workflow.`;
  }
  drawer.root.querySelector(".rgm-civitai-lookup")?.addEventListener("click", () => {
    civitaiLookupDirty = true;
    const url = civitaiUrl.value;
    civitaiDetail.textContent = "Looking up Civitai metadata..."; send("automation_civitai_lookup", { url });
  });
  const loadCivitaiVersion = () => { if (civitaiVersions.value) send("automation_civitai_version", { versionId: Number(civitaiVersions.value) }); };
  drawer.root.querySelector(".rgm-civitai-load-version")?.addEventListener("click", loadCivitaiVersion);
  civitaiVersions.addEventListener("change", loadCivitaiVersion);
  const saveCivitaiSelection = () => {
    if (!civitaiVersion || !civitaiFiles.value) { civitaiDetail.textContent = "Load a version and select a file first."; return; }
    queueSave("automation_civitai_selection_save", () => ({ versionId: civitaiVersion.id, fileId: Number(civitaiFiles.value) }));
  };
  civitaiFiles.addEventListener("change", saveCivitaiSelection);
  let savedCacheNames: Set<string> | null = null;
  const cacheFiles = drawer.root.querySelector(".rgm-cache-files") as HTMLDivElement;
  function renderCacheFiles() {
    const model = (settingsRoot.querySelector('[data-workbook-setting="MODEL_CHOICE"]') as HTMLSelectElement | null)?.value;
    if (!model) return;
    civitaiSettings.hidden = model !== "Custom Civitai";
    cacheFiles.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = `Files for ${model}:`;
    cacheFiles.appendChild(heading);
    const list = document.createElement("ul");
    const required = model === "Custom Civitai" ? (savedCivitaiSelection ? (savedCivitaiSelection.version.family === "anima" ? ["qwen_3_06b_base.safetensors", "qwen_image_vae.safetensors"] : ["qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"]) : []) : requiredModelFiles(model);
    if (model === "Custom Civitai" && !savedCivitaiSelection) { const note = document.createElement("p"); note.textContent = "Choose a custom checkpoint to see its required encoder and VAE."; cacheFiles.appendChild(note); }
    for (const name of required) {
      const item = document.createElement("li");
      item.textContent = `${name} ? ${savedCacheNames === null ? "checking" : savedCacheNames.has(name) ? "saved" : "will download unless selected"}`;
      list.appendChild(item);
    }
    cacheFiles.appendChild(list);
  }
  let settingsTimer: ReturnType<typeof setTimeout> | null = null;
  for (const field of workbookSettings) {
    const label = document.createElement("label");
    label.textContent = field.label;
    const input = field.type === "select" ? document.createElement("select") : document.createElement("input");
    input.dataset.workbookSetting = field.key;
    input.disabled = true;
    if (field.type === "select") {
      for (const value of field.options) { const option = document.createElement("option"); option.value = value; option.textContent = value; input.appendChild(option); }
    } else {
      const item = input as HTMLInputElement;
      item.type = field.type === "boolean" ? "checkbox" : field.type === "text" ? "text" : "number";
      if (field.type === "integer") { item.min = String(field.min); item.max = String(field.max); item.step = "1"; }
    }
    input.addEventListener("input", () => { settingsDirty = true; if (field.type === "text" || field.type === "integer") { if (settingsTimer) clearTimeout(settingsTimer); settingsTimer = setTimeout(() => saveWorkbookSettings(), AUTOSAVE_DELAY_MS); } });
    input.addEventListener("change", () => { settingsDirty = true; if (settingsTimer) clearTimeout(settingsTimer); if (field.key === "MODEL_CHOICE") renderCacheFiles(); saveWorkbookSettings(); });
    label.appendChild(input);
    if (field.key === "LORA_URLS") {
      const section = document.createElement("details");
      const heading = document.createElement("summary"); heading.textContent = "LoRA settings";
      const savedLabel = document.createElement("label"); savedLabel.textContent = "Previously installed LoRAs";
      const saved = document.createElement("select"); saved.className = "rgm-lora-history";
      const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose a saved LoRA to add"; saved.appendChild(placeholder);
      saved.addEventListener("change", () => { if (saved.value) send("automation_lora_history_url", { id: saved.value }); });
      savedLabel.appendChild(saved);
      const savedHelp = document.createElement("p"); savedHelp.textContent = "Successful downloads appear here after startup with the updated gateway. Choose one to add it for future starts.";
      const urlDetails = document.createElement("details");
      const urlHeading = document.createElement("summary"); urlHeading.textContent = "Add or edit LoRA download URLs";
      urlDetails.appendChild(urlHeading); urlDetails.appendChild(label);
      section.appendChild(heading); section.appendChild(savedLabel); section.appendChild(savedHelp); section.appendChild(urlDetails);
      section.appendChild(drawer.root.querySelector(".rgm-workflow-lora-controls")!);
      settingsRoot.appendChild(section);
    } else settingsRoot.appendChild(label);
  }
  function showWorkbookSettings(settings: Record<string, any>) {
    for (const field of workbookSettings) {
      const input = settingsRoot.querySelector(`[data-workbook-setting="${field.key}"]`) as HTMLInputElement;
      if (field.type === "boolean") input.checked = settings[field.key]; else input.value = String(settings[field.key]);
    }
  }
  showWorkbookSettings(Object.fromEntries(workbookSettings.map(field => [field.key, field.default])));
  renderCacheFiles();
  function saveWorkbookSettings() {
    const settings: Record<string, boolean | number | string> = {};
    for (const field of workbookSettings) {
      const input = settingsRoot.querySelector(`[data-workbook-setting="${field.key}"]`) as HTMLInputElement;
      settings[field.key] = field.type === "boolean" ? input.checked : field.type === "integer" ? Number(input.value) : input.value;
    }
    settingsStatus.textContent = "Saving advanced settings...";
    queueSave("automation_workbook_settings_save", () => ({ settings }));
  }
  const civitaiToken = drawer.root.querySelector(".rgm-civitai-token") as HTMLInputElement;
  const civitaiTokenStatus = drawer.root.querySelector(".rgm-civitai-token-status") as HTMLParagraphElement;
  const saveToken = () => { if (civitaiToken.value.trim()) { const token = civitaiToken.value; civitaiTokenStatus.textContent = "Saving token..."; queueSave("automation_civitai_token_save", () => ({ token })); } };
  let tokenTimer: ReturnType<typeof setTimeout> | null = null;
  civitaiToken.addEventListener("input", () => { if (tokenTimer) clearTimeout(tokenTimer); tokenTimer = setTimeout(saveToken, AUTOSAVE_DELAY_MS); });
  civitaiToken.addEventListener("change", () => { if (tokenTimer) clearTimeout(tokenTimer); saveToken(); });
  let removeTokenAfterSave = false;
  drawer.root.querySelector(".rgm-civitai-token-remove")?.addEventListener("click", () => {
    if (tokenTimer) clearTimeout(tokenTimer);
    civitaiToken.value = "";
    const entry = saves.get("automation_civitai_token_save");
    if (entry) { entry.pending = null; if (entry.timer) clearTimeout(entry.timer); }
    if (entry?.active) removeTokenAfterSave = true; else send("automation_civitai_token_remove");
  });
  const civitaiCacheStatus = drawer.root.querySelector(".rgm-civitai-cache-status") as HTMLParagraphElement;
  drawer.root.querySelector(".rgm-civitai-cache-picker")?.addEventListener("click", async () => {
    try {
      if (!savedCivitaiSelection) { civitaiCacheStatus.textContent = "Choose a custom checkpoint first."; return; }
      const config = pickerConfig();
      if (!config.clientId || !config.apiKey || !/^\d+$/.test(config.projectNumber)) { civitaiCacheStatus.textContent = "Enter your Google Picker settings first."; return; }
      const files = await chooseDriveFiles(config);
      send("automation_civitai_cache_save", { files });
    } catch { civitaiCacheStatus.textContent = "Drive selection did not complete."; }
  });
  const poll = () => send("automation_poll");
  const pickerConfig = () => {
    const field = (selector: string) => (drawer.root.querySelector(selector) as HTMLInputElement).value.trim();
    return { clientId: field(".rgm-picker-client"), apiKey: field(".rgm-picker-key"), projectNumber: field(".rgm-picker-project") };
  };
  drawer.root.querySelectorAll<HTMLInputElement>(".rgm-picker-client, .rgm-picker-key, .rgm-picker-project")
    .forEach(input => input.addEventListener("input", () => { pickerDirty = true; const config = pickerConfig(); if (!config.projectNumber || /^\d+$/.test(config.projectNumber)) queueSave("automation_picker_config_save", () => ({ config }), AUTOSAVE_DELAY_MS); }));
  function saveSecrets() {
    const secrets: Record<string, string> = {};
    drawer.root.querySelectorAll<HTMLInputElement>("[data-secret]").forEach(input => {
      secrets[input.dataset.secret!] = input.value;
    });
    pendingSecrets = secrets;
    queueSave("automation_save", () => ({ secrets }));
  }
  let secretsTimer: ReturnType<typeof setTimeout> | null = null;
  drawer.root.querySelectorAll<HTMLInputElement>("[data-secret]").forEach(input => input.addEventListener("input", () => {
    if (secretsTimer) clearTimeout(secretsTimer);
    secretsTimer = setTimeout(saveSecrets, AUTOSAVE_DELAY_MS);
  }));
  drawer.root.querySelector(".rgm-picker")?.addEventListener("click", async () => {
    try {
      const config = pickerConfig();
      if (!config.clientId || !config.apiKey || !/^\d+$/.test(config.projectNumber)) {
        if (driveStatus) driveStatus.textContent = "Enter the Picker settings before selecting files.";
        return;
      }
      queueSave("automation_picker_config_save", () => ({ config }));
      const files = await chooseDriveFiles(config);
      const issue = driveSelectionIssue(files);
      if (issue) {
        if (driveStatus) {
          const selected = files.map(file => typeof file?.name === "string" ? file.name : "(name not provided)").join(", ");
          const guidance: Record<string, string> = {
            drive_selection_empty: "No files were returned by Google Picker.",
            drive_selection_too_many: "Select no more than 64 files at once.",
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
  const workflowDownloadStatus = drawer.root.querySelector(".rgm-workflow-download-status") as HTMLParagraphElement;
  drawer.root.querySelector(".rgm-workflow-download")?.addEventListener("click", () => {
    if (!workflowLoraSaved) { workflowDownloadStatus.textContent = "Wait for the LoRA setting to save or correct its value."; return; }
    if (!workflowShiftSaved) { workflowDownloadStatus.textContent = "Wait for the shift setting to save or correct its value."; return; }
    workflowDownloadStatus.textContent = "Checking the worker's model...";
    send("automation_workflow_download");
  });
  urlInput?.addEventListener("change", () => {
    if (urlInput.value.trim()) ctx.sendToBackend({ type: "set_gateway_url", url: urlInput.value.trim() });
  });
  drawer.root.querySelector(".rgm-check")?.addEventListener("click", () => {
    if (statusBox) { statusBox.dataset.tone = "unknown"; statusBox.textContent = "Probing…"; }
    ctx.sendToBackend({ type: "status" });
  });

  const unsub = ctx.onBackendMessage((payload: any) => {
    const queued = saves.get(payload?.action);
    if (queued?.active && (payload.type === "automation_result" || payload.type === "automation_error")) {
      queued.active = false;
      if (queued.pending) setTimeout(() => flushSave(payload.action), 0);
    }
    if (payload?.action === "automation_lora_history_get") {
      const saved = settingsRoot.querySelector(".rgm-lora-history") as HTMLSelectElement;
      saved.replaceChildren();
      const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = payload.type === "automation_error" ? "Could not load saved LoRAs" : payload.result.entries.length ? "Choose a saved LoRA to add" : "No successfully downloaded LoRAs yet"; saved.appendChild(placeholder);
      if (payload.type === "automation_result") for (const item of payload.result.entries) { const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; saved.appendChild(option); }
      return;
    }
    if (payload?.action === "automation_lora_history_url") {
      const saved = settingsRoot.querySelector(".rgm-lora-history") as HTMLSelectElement; saved.value = "";
      if (payload.type === "automation_result" && typeof payload.result.url === "string") {
        const input = settingsRoot.querySelector('[data-workbook-setting="LORA_URLS"]') as HTMLInputElement;
        const urls = input.value.replace(/\n/g, ",").split(",").map(url => url.trim()).filter(Boolean);
        if (!urls.includes(payload.result.url)) { urls.push(payload.result.url); input.value = urls.join(", "); settingsDirty = true; saveWorkbookSettings(); }
        settingsStatus.textContent = "Saved LoRA added for the next startup.";
      } else settingsStatus.textContent = "Could not add the saved LoRA.";
      return;
    }
    if (payload?.action === "automation_workflow_shift_get") {
      if (payload.type === "automation_result" && !workflowShiftDirty) {
        workflowShift.value = payload.result.shift === null ? "" : String(payload.result.shift);
        workflowShift.disabled = false; workflowShiftSaved = true; workflowShiftStatus.textContent = "Saved shift setting loaded.";
      } else if (payload.type === "automation_error") workflowShiftStatus.textContent = "Could not load shift setting; reopen the panel to retry.";
      return;
    }
    if (payload?.action === "automation_workflow_shift_save") {
      const entry = saves.get("automation_workflow_shift_save");
      workflowShiftSaved = payload.type === "automation_result" && !entry?.pending && submittedShiftVersion === shiftVersion;
      if (submittedShiftVersion === shiftVersion || entry?.pending) workflowShiftStatus.textContent = payload.type === "automation_error" ? "Could not save shift; change it to retry." : workflowShiftSaved ? "Shift setting saved." : "Saving shift...";
      return;
    }
    if (payload?.action === "automation_workflow_lora_get") {
      if (payload.type === "automation_result" && !workflowLoraDirty) {
        restoreWorkflowLora(payload.result.lora.name); workflowLoraWeight.value = String(payload.result.lora.weight);
        workflowLora.disabled = false; workflowLoraWeight.disabled = false; workflowLoraSaved = true;
        workflowLoraStatus.textContent = "Saved LoRA setting loaded.";
      } else if (payload.type === "automation_error") workflowLoraStatus.textContent = "Could not load the saved LoRA setting. Reopen the panel to retry.";
      return;
    }
    if (payload?.action === "automation_workflow_lora_save") {
      const entry = saves.get("automation_workflow_lora_save");
      workflowLoraSaved = payload.type === "automation_result" && !entry?.pending && workflowLoraSubmittedVersion === workflowLoraVersion;
      if (workflowLoraSubmittedVersion === workflowLoraVersion || entry?.pending) workflowLoraStatus.textContent = payload.type === "automation_error" ? "Could not save the LoRA setting. Change it to retry." : workflowLoraSaved ? "LoRA setting saved." : "Saving LoRA setting...";
      return;
    }
    if (payload?.action === "automation_workflow_lora_options") {
      if (payload.type === "automation_result" && Array.isArray(payload.result?.options)) {
        const selected = workflowLora.value;
        workflowLora.replaceChildren();
        const none = document.createElement("option"); none.value = ""; none.textContent = "None"; workflowLora.appendChild(none);
        for (const name of payload.result.options) { const option = document.createElement("option"); option.value = name; option.textContent = name; workflowLora.appendChild(option); }
        restoreWorkflowLora(selected);
        workflowLoraStatus.textContent = selected && !payload.result.options.includes(selected)
          ? "Saved LoRA is not installed on this worker. Select an installed LoRA or None."
          : "Installed LoRAs loaded. Choose a LoRA and weight.";
      } else workflowLoraStatus.textContent = "Could not load LoRAs. Start the worker and try again.";
      return;
    }
    if (payload?.action === "automation_last_startup_get") {
      const failure = payload.result?.failure;
      if (payload.type === "automation_result") lastStartupStatus.textContent = failure
        ? `Last startup failure: ${startupFailureText(failure.error)} (${new Date(failure.at).toLocaleString()})` : "";
      else lastStartupStatus.textContent = "Could not load the previous startup failure.";
      return;
    }
    if (payload?.action === "automation_workflow_download") {
      if (payload.type === "automation_result" && payload.result?.workflow) {
        const blob = new Blob([JSON.stringify(payload.result.workflow, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a"); link.href = url; link.download = "worker-workflow-api.json"; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        workflowDownloadStatus.textContent = "Workflow downloaded. Import it into Lumiverse and set your generation values there.";
      } else {
        const messages: Record<string, string> = {
          workflow_worker_unreachable: "Worker unavailable. Start Colab and wait until it is ready.",
          workflow_model_ambiguous: "The worker has zero or multiple checkpoints, so its model cannot be identified safely.",
          workflow_family_ambiguous: "The worker's model family cannot be identified safely.",
          workflow_lora_missing: "The saved LoRA is not installed on this worker. Load installed LoRAs and choose another.",
          workflow_lora_family_mismatch: "The saved LoRA belongs to a different model family.",
          workflow_lora_inventory_invalid: "Could not read the worker's LoRA inventory.",
          workflow_shift_moss_only: "Custom shift is available for MOSS workflows. Clear it to export an Anima workflow.",
          workflow_shift_node_missing: "The worker does not provide ModelSamplingAuraFlow. Update ComfyUI or clear the shift setting.",
        };
        workflowDownloadStatus.textContent = messages[payload.error] ?? "Could not create a workflow from this worker.";
      }
      return;
    }
    if (["automation_civitai_cache_get", "automation_civitai_cache_save"].includes(payload?.action)) {
      civitaiCacheStatus.textContent = payload.type === "automation_result" ? (payload.result?.saved ? "A Drive copy is saved for this checkpoint; it will be verified before use." : "No Drive copy is saved; the checkpoint will download from Civitai.") : "Could not save that file. Select exactly the checkpoint filename shown above.";
      return;
    }
    if (["automation_civitai_lookup", "automation_civitai_version", "automation_civitai_selection_get", "automation_civitai_selection_save", "automation_civitai_history_select"].includes(payload?.action)) {
      if (payload.type === "automation_error") { civitaiDetail.textContent = `Civitai: ${String(payload.error).replace(/_/g, " ")}.`; return; }
      if (Array.isArray(payload.result?.history)) {
        civitaiHistory.replaceChildren();
        const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = payload.result.history.length ? "Choose a saved checkpoint" : "No saved checkpoints"; civitaiHistory.appendChild(placeholder);
        for (const item of payload.result.history) {
          const option = document.createElement("option"); option.value = `${item.version.id}:${item.fileId}`;
          const file = item.version.files.find((entry: any) => entry.id === item.fileId);
          const size = file ? `${(file.sizeKB / 1048576).toFixed(2)} GiB` : "size unavailable";
          option.textContent = `${size} — ${item.version.modelName} — ${item.version.name} — ${file?.name ?? "Checkpoint"}`;
          civitaiHistory.appendChild(option);
        }
        if (payload.result.selection) civitaiHistory.value = `${payload.result.selection.version.id}:${payload.result.selection.fileId}`;
      }
      if (payload.result?.versions) {
        civitaiVersions.replaceChildren();
        for (const version of payload.result.versions) { const option = document.createElement("option"); option.value = String(version.id); option.textContent = version.name; civitaiVersions.appendChild(option); }
        civitaiDetail.textContent = "Choose a version, then load its files.";
      }
      if (payload.result?.version) showCivitaiVersion(payload.result.version);
      if (payload.result?.selection) {
        savedCivitaiSelection = payload.result.selection;
        if (["automation_civitai_selection_save", "automation_civitai_history_select"].includes(payload.action) || !civitaiLookupDirty) {
          const version = savedCivitaiSelection.version;
          civitaiVersions.replaceChildren();
          const option = document.createElement("option"); option.value = String(version.id); option.textContent = version.name; civitaiVersions.appendChild(option);
          civitaiUrl.value = `https://civitai.com/models/${version.modelId}?modelVersionId=${version.id}`;
          showCivitaiVersion(version, savedCivitaiSelection.fileId);
          civitaiDetail.textContent += " Saved for the next start.";
          civitaiLookupDirty = false;
        }
        renderCacheFiles(); send("automation_drive_status"); send("automation_civitai_cache_get");
      }
      return;
    }
    if (payload?.action === "automation_civitai_token_save" && removeTokenAfterSave) { removeTokenAfterSave = false; send("automation_civitai_token_remove"); }
    if (["automation_civitai_token_save", "automation_civitai_token_remove", "automation_civitai_token_status"].includes(payload?.action)) {
      if (payload.type === "automation_result") {
        if (payload.action === "automation_civitai_token_remove") civitaiToken.value = "";
        civitaiTokenStatus.textContent = payload.result?.saved ? "A Civitai token is saved." : "No Civitai token is saved.";
      } else if (payload.type === "automation_error") civitaiTokenStatus.textContent = "Could not update the Civitai token.";
      return;
    }
    if (payload?.action === "automation_workbook_settings_get") {
      if (payload.type === "automation_result") { if (!settingsDirty) showWorkbookSettings(payload.result.settings); settingsRoot.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-workbook-setting]").forEach(input => { input.disabled = false; }); renderCacheFiles(); settingsStatus.textContent = "Saved settings loaded."; }
      else if (payload.type === "automation_error") settingsStatus.textContent = "Could not load saved settings; reopen the panel to retry.";
    }
    if (payload?.action === "automation_workbook_settings_save") {
      settingsStatus.textContent = payload.type === "automation_result" ? "Advanced settings saved for the next start." : "Could not save settings. Check the values and try again.";
      if (payload.type === "automation_result") send("automation_drive_status");
    }
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
      if (payload.type === "automation_result" && Array.isArray(payload.result?.savedNames)) { savedCacheNames = new Set(payload.result.savedNames); renderCacheFiles(); }
      if (driveStatus) {
        if (payload.type === "automation_error") driveStatus.textContent = `Could not load saved cache selection: ${payload.error}.`;
        else if (payload.result?.saved && payload.result.missing?.length === 0) driveStatus.textContent = "Required cache files are saved. You do not need to select them again.";
        else if (payload.result?.saved) driveStatus.textContent = `Not cached in Drive; will download on startup: ${payload.result.missing.join(", ")}.`;
        else driveStatus.textContent = "No cache files are saved yet. Required files will download on startup.";
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
        auth_required: "Google authorization failed. The saved refresh token may have expired or been revoked, or the OAuth client may lack access. Reauthorize Google and update the automation credentials.",
        recovery_runtime_present: "A manager runtime is still present. Stop it before recovery.",
        recovery_intent_required: "No recoverable allocation record was found.",
        civitai_metadata_changed: "Civitai changed this file?s metadata. Look up and save the version again before starting.",
        civitai_selection_required: "Select and save a compatible Civitai checkpoint before starting Colab.",
        gateway_model_cache_update_required: "The gateway must be updated before starting this model. No runtime was allocated.",
        gateway_workbook_update_required: "The gateway must support extension-supplied workbooks before Colab can start. No runtime was allocated.",
      };
      if (payload.action === "automation_start" && payload.error === "bootstrap_result_pending") {
        automationStatus.dataset.tone = "unknown";
        automationStatus.textContent = "Checking the previous Colab startup...";
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
        send("automation_poll");
        return;
      }
      automationStatus.textContent = messages[payload.error] ?? `${payload.action}: ${payload.error}`;
      if (payload.action === "automation_save") pendingSecrets = null;
      if (payload.action === "automation_save_drive" && driveStatus) {
        driveStatus.textContent = "Selection not saved. Check the status message below.";
      }
    }
    if (automationStatus && payload?.type === "automation_result") {
      const result = payload.result ?? {};
      if (payload.action === "automation_save_drive" && result.saved) send("automation_drive_status");
      if (payload.action === "automation_save_drive" && result.saved && driveStatus) {
        driveStatus.textContent = result.complete
          ? "Required cache files are saved. You can now start Colab."
          : `Selection saved. Missing files will download on startup: ${(result.missing ?? []).join(", ")}.`;
      }
      if (payload.action === "automation_save" && result.saved && credentialsStatus) { credentialsStatus.textContent = "Credentials saved."; send("automation_credentials_status"); }
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
      if (payload.action === "automation_poll" && result.status === "running") automationStatus.textContent = "Colab startup is still in progress. Checking again in 10 seconds.";
      if (payload.action === "automation_poll" && result.status === "finished" && result.workerHealthy === true) automationStatus.textContent = "Colab is ready; worker is healthy.";
      if (payload.action === "automation_poll" && result.status === "finished") send("automation_lora_history_get");
      if (payload.action === "automation_poll" && result.status === "failed") {
        automationStatus.textContent = `The previous Colab startup failed: ${startupFailureText(result.error ?? "bootstrap_failed")} Check runtime before trying again.`;
        send("automation_last_startup_get");
      }
      if (payload.action === "automation_status") {
        if (result.worker) automationStatus.textContent += `; worker ${String(result.worker).replace(/_/g, " ")}`;
        if (result.jupyter) automationStatus.textContent += `; Jupyter connection ${result.jupyter}`;
        if (result.job) automationStatus.textContent += `; jobs ${result.job.state}${result.job.lastActivity ? `, last activity ${new Date(result.job.lastActivity).toLocaleTimeString()}` : ""}`;
        if (result.idle?.lastWorkAt) automationStatus.textContent += `; last gateway work ${new Date(result.idle.lastWorkAt).toLocaleTimeString()}`;
        if (result.lastRuntimeObservation) automationStatus.textContent += `; last runtime observation ${String(result.lastRuntimeObservation.event).replace(/_/g, " ")} at ${new Date(result.lastRuntimeObservation.at).toLocaleTimeString()}`;
      }
      if (payload.action === "automation_start" || (payload.action === "automation_poll" && result.status === "running")) {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, 10_000);
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

  send("automation_last_startup_get");
  send("automation_workflow_lora_get");
  send("automation_workflow_shift_get");
  send("automation_lora_history_get");
  send("automation_civitai_selection_get");
  send("automation_civitai_token_status");
  send("automation_picker_config_get");
  send("automation_gpu_choice_get");
  send("automation_drive_status");
  send("automation_credentials_status");
  send("automation_idle_get");
  send("automation_workbook_info");
  send("automation_workbook_settings_get");

  return () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (settingsTimer) clearTimeout(settingsTimer);
    if (tokenTimer) clearTimeout(tokenTimer);
    if (secretsTimer) clearTimeout(secretsTimer);
    for (const entry of saves.values()) if (entry.timer) clearTimeout(entry.timer);
    unsub();
    removeStyle();
    drawer.destroy();
  };
}
