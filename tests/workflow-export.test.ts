import { describe, expect, test } from "bun:test";
import { workflowFromInventory } from "../src/workflow-export";

const inventory = (models: string[], encoder: string[], vae: string[]) => ({
  UNETLoader: { input: { required: { unet_name: [models] } } },
  CLIPLoader: { input: { required: { clip_name: [encoder] } } },
  VAELoader: { input: { required: { vae_name: [vae] } } },
});

describe("worker workflow export", () => {
  test("uses the actual worker checkpoint and Anima components", () => {
    const graph = workflowFromInventory(inventory(["Anima-2.9B-preview-v1.safetensors"], ["qwen_3_06b_base.safetensors"], ["qwen_image_vae.safetensors"]));
    expect(graph["1"].inputs.unet_name).toBe("Anima-2.9B-preview-v1.safetensors");
    expect(graph["2"].inputs.type).toBe("stable_diffusion");
    expect(graph["6"].class_type).toBe("EmptyLatentImage");
  });
  test("refuses ambiguous checkpoints or families", () => {
    expect(() => workflowFromInventory(inventory(["one", "two"], ["qwen_3_06b_base.safetensors"], ["qwen_image_vae.safetensors"]))).toThrow("workflow_model_ambiguous");
    expect(() => workflowFromInventory(inventory(["one"], [], []))).toThrow("workflow_family_ambiguous");
  });
});
