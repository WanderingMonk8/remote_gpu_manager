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
  test("inserts the selected installed LoRA and weight into the starter graph", () => {
    const data: Record<string, any> = inventory(["moss_image_sft_int8_convrot.safetensors"], ["qwen3.5_9b_w4a8_gptq.safetensors"], ["flux2-vae_small.safetensors"]);
    data.LoraLoaderModelOnly = { input: { required: { lora_name: [["moss/example.safetensors"]] } } };
    const graph = workflowFromInventory(data, { name: "moss/example.safetensors", weight: 0.65 });
    expect(graph["100"]).toEqual({ class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "moss/example.safetensors", strength_model: 0.65 } });
    expect(graph["7"].inputs.model).toEqual(["100", 0]);
    expect(() => workflowFromInventory(data, { name: "moss/missing.safetensors", weight: 1 })).toThrow("workflow_lora_missing");
    expect(() => workflowFromInventory(data, { name: "moss/example.safetensors", weight: 6 })).toThrow("workflow_lora_invalid");
    data.LoraLoaderModelOnly.input.required.lora_name[0].push("anima/wrong.safetensors");
    expect(() => workflowFromInventory(data, { name: "anima/wrong.safetensors", weight: 1 })).toThrow("workflow_lora_family_mismatch");
  });
  test("refuses ambiguous checkpoints or families", () => {
    expect(() => workflowFromInventory(inventory(["one", "two"], ["qwen_3_06b_base.safetensors"], ["qwen_image_vae.safetensors"]))).toThrow("workflow_model_ambiguous");
    expect(() => workflowFromInventory(inventory(["one"], [], []))).toThrow("workflow_family_ambiguous");
  });
  test("adds the MOSS shift node after the selected LoRA, leaving defaults untouched", () => {
    const data: Record<string, any> = inventory(["moss.safetensors"], ["qwen3.5_9b_w4a8_gptq.safetensors"], ["flux2-vae_small.safetensors"]);
    data.LoraLoaderModelOnly = { input: { required: { lora_name: [["moss/example.safetensors"]] } } };
    data.ModelSamplingAuraFlow = { input: { required: {} } };
    const lora = { name: "moss/example.safetensors", weight: 1 };
    const graph = workflowFromInventory(data, lora, 5);
    expect(graph["101"]).toEqual({ class_type: "ModelSamplingAuraFlow", inputs: { model: ["100", 0], shift: 5 } });
    expect(graph["7"].inputs.model).toEqual(["101", 0]);
    expect(workflowFromInventory(data, lora)["101"]).toBeUndefined();
    expect(() => workflowFromInventory(data, lora, -1)).toThrow("workflow_shift_invalid");
    const anima = inventory(["anima"], ["qwen_3_06b_base.safetensors"], ["qwen_image_vae.safetensors"]);
    expect(() => workflowFromInventory(anima, undefined, 5)).toThrow("workflow_shift_moss_only");
  });
});
