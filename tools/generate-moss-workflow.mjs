/**
 * Generate the clean baseline ComfyUI API-format workflow templates for the
 * two supported families. These are the exact graphs the unified notebook
 * emits (cell 20/§10, `build_workflow()` with no LoRAs, no reference adapter),
 * with neutral placeholder prompts — Lumiverse injects the real prompt/params
 * through workflow field mappings at generation time.
 *
 * Outputs:
 *   workflows/moss-api.json          MOSS SFT INT8 (default)
 *   workflows/anima-turbo-v1.1-api.json
 *
 * NOT yet verified against a live ComfyUI. Requires a warm MOSS+Anima worker
 * (or the mock, which only checks structure). See docs/m1-warm-connectivity.md.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "workflows");
mkdirSync(outDir, { recursive: true });

function node(g, id, classType, inputs) {
  g[String(id)] = { class_type: classType, inputs };
  return [String(id), 0];
}

function build({
  unet,
  clipName,
  clipType,
  vae,
  latent,
  width,
  height,
  steps,
  cfg,
  sampler = "er_sde",
  scheduler = "simple",
  prefix,
}) {
  const g = {};
  const m = node(g, 1, "UNETLoader", { unet_name: unet, weight_dtype: "default" });
  const clip = node(g, 2, "CLIPLoader", { clip_name: clipName, type: clipType, device: "default" });
  const v = node(g, 3, "VAELoader", { vae_name: vae });
  const pos = node(g, 4, "CLIPTextEncode", { clip, text: "a masterpiece illustration" });
  const neg = node(g, 5, "CLIPTextEncode", { clip, text: "worst quality, low quality, blurry, watermark" });
  const lat = node(g, 6, latent, { width, height, batch_size: 1 });
  const sampled = node(g, 7, "KSampler", {
    model: m,
    positive: pos,
    negative: neg,
    latent_image: lat,
    seed: -1, // mapped to a random seed by Lumiverse per run (seed -1 semantics)
    steps,
    cfg,
    sampler_name: sampler,
    scheduler,
    denoise: 1.0,
  });
  const decoded = node(g, 8, "VAEDecode", { samples: sampled, vae: v });
  node(g, 9, "SaveImage", { images: decoded, filename_prefix: prefix });
  return g;
}

const templates = {
  "moss-api.json": build({
    unet: "moss_image_sft_int8_convrot.safetensors",
    clipName: "qwen3.5_9b_w4a8_gptq.safetensors",
    clipType: "moss_image",
    vae: "flux2-vae_small.safetensors",
    latent: "EmptyFlux2LatentImage",
    width: 768,
    height: 768,
    steps: 25,
    cfg: 2.5,
    prefix: "moss/image",
  }),
  "anima-turbo-v1.1-api.json": build({
    unet: "anima-turbo-v1.1.safetensors",
    clipName: "qwen_3_06b_base.safetensors",
    clipType: "stable_diffusion",
    vae: "qwen_image_vae.safetensors",
    latent: "EmptyLatentImage",
    width: 768,
    height: 768,
    steps: 10,
    cfg: 1.0,
    prefix: "anima/image",
  }),
};

for (const [file, graph] of Object.entries(templates)) {
  const path = join(outDir, file);
  writeFileSync(path, JSON.stringify(graph, null, 2) + "\n", "utf8");
  console.log(`wrote ${path}`);
}
console.log("\nNOTE: unverified until run against a live ComfyUI (see docs/m1-warm-connectivity.md).");
