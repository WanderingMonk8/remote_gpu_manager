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
}
export type GatewayCall = (path: string, method: string, token: string, body?: unknown) => Promise<any>;
const SECRETS = "automation-credentials-v1";
const STATE = "automation-tailnet-state-v1";
const DRIVE = "automation-drive-cache-v1";
const PICKER = "automation-picker-config-v1";
const GPU = "automation-gpu-preference-v1";
export type DriveFile = { id: string; name: string };
export type PickerConfig = { clientId: string; apiKey: string; projectNumber: string };
export type GpuPreference = { accelerator: string; shape: string };
export type GpuChoice = GpuPreference & { confirmNonDefault: boolean };
export function validGpuPreference(choice: any): choice is GpuPreference {
  return typeof choice?.accelerator === "string" && /^[A-Z0-9_]{1,40}$/.test(choice.accelerator) &&
    typeof choice?.shape === "string" && /^SHAPE_[A-Z0-9_]{1,40}$/.test(choice.shape);
}
const DEFAULT_FILES = ["moss_image_sft_int8_convrot.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"];
const MODEL_FILES = new Set([...DEFAULT_FILES, "moss_image_base_int8_convrot.safetensors", "qwen_3_06b_base.safetensors", "qwen_image_vae.safetensors",
  ...["base-v1.0", "turbo-v1.0", "turbo-v1.1", "aesthetic-v1.0", "aesthetic-v1.0b", "aesthetic-v1.1"].map(name => `anima-${name}.safetensors`)]);

export function driveSelectionIssue(files: DriveFile[]): string | null {
  if (!Array.isArray(files) || files.length === 0) return "drive_selection_empty";
  if (files.length > 16) return "drive_selection_too_many";
  if (files.some(f => !f || typeof f.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(f.id) || typeof f.name !== "string")) {
    return "drive_selection_metadata_missing";
  }
  if (files.some(f => !MODEL_FILES.has(f.name))) return "drive_selection_unrecognized";
  if (new Set(files.map(f => f.name)).size !== files.length) return "drive_selection_duplicate";
  return null;
}

export class AutomationController {
  constructor(private store: AutomationStore, private call: GatewayCall) {}

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
    if (!user || !config || typeof config.clientId !== "string" || !config.clientId.trim() ||
        typeof config.apiKey !== "string" || !config.apiKey.trim() ||
        typeof config.projectNumber !== "string" || !/^\d+$/.test(config.projectNumber.trim())) {
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
      if (!value || !value.trim()) throw new Error(`missing_${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`);
      merged[key] = value;
    }
    if (!/^[^:\s]+$/.test(merged.basicUser)) throw new Error("invalid_basic_user");
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
    const missing = DEFAULT_FILES.filter(name => !merged.has(name));
    await this.store.put(DRIVE, JSON.stringify(allFiles), user);
    return { saved: true, complete: missing.length === 0, missing };
  }

  async driveStatus(user: string): Promise<{ saved: boolean; missing: string[] }> {
    if (!user) throw new Error("user_required");
    const saved = await this.store.get(DRIVE, user);
    const files: DriveFile[] = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(files) || (files.length > 0 && driveSelectionIssue(files))) throw new Error("drive_selection_invalid");
    return { saved: files.length > 0, missing: DEFAULT_FILES.filter(name => !files.some(file => file.name === name)) };
  }

  private async secrets(user: string): Promise<AutomationSecrets> {
    if (!user) throw new Error("user_required");
    const saved = await this.store.get(SECRETS, user);
    if (!saved) throw new Error("credentials_required");
    return JSON.parse(saved) as AutomationSecrets;
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
    if (!savedDrive) throw new Error("drive_selection_required");
    const driveFiles = JSON.parse(savedDrive) as DriveFile[];
    if (!Array.isArray(driveFiles) || !DEFAULT_FILES.every(name => driveFiles.some(file => file?.name === name))) {
      throw new Error("drive_selection_incomplete");
    }
    const existing = await this.call("/gateway/v1/runtime/bootstrap", "GET", s.controlToken);
    if (existing.status !== "idle") throw new Error("bootstrap_result_pending");
    await this.call("/gateway/v1/runtime/credentials", "POST", s.controlToken,
      { client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken });
    await this.call("/gateway/v1/runtime/cache-check", "POST", s.controlToken, { files: driveFiles });
    const allocation = await this.call("/gateway/v1/runtime", "POST", s.controlToken, choice ? {
      accelerator: choice.accelerator, shape: choice.shape, confirm_non_default: choice.confirmNonDefault,
    } : undefined);
    // Do not rerun notebook setup on a reused runtime that may contain work.
    if (allocation.reused) throw new Error("runtime_already_exists");
    await this.call("/gateway/v1/runtime/bootstrap", "POST", s.controlToken,
      { ts_authkey: s.tailnetKey, basic_user: s.basicUser, basic_pass: s.basicPass, state, drive_files: driveFiles });
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

  async stop(user: string, force = false): Promise<any> {
    const s = await this.secrets(user);
    await this.call("/gateway/v1/runtime/credentials", "POST", s.controlToken,
      { client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken });
    // A restarted gateway discovers its owned runtime before deletion.
    await this.call("/gateway/v1/runtime", "GET", s.controlToken);
    return this.call(`/gateway/v1/runtime${force ? "?force=1" : ""}`, "DELETE", s.controlToken);
  }

  async idle(user: string, minutes: number): Promise<any> {
    const { controlToken } = await this.secrets(user);
    return this.call("/gateway/v1/runtime/idle", "PUT", controlToken, { minutes });
  }
}
