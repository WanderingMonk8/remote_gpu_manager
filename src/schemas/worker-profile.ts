/**
 * Worker / Runtime profile — the typed desired configuration for a managed instance.
 * Adaptation of the v1.1 NotebookProfile schema to Vast.ai.
 *
 * This is the only schema consumed by the extension and (later) the worker.
 * Unknown fields are rejected; unsupported options must fail at validation.
 */

export type ApplyMode = "next_job" | "hot" | "idle" | "restart_worker" | "reprovision";

export interface WorkerProfile {
  schemaVersion: 1;
  id: string;
  revision: number;
  provider: {
    driverId: "vastai";
    runtimeSpecId?: string;
  };
  bootstrap: {
    comfyRevision: string; // git commit/tag of ComfyUI pinned build
    modelProfileId: string; // e.g. "moss-sft-int8" | "anima-turbo-v1.1" | ...
    encoderId: string; // e.g. "qwen3.5_9b_w4a8_gptq.safetensors"
    vaeId: string; // e.g. "flux2-vae_small.safetensors"
  };
  storage: {
    presetId: string; // "s3-bucket" | "r2" | "local-disk" | "volume"
    persistAssets: boolean;
    restorePolicy: "required" | "cached" | "none";
    persistOutputs: boolean;
  };
  worker: {
    memoryMode: "lowvram" | "normalvram" | "normalvram-high-mem";
    cachePolicy: "evict-on-budget" | "keep-hot" | "none";
    logLevel: "debug" | "info" | "warn" | "error";
    maxConcurrency: number; // default 1
  };
  generationDefaults: {
    width: number; height: number; steps: number; cfg: number;
    seed: number;
    sampler: string; // 'er_sde' | 'euler' | 'dpmpp_2m' etc. (validated below)
    scheduler: string; // 'simple' | 'normal' | 'beta'
    clipDevice: "default" | "cpu";
    loraLoader: "LoraLoaderModelOnly" | "LoraLoaderBypassModelOnly";
  };
  tunnel: {
    enabled: boolean;
    endpointMode: "dynamic" | "static" | "proxy";
    approvedDomain?: string;
    credentialRef?: string; // opaque enclave reference
  };
  assets: {
    pinnedAssetIds: string[];
    civitaiCredentialRef?: string; // opaque enclave reference; sent only on Civitai destinations
  };
  lifecycle: {
    autoStart: boolean;
    idleMinutes: number | null; // 5/10/15/30; null = disabled
    maxRuntimeMinutes?: number; // hard cap
    jobTimeoutSeconds: number;
  };
}

