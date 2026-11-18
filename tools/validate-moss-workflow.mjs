/**
 * Structural validation for the baseline workflow templates.
 * Checks (no ComfyUI required): node shape, referenced-node integrity,
 * required inputs per known node type, family constraints (MOSS must use
 * EmptyFlux2LatentImage + moss_image clip; Anima must use EmptyLatentImage).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "workflows");

const REQUIRED = {
  UNETLoader: ["unet_name", "weight_dtype"],
  CLIPLoader: ["clip_name", "type"],
  VAELoader: ["vae_name"],
  CLIPTextEncode: ["clip", "text"],
  KSampler: ["model", "positive", "negative", "latent_image", "seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  VAEDecode: ["samples", "vae"],
  SaveImage: ["images", "filename_prefix"],
};

let failures = 0;

const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string";

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const path = join(dir, file);
  const g = JSON.parse(readFileSync(path, "utf8"));
  const problems = [];

  for (const [id, node] of Object.entries(g)) {
    if (!node.class_type || typeof node.inputs !== "object") {
      problems.push(`node ${id}: missing class_type/inputs`);
      continue;
    }
    for (const field of REQUIRED[node.class_type] ?? []) {
      if (!(field in node.inputs)) problems.push(`node ${id} (${node.class_type}): missing required input ${field}`);
    }
    for (const [field, value] of Object.entries(node.inputs)) {
      if (isLink(value) && !(value[0] in g)) {
        problems.push(`node ${id}: input ${field} references missing node ${value[0]}`);
      }
    }
  }

  const ids = Object.keys(g);
  for (const expected of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
    if (!ids.includes(expected)) problems.push(`missing baseline node id ${expected}`);
  }

  if (file.startsWith("moss")) {
    if (g["6"]?.class_type !== "EmptyFlux2LatentImage") problems.push("moss template must use EmptyFlux2LatentImage");
    if (g["2"]?.inputs?.type !== "moss_image") problems.push("moss template must use CLIPLoader type moss_image");
  }
  if (file.startsWith("anima")) {
    if (g["6"]?.class_type !== "EmptyLatentImage") problems.push("anima template must use EmptyLatentImage");
    if (g["2"]?.inputs?.type === "moss_image") problems.push("anima template must not use moss_image clip type");
  }

  if (problems.length) {
    failures++;
    console.error(`FAIL ${file}:`);
    for (const p of problems) console.error(`  - ${p}`);
  } else {
    console.log(`OK   ${file} (nodes: ${ids.length}, prefix ${g["9"]?.inputs?.filename_prefix})`);
  }
}

process.exit(failures ? 1 : 0);
