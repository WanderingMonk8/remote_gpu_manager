/** Supported noninteractive workbook startup preferences. */
export const workbookSettings = [
  { key: "MODEL_CHOICE", label: "Model for next startup", type: "select", default: "MOSS SFT INT8", options: ["Anima Preview", "Anima Preview 2", "Anima Preview 3 Base", "Anima Base v1.0", "Anima Aesthetic v1.0", "Anima Turbo v1.0", "Anima Aesthetic v1.0b", "Anima Aesthetic v1.1", "Anima 2.9B Preview BF16", "Anima 2.9B Preview INT8", "Anima Turbo v1.1", "MOSS Base BF16", "MOSS Base INT8", "MOSS SFT BF16", "MOSS SFT INT8"] },
  { key: "UPDATE_COMFYUI", label: "Update ComfyUI during startup", type: "boolean", default: false },
  { key: "INSTALL_ANIMA_ADAPTER", label: "Install Anima reference adapter", type: "boolean", default: true },
  { key: "DOWNLOAD_ADAPTER_WEIGHTS", label: "Download Anima adapter weights", type: "boolean", default: false },
  { key: "LIFECYCLE", label: "Enable workbook supervisor", type: "boolean", default: true },
  { key: "BEAT_SECONDS", label: "Supervisor interval (seconds)", type: "integer", default: 30, min: 5, max: 3600 },
  { key: "PROBE_EVERY_BEATS", label: "Health probe interval (beats)", type: "integer", default: 10, min: 1, max: 1000 },
  { key: "MIRROR_EVERY_BEATS", label: "State mirror interval (beats)", type: "integer", default: 30, min: 1, max: 1000 },
  { key: "RESTART_HUNG_COMFY", label: "Restart unresponsive ComfyUI (may interrupt long jobs)", type: "boolean", default: false },
  { key: "LORA_URLS", label: "LoRA download URLs (installed at startup)", type: "text", default: "https://huggingface.co/axiomofmind/Moss-image-nsfw-uncensored-lora/resolve/main/MOSS-Image-NSFW-Uncensored-LoRA-ComfyUI.safetensors?download=true" },
  { key: "VRAM_MODE", label: "VRAM mode", type: "select", default: "normalvram", options: ["normalvram", "lowvram"] },
] as const;

export type WorkbookSettings = Record<string, boolean | number | string>;
export function validateWorkbookSettings(input: unknown): WorkbookSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workbook_settings_invalid");
  const obj = input as Record<string, unknown>;
  if (Object.keys(obj).some(key => !workbookSettings.some(field => field.key === key))) throw new Error("workbook_settings_invalid");
  const values: WorkbookSettings = {};
  for (const field of workbookSettings) {
    const value = obj[field.key] ?? field.default;
    if (field.type === "boolean" && typeof value !== "boolean") throw new Error("workbook_settings_invalid");
    if (field.type === "integer" && (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max)) throw new Error("workbook_settings_invalid");
    if (field.type === "text" && (typeof value !== "string" || value.length > 8192 || value.includes("\u0000"))) throw new Error("workbook_settings_invalid");
    if (field.type === "select" && (typeof value !== "string" || !(field.options as readonly string[]).includes(value))) throw new Error("workbook_settings_invalid");
    values[field.key] = value as boolean | number | string;
  }
  return values;
}

export function requiredModelFiles(model: string): string[] {
  if (/^MOSS (SFT|Base) (INT8|BF16)$/.test(model)) {
    const flavor = model.includes("SFT") ? "sft" : "base";
    const format = model.endsWith("BF16") ? "bf16" : "int8_convrot";
    return [`moss_image_${flavor}_${format}.safetensors`, "qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"];
  }
  const checkpoints: Record<string, string> = {
    "Anima Preview": "anima-preview.safetensors", "Anima Preview 2": "anima-preview2.safetensors",
    "Anima Preview 3 Base": "anima-preview3-base.safetensors", "Anima 2.9B Preview BF16": "Anima-2.9B-preview-v1.safetensors",
    "Anima 2.9B Preview INT8": "Anima-2.9B-preview-v1_int8_convrot.safetensors",
    "Anima Turbo v1.1": "anima-turbo-v1.1.safetensors", "Anima Aesthetic v1.1": "anima-aesthetic-v1.1.safetensors",
    "Anima Base v1.0": "anima-base-v1.0.safetensors", "Anima Turbo v1.0": "anima-turbo-v1.0.safetensors",
    "Anima Aesthetic v1.0": "anima-aesthetic-v1.0.safetensors", "Anima Aesthetic v1.0b": "anima-aesthetic-v1.0b.safetensors",
  };
  if (!checkpoints[model]) throw new Error("workbook_settings_invalid");
  return [checkpoints[model], "qwen_3_06b_base.safetensors", "qwen_image_vae.safetensors"];
}

/** Gateway v3 knows the expanded model catalog. */
export function requiredModelCacheVersion(model: string): number {
  return ["MOSS SFT BF16", "MOSS Base BF16", "Anima Preview", "Anima Preview 2", "Anima Preview 3 Base", "Anima 2.9B Preview BF16", "Anima 2.9B Preview INT8"].includes(model) ? 3 : model === "MOSS SFT INT8" ? 1 : 2;
}
