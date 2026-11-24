/** Construct an importable API workflow only when the worker inventory is unambiguous. */
export type WorkflowLora = { name: string; weight: number };
export function validateWorkflowLora(value: unknown): WorkflowLora {
  const item = value as any;
  if (!item || typeof item.name !== "string" || item.name.length > 512 || /[\x00-\x1f\x7f]/.test(item.name) ||
      typeof item.weight !== "number" || !Number.isFinite(item.weight) || item.weight < -5 || item.weight > 5) throw new Error("workflow_lora_invalid");
  return { name: item.name, weight: item.weight };
}
export function workerLoraOptions(info: any): string[] {
  const options = info?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0];
  if (!Array.isArray(options) || options.length > 10000 || options.some(name => typeof name !== "string" || name.length > 512 || /[\x00-\x1f\x7f]/.test(name))) throw new Error("workflow_lora_inventory_invalid");
  return options;
}
export function workflowFromInventory(info: Record<string, any>, lora: WorkflowLora = { name: "", weight: 1 }) {
  lora = validateWorkflowLora(lora);
  const choices = (node: string, field: string): string[] => {
    const values = info[node]?.input?.required?.[field]?.[0];
    if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("workflow_inventory_invalid");
    return values;
  };
  const checkpoints = choices("UNETLoader", "unet_name");
  const encoders = choices("CLIPLoader", "clip_name");
  const vaes = choices("VAELoader", "vae_name");
  if (checkpoints.length !== 1) throw new Error("workflow_model_ambiguous");
  const anima = encoders.includes("qwen_3_06b_base.safetensors") && vaes.includes("qwen_image_vae.safetensors");
  const moss = encoders.includes("qwen3.5_9b_w4a8_gptq.safetensors") && vaes.includes("flux2-vae_small.safetensors");
  if (anima === moss) throw new Error("workflow_family_ambiguous");
  const turbo = anima && /turbo/i.test(checkpoints[0]);
  const prefix = anima ? "anima" : "moss";
  const graph: Record<string, any> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: checkpoints[0], weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: anima ? "qwen_3_06b_base.safetensors" : "qwen3.5_9b_w4a8_gptq.safetensors", type: anima ? "stable_diffusion" : "moss_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: anima ? "qwen_image_vae.safetensors" : "flux2-vae_small.safetensors" } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "a masterpiece illustration" } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "worst quality, low quality, blurry, watermark" } },
    "6": { class_type: anima ? "EmptyLatentImage" : "EmptyFlux2LatentImage", inputs: { width: 768, height: 768, batch_size: 1 } },
    "7": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], seed: 0, steps: turbo ? 10 : anima ? 30 : 25, cfg: turbo ? 1 : anima ? 4.5 : 2.5, sampler_name: "er_sde", scheduler: "simple", denoise: 1 } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: `${prefix}/image` } },
  };
  if (lora.name) {
    if (!workerLoraOptions(info).includes(lora.name)) throw new Error("workflow_lora_missing");
    const normalized = lora.name.replace(/\\/g, "/");
    if ((normalized.startsWith("moss/") || normalized.startsWith("anima/")) && !normalized.startsWith(`${prefix}/`)) throw new Error("workflow_lora_family_mismatch");
    graph["100"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: lora.name, strength_model: lora.weight } };
    graph["7"].inputs.model = ["100", 0];
  }
  return graph;
}
