import { validateCivitaiSelection, type CivitaiSelection } from "./civitai";
import { requiredModelCacheVersion, requiredModelFiles, validateWorkbookSettings, type WorkbookSettings } from "./workbook-settings";
import { bundledWorkbook } from "./workbook";
/** Automation orchestration with injected enclave and loopback transport. */
export interface AutomationSecrets {
  controlToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tailnetKey: string;
  basicUser: string;
  basicPass: string;
}

export interface AutomationStore {
  get(key: string, user: string): Promise<string | null>;
  put(key: string, value: string, user: string): Promise<void>;
  delete?(key: string, user: string): Promise<void>;
}
export type GatewayCall = (path: string, method: string, token: string, body?: unknown) => Promise<any>;
const SECRETS = "automation-credentials-v1";
const STATE = "automation-tailnet-state-v1";
const DRIVE = "automation-drive-cache-v1";
const PICKER = "automation-picker-config-v1";
const GPU = "automation-gpu-preference-v1";
const IDLE = "automation-idle-preference-v1";
const CIVITAI_SELECTION = "automation-civitai-selection-v1";
const CIVITAI_TOKEN = "automation-civitai-token-v1";
const WORKBOOK_SETTINGS = "automation-workbook-settings-v1";
const IDLE_CHOICES = new Set([0, 5, 10, 15, 30]);
export type DriveFile = { id: string; name: string };
export type PickerConfig = { clientId: string; apiKey: string; projectNumber: string };
export type GpuPreference = { accelerator: string; shape: string };
export type GpuChoice = GpuPreference & { confirmNonDefault: boolean };
export function validGpuPreference(choice: any): choice is GpuPreference {
  return typeof choice?.accelerator === "string" && /^[A-Z0-9_]{1,40}$/.test(choice.accelerator) &&
    typeof choice?.shape === "string" && /^SHAPE_[A-Z0-9_]{1,40}$/.test(choice.shape);
}
const DEFAULT_FILES = ["moss_image_sft_int8_convrot.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"];
const MODEL_FILES = new Set([...DEFAULT_FILES, "moss_image_base_int8_convrot.safetensors", "moss_image_base_bf16.safetensors", "moss_image_sft_bf16.safetensors", "Anima-2.9B-preview-v1.safetensors", "Anima-2.9B-preview-v1_int8_convrot.safetensors", "qwen_3_06b_base.safetensors", "qwen_image_vae.safetensors",
  ...["base-v1.0", "turbo-v1.0", "turbo-v1.1", "aesthetic-v1.0", "aesthetic-v1.0b", "aesthetic-v1.1", "preview", "preview2", "preview3-base"].map(name => `anima-${name}.safetensors`)]);

export function driveSelectionIssue(files: DriveFile[]): string | null {
  if (!Array.isArray(files) || files.length === 0) return "drive_selection_empty";
  if (files.length > 64) return "drive_selection_too_many";
  if (files.some(f => !f || typeof f.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(f.id) || typeof f.name !== "string")) {
    return "drive_selection_metadata_missing";
  }
  if (files.some(f => !MODEL_FILES.has(f.name))) return "drive_selection_unrecognized";
  if (new Set(files.map(f => f.name)).size !== files.length) return "drive_selection_duplicate";
  return null;
}

export class AutomationController {
  constructor(private store: AutomationStore, private call: GatewayCall) {}

