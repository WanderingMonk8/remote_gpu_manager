import { describe, expect, test } from "bun:test";
import { AutomationController, driveSelectionIssue, type AutomationSecrets } from "../src/automation";

const secrets: AutomationSecrets = { controlToken: "control", clientId: "id", clientSecret: "oauth-secret",
  refreshToken: "refresh", tailnetKey: "ts-secret", basicUser: "user", basicPass: "password" };

describe("automation controller", () => {
  test("loads eligible GPUs without allocating and forwards an explicit GPU choice", async () => {
    const entries = new Map<string, string>();
    const calls: Array<{ path: string; body: any }> = [];
    const controller = new AutomationController({
      async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); },
    }, async (path, _method, _token, body) => {
      calls.push({ path, body });
      if (path.endsWith("/specs")) return { specs: [{ accelerator: "L4", shape: "SHAPE_STANDARD" }] };
      if (path.endsWith("/bootstrap") && body === undefined) return { status: "idle" };
      return {};
    });
    await controller.save("owner", secrets);
    await controller.saveDriveFiles("owner", [
      { id: "a", name: "moss_image_sft_int8_convrot.safetensors" },
      { id: "b", name: "qwen3.5_9b_w4a8_gptq.safetensors" },
      { id: "c", name: "flux2-vae_small.safetensors" },
    ]);
    expect((await controller.gpuSpecs("owner")).specs[0].accelerator).toBe("L4");
    expect(calls.some(call => call.path === "/gateway/v1/runtime")).toBe(false);
    await controller.start("owner", { accelerator: "L4", shape: "SHAPE_STANDARD", confirmNonDefault: true });
    expect(calls.find(call => call.path === "/gateway/v1/runtime")?.body)
      .toEqual({ accelerator: "L4", shape: "SHAPE_STANDARD", confirm_non_default: true });
  });

  test("saves and changes the GPU preference per user without allocating or saving confirmation", async () => {
    const entries = new Map<string, string>();
    const calls: string[] = [];
    const controller = new AutomationController({
      async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); },
    }, async path => { calls.push(path); return {}; });
    await controller.saveGpuPreference("owner", { accelerator: "L4", shape: "SHAPE_STANDARD", confirmNonDefault: true } as any);
    expect(await controller.getGpuPreference("owner")).toEqual({ accelerator: "L4", shape: "SHAPE_STANDARD" });
    expect(await controller.getGpuPreference("other")).toBeNull();
    await expect(controller.saveGpuPreference("owner", { accelerator: "invalid gpu", shape: "SHAPE_STANDARD" })).rejects.toThrow("gpu_preference_invalid");
    expect((await controller.getGpuPreference("owner"))?.accelerator).toBe("L4");
    await controller.saveGpuPreference("owner", { accelerator: "T4", shape: "SHAPE_STANDARD" });
    expect((await controller.getGpuPreference("owner"))?.accelerator).toBe("T4");
    expect(calls).toEqual([]);
  });

  test("distinguishes Picker selection problems without exposing file IDs", () => {
    expect(driveSelectionIssue([])).toBe("drive_selection_empty");
    expect(driveSelectionIssue([{ id: "valid-id", name: "wrong-file.safetensors" }])).toBe("drive_selection_unrecognized");
    expect(driveSelectionIssue([{ id: "bad id", name: "flux2-vae_small.safetensors" }])).toBe("drive_selection_metadata_missing");
    expect(driveSelectionIssue([{ id: "one", name: "flux2-vae_small.safetensors" }, { id: "two", name: "flux2-vae_small.safetensors" }])).toBe("drive_selection_duplicate");
    expect(driveSelectionIssue([{ id: "one", name: "flux2-vae_small.safetensors" }])).toBeNull();
  });
  test("saves and restores Picker settings separately for each user", async () => {
    const entries = new Map<string, string>();
    const controller = new AutomationController({
      async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); },
    }, async () => ({}));
    const config = { clientId: "web-client", apiKey: "browser-key", projectNumber: "123456" };
    await controller.savePickerConfig("owner", config);
    expect(await controller.getPickerConfig("owner")).toEqual(config);
    expect(await controller.getPickerConfig("other-user")).toBeNull();
    await expect(controller.savePickerConfig("owner", { ...config, projectNumber: "not-a-number" })).rejects.toThrow("picker_config_invalid");
    expect(await controller.getPickerConfig("owner")).toEqual(config);
  });

  test("saves Picker selections across visits and refuses an incomplete cache", async () => {
    const entries = new Map<string, string>();
    const calls: string[] = [];
    const controller = new AutomationController({
      async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); },
    }, async (path) => { calls.push(path); return {}; });
    await controller.save("owner", secrets);
    const first = await controller.saveDriveFiles("owner", [{ id: "a", name: "moss_image_sft_int8_convrot.safetensors" }]);
    expect(first.complete).toBe(false);
    expect(first.missing).toEqual(["qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"]);
    await expect(controller.start("owner")).rejects.toThrow("drive_selection_incomplete");
    expect(calls).toEqual([]);
    await controller.saveDriveFiles("owner", [{ id: "b", name: "qwen3.5_9b_w4a8_gptq.safetensors" }]);
    const last = await controller.saveDriveFiles("owner", [{ id: "c", name: "flux2-vae_small.safetensors" }]);
    expect(last.complete).toBe(true);
    expect(last.missing).toEqual([]);
    expect(JSON.parse(entries.get("owner:automation-drive-cache-v1")!)).toHaveLength(3);
  });

  test("identifies missing fields and preserves saved credentials on partial updates", async () => {
    const entries = new Map<string, string>();
    const controller = new AutomationController({
      async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); },
    }, async () => ({}));
    await expect(controller.save("owner", { ...secrets, tailnetKey: "" })).rejects.toThrow("missing_tailnet_key");
    await expect(controller.save("owner", { ...secrets, basicUser: "invalid:user" })).rejects.toThrow("invalid_basic_user");
    await controller.save("owner", secrets);
    await controller.save("owner", { ...secrets, clientSecret: "", basicPass: "new-password" });
    const saved = JSON.parse(entries.get("owner:automation-credentials-v1")!);
    expect(saved.clientSecret).toBe("oauth-secret");
    expect(saved.basicPass).toBe("new-password");
  });

  test("does not allocate if Drive preflight fails", async () => {
    const entries = new Map<string, string>();
    const calls: string[] = [];
    const controller = new AutomationController({
      async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); },
    }, async (path, method) => {
      calls.push(`${method}:${path}`);
      if (path.endsWith("bootstrap")) return { status: "idle" };
      if (path.endsWith("cache-check")) throw new Error("drive_access_required");
      return {};
    });
    await controller.save("owner", secrets);
    await controller.saveDriveFiles("owner", [
      { id: "a", name: "moss_image_sft_int8_convrot.safetensors" },
      { id: "b", name: "qwen3.5_9b_w4a8_gptq.safetensors" },
      { id: "c", name: "flux2-vae_small.safetensors" },
    ]);
    await expect(controller.start("owner")).rejects.toThrow("drive_access_required");
    expect(calls).not.toContain("POST:/gateway/v1/runtime");
  });

  test("stores identity before acknowledging a completed bootstrap", async () => {
    const entries = new Map<string, string>();
    const events: string[] = [];
    const controller = new AutomationController({
      async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { events.push(`save:${key}`); entries.set(`${user}:${key}`, value); },
    }, async (path, method) => {
      events.push(`${method}:${path}`);
      if (method === "GET" && path.endsWith("bootstrap")) return { status: "finished", httpStatus: 200,
        result: { ok: true, workerHealthy: true, state: { "tailscaled.state": "secret-state" } } };
      return { ok: true };
    });
    await controller.save("owner", secrets);
    const result = await controller.poll("owner");
    expect(result).toEqual({ status: "finished", workerHealthy: true });
    expect(events.indexOf("save:automation-tailnet-state-v1")).toBeLessThan(events.indexOf("DELETE:/gateway/v1/runtime/bootstrap"));
    await expect(controller.poll("other-user")).rejects.toThrow("credentials_required");
  });

  test("does not acknowledge identity if secure storage fails", async () => {
    const calls: string[] = [];
    const controller = new AutomationController({
      async get() { return JSON.stringify(secrets); },
      async put() { throw new Error("storage unavailable"); },
    }, async (_path, method) => {
      calls.push(method);
      return { status: "finished", httpStatus: 200, result: { ok: true, state: { "tailscaled.state": "secret" } } };
    });
    await expect(controller.poll("owner")).rejects.toThrow();
    expect(calls).toEqual(["GET"]);
  });

  test("saves node identity even when endpoint adoption failed", async () => {
    const entries = new Map<string, string>();
    const controller = new AutomationController({
      async get(key) { return key === "automation-credentials-v1" ? JSON.stringify(secrets) : entries.get(key) ?? null; },
      async put(key, value) { entries.set(key, value); },
    }, async (_path, method) => method === "GET"
      ? { status: "finished", httpStatus: 200, result: { ok: true, workerHealthy: false,
        error: "bootstrap_endpoint_invalid", state: { "tailscaled.state": "secret" } } }
      : { ok: true });
    expect(await controller.poll("owner")).toEqual({ status: "finished", workerHealthy: false, error: "bootstrap_endpoint_invalid" });
    expect(entries.has("automation-tailnet-state-v1")).toBe(true);
  });
});