const knownKeys = new Set([
  "schemaVersion", "id", "revision", "provider", "bootstrap", "storage",
  "worker", "generationDefaults", "tunnel", "assets", "lifecycle",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function rejectUnknown(obj: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new Error(`Unknown field '${path}${k}'`);
  }
}

export function validateWorkerProfile(raw: unknown): WorkerProfile {
  if (!isPlainObject(raw)) throw new Error("profile must be an object");
  rejectUnknown(raw, knownKeys, "");
  const p = raw as Record<string, unknown>;

  if (p.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (typeof p.id !== "string" || p.id.trim() === "") throw new Error("id must be a non-empty string");
  const revision = Number(p.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("revision must be a positive integer");

  const provider = p.provider as Record<string, unknown> | undefined;
  if (!provider || provider.driverId !== "vastai") throw new Error('provider.driverId must be "vastai"');

  const bootstrap = p.bootstrap as Record<string, unknown> | undefined;
  for (const k of ["comfyRevision", "modelProfileId", "encoderId", "vaeId"]) {
    if (!bootstrap || typeof bootstrap[k] !== "string" || (bootstrap[k] as string).trim() === "") {
      throw new Error(`bootstrap.${k} must be a non-empty string`);
    }
  }

  const worker = p.worker as Record<string, unknown> | undefined;
  if (!worker) throw new Error("worker must be an object");
  if (!["lowvram", "normalvram", "normalvram-high-mem"].includes(worker.memoryMode as string)) {
    throw new Error("worker.memoryMode must be one of lowvram | normalvram | normalvram-high-mem");
  }
  if (!["evict-on-budget", "keep-hot", "none"].includes(worker.cachePolicy as string)) {
    throw new Error("worker.cachePolicy must be one of evict-on-budget | keep-hot | none");
  }
  if (!["debug", "info", "warn", "error"].includes(worker.logLevel as string)) {
    throw new Error("worker.logLevel must be debug | info | warn | error");
  }
  const maxConcurrency = Number(worker.maxConcurrency ?? 1);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
    throw new Error("worker.maxConcurrency must be an integer in [1,8]");
  }

  const gen = p.generationDefaults as Record<string, unknown> | undefined;
  if (!gen) throw new Error("generationDefaults must be an object");
  for (const k of ["width", "height", "steps", "cfg"]) {
    if (typeof gen[k] !== "number" || !Number.isFinite(gen[k])) {
      throw new Error(`generationDefaults.${k} must be a finite number`);
    }
  }
  if ((gen.width as number) < 256 || (gen.height as number) < 256) {
    throw new Error("generationDefaults dimensions must be >= 256");
  }
  if ((gen.width as number) % 16 !== 0 || (gen.height as number) % 16 !== 0) {
    throw new Error("generationDefaults dimensions must be multiples of 16");
  }
  if (typeof gen.seed !== "number" || !Number.isFinite(gen.seed)) {
    throw new Error("generationDefaults.seed must be a finite number");
  }
  if (!["er_sde", "euler", "dpmpp_2m"].includes(gen.sampler as string)) {
    throw new Error("generationDefaults.sampler must be er_sde | euler | dpmpp_2m (known schedulers)");
  }
  if (!["simple", "normal", "beta"].includes(gen.scheduler as string)) {
    throw new Error("generationDefaults.scheduler must be simple | normal | beta");
  }
  if ((gen.loraLoader as string) !== "LoraLoaderModelOnly") {
    // Bypass variant is only valid for compatible Anima builds; keep validation strict until tested.
    if (gen.loraLoader !== "LoraLoaderBypassModelOnly") {
      throw new Error("generationDefaults.loraLoader must be LoraLoaderModelOnly (default for MOSS) or LoraLoaderBypassModelOnly (Anima, if compatible)");
    }
  }

  const lifecycle = p.lifecycle as Record<string, unknown> | undefined;
  if (!lifecycle) throw new Error("lifecycle must be an object");
  if (typeof lifecycle.autoStart !== "boolean") throw new Error("lifecycle.autoStart must be boolean");
  if (lifecycle.idleMinutes !== null && ![5, 10, 15, 30].includes(lifecycle.idleMinutes as number)) {
    if (lifecycle.idleMinutes === 0) {
      throw new Error("lifecycle.idleMinutes cannot be 0; use null to disable");
    } else if (typeof lifecycle.idleMinutes !== "number") {
      throw new Error("lifecycle.idleMinutes must be one of 5, 10, 15, 30, or null");
    }
  }
  if (typeof lifecycle.jobTimeoutSeconds !== "number" || lifecycle.jobTimeoutSeconds <= 0) {
    throw new Error("lifecycle.jobTimeoutSeconds must be a positive number");
  }

  return raw as unknown as WorkerProfile;
}

export function defaultWorkerProfile(): WorkerProfile {
  return {
    schemaVersion: 1,
    id: "moss-default",
    revision: 1,
    provider: { driverId: "vastai" },
    bootstrap: {
      comfyRevision: "pinned-at-worker-build",
      modelProfileId: "moss-sft-int8",
      encoderId: "qwen3.5_9b_w4a8_gptq.safetensors",
      vaeId: "flux2-vae_small.safetensors",
    },
    storage: {
      presetId: "bucket",
      persistAssets: true,
      restorePolicy: "cached",
      persistOutputs: false,
    },
    worker: {
      memoryMode: "lowvram",
      cachePolicy: "evict-on-budget",
      logLevel: "info",
      maxConcurrency: 1,
    },
    generationDefaults: {
      width: 768,
      height: 768,
      steps: 25,
      cfg: 2.5,
      seed: -1,
      sampler: "er_sde",
      scheduler: "simple",
      clipDevice: "default",
      loraLoader: "LoraLoaderModelOnly",
    },
    tunnel: { enabled: false, endpointMode: "dynamic" },
    assets: { pinnedAssetIds: [] },
    lifecycle: { autoStart: false, idleMinutes: 10, maxRuntimeMinutes: undefined, jobTimeoutSeconds: 1800 },
  };
}