  async saveCivitaiSelection(user: string, selection: unknown): Promise<void> {
    if (!user) throw new Error("user_required");
    await this.store.put(CIVITAI_SELECTION, JSON.stringify(validateCivitaiSelection(selection)).replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`), user);
  }

  async getCivitaiSelection(user: string): Promise<CivitaiSelection | null> {
    if (!user) throw new Error("user_required");
    const raw = await this.store.get(CIVITAI_SELECTION, user);
    return raw ? validateCivitaiSelection(JSON.parse(raw)) : null;
  }

  private async cacheRequirements(user: string, model: string): Promise<string[]> {
    if (model !== "Custom Civitai") return requiredModelFiles(model);
    const selection = await this.getCivitaiSelection(user);
    if (!selection) return [];
    return selection.version.family === "anima" ? ["qwen_3_06b_base.safetensors", "qwen_image_vae.safetensors"] : ["qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"];
  }

  private civitaiCacheKey(selection: CivitaiSelection): string {
    return `automation-civitai-cache-${selection.version.id}-${selection.fileId}`;
  }

  async getCivitaiCache(user: string): Promise<DriveFile | null> {
    const selection = await this.getCivitaiSelection(user);
    if (!selection) return null;
    const raw = await this.store.get(this.civitaiCacheKey(selection), user);
    if (!raw) return null;
    const file = JSON.parse(raw);
    const expected = selection.version.files.find(f => f.id === selection.fileId)?.name;
    if (!file || file.name !== expected || typeof file.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(file.id)) throw new Error("civitai_cache_invalid");
    return { id: file.id, name: file.name };
  }

  async saveCivitaiCache(user: string, files: DriveFile[]): Promise<void> {
    const selection = await this.getCivitaiSelection(user);
    if (!selection) throw new Error("civitai_selection_required");
    const expected = selection.version.files.find(f => f.id === selection.fileId)?.name;
    if (!Array.isArray(files) || files.length !== 1 || files[0]?.name !== expected || typeof files[0].id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(files[0].id)) throw new Error("civitai_cache_invalid");
    await this.store.put(this.civitaiCacheKey(selection), JSON.stringify({ id: files[0].id, name: files[0].name }).replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`), user);
  }

  async saveCivitaiToken(user: string, token: unknown): Promise<void> {
    if (!user) throw new Error("user_required");
    if (typeof token !== "string" || token.length > 1024 || /[^\x21-\x7e]/.test(token)) throw new Error("civitai_token_invalid");
    if (token) await this.store.put(CIVITAI_TOKEN, token, user);
  }

  async removeCivitaiToken(user: string): Promise<void> {
    if (!user) throw new Error("user_required");
    if (this.store.delete) await this.store.delete(CIVITAI_TOKEN, user);
    else await this.store.put(CIVITAI_TOKEN, "", user);
  }

  async civitaiTokenStatus(user: string): Promise<{ saved: boolean }> {
    if (!user) throw new Error("user_required");
    return { saved: Boolean(await this.store.get(CIVITAI_TOKEN, user)) };
  }

  async civitaiToken(user: string): Promise<string> {
    if (!user) throw new Error("user_required");
    return (await this.store.get(CIVITAI_TOKEN, user)) ?? "";
  }

  async saveWorkbookSettings(user: string, input: unknown): Promise<void> {
    if (!user) throw new Error("user_required");
    const settings = validateWorkbookSettings(input);
    await this.store.put(WORKBOOK_SETTINGS, JSON.stringify(settings), user);
  }

  async getWorkbookSettings(user: string): Promise<WorkbookSettings> {
    if (!user) throw new Error("user_required");
    const saved = await this.store.get(WORKBOOK_SETTINGS, user);
    return validateWorkbookSettings(saved ? JSON.parse(saved) : {});
  }

  async saveGpuPreference(user: string, choice: GpuPreference): Promise<void> {
    if (!user) throw new Error("user_required");
    if (!validGpuPreference(choice)) throw new Error("gpu_preference_invalid");
    await this.store.put(GPU, JSON.stringify({ accelerator: choice.accelerator, shape: choice.shape }), user);
  }

  async getGpuPreference(user: string): Promise<GpuPreference | null> {
    if (!user) throw new Error("user_required");
    const saved = await this.store.get(GPU, user);
    if (!saved) return null;
    const choice = JSON.parse(saved);
    if (!validGpuPreference(choice)) throw new Error("gpu_preference_invalid");
    return { accelerator: choice.accelerator, shape: choice.shape };
  }

  async savePickerConfig(user: string, config: PickerConfig): Promise<void> {
    if (!user || !config || typeof config.clientId !== "string" ||
        typeof config.apiKey !== "string" || typeof config.projectNumber !== "string" ||
        (config.projectNumber.trim() !== "" && !/^\d+$/.test(config.projectNumber.trim()))) {
      throw new Error("picker_config_invalid");
    }
    await this.store.put(PICKER, JSON.stringify({ clientId: config.clientId.trim(), apiKey: config.apiKey.trim(),
      projectNumber: config.projectNumber.trim() }), user);
  }

  async getPickerConfig(user: string): Promise<PickerConfig | null> {
    if (!user) throw new Error("user_required");
    const saved = await this.store.get(PICKER, user);
    if (!saved) return null;
    const config = JSON.parse(saved);
    return { clientId: config.clientId, apiKey: config.apiKey, projectNumber: config.projectNumber };
  }

  async save(user: string, secrets: AutomationSecrets): Promise<void> {
    if (!user || !secrets || typeof secrets !== "object") throw new Error("invalid_credentials");
    const saved = await this.store.get(SECRETS, user);
    const previous: Partial<AutomationSecrets> = saved ? JSON.parse(saved) : {};
    const keys: (keyof AutomationSecrets)[] = ["controlToken", "clientId", "clientSecret", "refreshToken", "tailnetKey", "basicUser", "basicPass"];
    const merged = {} as AutomationSecrets;
    for (const key of keys) {
      const incoming = secrets[key];
      if (incoming !== undefined && typeof incoming !== "string") throw new Error("invalid_credentials");
      const value = incoming?.trim() ? incoming : previous[key];
      merged[key] = value || "";
    }
    if (merged.basicUser && !/^[^:\s]+$/.test(merged.basicUser)) throw new Error("invalid_basic_user");
    await this.store.put(SECRETS, JSON.stringify(merged), user);
  }

  async saveDriveFiles(user: string, files: DriveFile[]): Promise<{ saved: true; complete: boolean; missing: string[] }> {
    if (!user) throw new Error("user_required");
    const issue = driveSelectionIssue(files);
    if (issue) throw new Error(issue);
    const saved = await this.store.get(DRIVE, user);
    const previous = saved ? JSON.parse(saved) as DriveFile[] : [];
    const merged = new Map(previous.map(file => [file.name, file]));
    for (const file of files) merged.set(file.name, { id: file.id, name: file.name });
    const allFiles = [...merged.values()];
    const model = String((await this.getWorkbookSettings(user)).MODEL_CHOICE);
    const missing = (await this.cacheRequirements(user, model)).filter(name => !merged.has(name));
    await this.store.put(DRIVE, JSON.stringify(allFiles), user);
    return { saved: true, complete: missing.length === 0, missing };
  }

  async credentialsStatus(user: string): Promise<{ saved: boolean }> {
    if (!user) throw new Error("user_required");
    const saved = await this.store.get(SECRETS, user);
    const values = saved ? JSON.parse(saved) : {};
    return { saved: ["controlToken", "clientId", "clientSecret", "refreshToken", "tailnetKey", "basicUser", "basicPass"].every(key => typeof values[key] === "string" && values[key].trim()) };
  }

  async driveStatus(user: string): Promise<{ saved: boolean; missing: string[]; savedNames: string[] }> {
    if (!user) throw new Error("user_required");
    const saved = await this.store.get(DRIVE, user);
    const files: DriveFile[] = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(files) || (files.length > 0 && driveSelectionIssue(files))) throw new Error("drive_selection_invalid");
    const model = String((await this.getWorkbookSettings(user)).MODEL_CHOICE);
    return { saved: files.length > 0, missing: (await this.cacheRequirements(user, model)).filter(name => !files.some(file => file.name === name)), savedNames: files.map(file => file.name) };
  }

  private async secrets(user: string): Promise<AutomationSecrets> {
    if (!user) throw new Error("user_required");
    const saved = await this.store.get(SECRETS, user);
    if (!saved) throw new Error("credentials_required");
    const values = JSON.parse(saved) as AutomationSecrets;
    for (const key of ["controlToken", "clientId", "clientSecret", "refreshToken", "tailnetKey", "basicUser", "basicPass"] as const) {
      if (typeof values[key] !== "string" || !values[key].trim()) throw new Error(`missing_${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`);
    }
    return values;
  }

  async status(user: string): Promise<any> {
    const s = await this.secrets(user);
    await this.call("/gateway/v1/runtime/credentials", "POST", s.controlToken,
      { client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken });
    return this.call("/gateway/v1/runtime", "GET", s.controlToken);
  }

  async gpuSpecs(user: string): Promise<any> {
    const s = await this.secrets(user);
    await this.call("/gateway/v1/runtime/credentials", "POST", s.controlToken,
      { client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken });
    return this.call("/gateway/v1/runtime/specs", "GET", s.controlToken);
  }

  async start(user: string, choice?: GpuChoice): Promise<void> {
    const s = await this.secrets(user);
    if (choice) await this.saveGpuPreference(user, choice);
    const savedState = await this.store.get(STATE, user);
    const state = savedState ? JSON.parse(savedState) : {};
    const savedDrive = await this.store.get(DRIVE, user);
    const driveFiles = savedDrive ? JSON.parse(savedDrive) as DriveFile[] : [];
    if (!Array.isArray(driveFiles) || (driveFiles.length > 0 && driveSelectionIssue(driveFiles))) throw new Error("drive_selection_invalid");
    const workbookSettings = await this.getWorkbookSettings(user);
    const custom = workbookSettings.MODEL_CHOICE === "Custom Civitai" ? await this.getCivitaiSelection(user) : null;
    if (workbookSettings.MODEL_CHOICE === "Custom Civitai" && !custom) throw new Error("civitai_selection_required");
    const requiredFiles = await this.cacheRequirements(user, String(workbookSettings.MODEL_CHOICE));
    const customCache = custom ? await this.getCivitaiCache(user) : null;
    const filesToRestore = driveFiles.filter(file => requiredFiles.includes(file.name));
    if (customCache) filesToRestore.push(customCache);
    const existing = await this.call("/gateway/v1/runtime/bootstrap", "GET", s.controlToken);
    if (existing.status !== "idle") throw new Error("bootstrap_result_pending");
    if (existing.workbook_transfer !== 1 || existing.bootstrap_allocation !== 1) throw new Error("gateway_workbook_update_required");
    if ((existing.model_cache ?? 1) < requiredModelCacheVersion(String(workbookSettings.MODEL_CHOICE))) throw new Error("gateway_model_cache_update_required");
    const workbook = await bundledWorkbook(workbookSettings);
    await this.call("/gateway/v1/runtime/workbook-check", "POST", s.controlToken, { workbook });
    await this.call("/gateway/v1/runtime/credentials", "POST", s.controlToken,
      { client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken });
    if (filesToRestore.length) await this.call("/gateway/v1/runtime/cache-check", "POST", s.controlToken, { files: filesToRestore });
    const idleMinutes = await this.getIdlePreference(user);
    if (idleMinutes !== null) await this.call("/gateway/v1/runtime/idle", "PUT", s.controlToken, { minutes: idleMinutes });
    await this.call("/gateway/v1/runtime/bootstrap", "POST", s.controlToken,
      { allocate: choice ? { accelerator: choice.accelerator, shape: choice.shape, confirm_non_default: choice.confirmNonDefault } : {},
        ts_authkey: s.tailnetKey, basic_user: s.basicUser, basic_pass: s.basicPass, state, drive_files: filesToRestore, workbook, ...(custom ? { civitai: { ...custom, token: await this.civitaiToken(user) } } : {}) });
  }

  async poll(user: string): Promise<{ status: string; workerHealthy?: boolean; error?: string }> {
    const { controlToken } = await this.secrets(user);
    const job = await this.call("/gateway/v1/runtime/bootstrap", "GET", controlToken);
    if (job.status !== "finished") return { status: job.status };
    if (job.httpStatus !== 200 || !job.result?.ok) {
      // Clear only after capturing a nonsecret failure, permitting an explicit retry.
      const error = typeof job.result?.error === "string" ? job.result.error : "bootstrap_failed";
      await this.call("/gateway/v1/runtime/bootstrap", "DELETE", controlToken);
      return { status: "failed", error };
    }
    if (!job.result.state || typeof job.result.state["tailscaled.state"] !== "string") {
      throw new Error("identity_missing");
    }
    // Save before acknowledging: an enclave failure must leave the job recoverable.
    await this.store.put(STATE, JSON.stringify(job.result.state), user);
    await this.call("/gateway/v1/runtime/bootstrap", "DELETE", controlToken);
    return { status: "finished", workerHealthy: job.result.workerHealthy === true,
      ...(typeof job.result.error === "string" && /^[a-z_]+$/.test(job.result.error) ? { error: job.result.error } : {}) };
  }

  async recover(user: string): Promise<any> {
    const s = await this.secrets(user);
    await this.call("/gateway/v1/runtime/credentials", "POST", s.controlToken,
      { client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken });
    return this.call("/gateway/v1/runtime/recover", "POST", s.controlToken, { confirmed: true });
  }

  async stop(user: string, force = false): Promise<any> {
    const s = await this.secrets(user);
    await this.call("/gateway/v1/runtime/credentials", "POST", s.controlToken,
      { client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken });
    // A restarted gateway discovers its owned runtime before deletion.
    await this.call("/gateway/v1/runtime", "GET", s.controlToken);
    return this.call(`/gateway/v1/runtime${force ? "?force=1" : ""}`, "DELETE", s.controlToken);
  }

  async getIdlePreference(user: string): Promise<number | null> {
    if (!user) throw new Error("user_required");
    const saved = await this.store.get(IDLE, user);
    if (saved === null) return null;
    const minutes = JSON.parse(saved);
    if (typeof minutes !== "number" || !IDLE_CHOICES.has(minutes)) throw new Error("idle_minutes_invalid");
    return minutes;
  }

  async idle(user: string, minutes: number): Promise<any> {
    if (!IDLE_CHOICES.has(minutes)) throw new Error("idle_minutes_invalid");
    const { controlToken } = await this.secrets(user);
    const result = await this.call("/gateway/v1/runtime/idle", "PUT", controlToken, { minutes });
    await this.store.put(IDLE, JSON.stringify(minutes), user);
    return result;
  }
}
