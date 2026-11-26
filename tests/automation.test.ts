import { describe, expect, test } from "bun:test";
import { AutomationController, driveSelectionIssue, type AutomationSecrets } from "../src/automation";
import { requiredModelCacheVersion, requiredModelFiles, workbookSettings } from "../src/workbook-settings";

const secrets: AutomationSecrets = { controlToken: "control", clientId: "id", clientSecret: "oauth-secret",
  refreshToken: "refresh", tailnetKey: "ts-secret", basicUser: "user", basicPass: "password" };

describe("automation controller", () => {
  test("remembers only successful LoRA downloads from the startup request across reinstalls", async () => {
    const entries = new Map<string, string>();
    const store = { async get(key: string, user: string) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key: string, value: string, user: string) { entries.set(`${user}:${key}`, value); } };
    const good = "https://civitai.red/api/download/models/123?fileId=456";
    const failed = "https://example.com/failed.safetensors";
    entries.set("owner:automation-lora-pending-v1", JSON.stringify([good, failed]));
    const call = async (path: string, method: string) => method === "GET" && path.endsWith("bootstrap")
      ? { status: "finished", httpStatus: 200, result: { ok: true, workerHealthy: true, state: { "tailscaled.state": "state" }, loraInstalled: [
        { url: good, name: "actual-lora.safetensors" }, { url: "https://example.com/unrequested", name: "other.safetensors" },
      ] } } : {};
    const controller = new AutomationController(store, call);
    await controller.save("owner", secrets);
    await controller.poll("owner");
    const history = await new AutomationController(store, call).getLoraHistory("owner");
    expect(history.map(entry => [entry.name, entry.url])).toEqual([["actual-lora.safetensors", good]]);
    expect(history[0].id).toHaveLength(64);
    expect(await controller.getLoraHistory("other")).toEqual([]);
  });
  test("new model choices map to supported cache files and require gateway v3", () => {
    const models = ["MOSS SFT BF16", "MOSS Base BF16", "Anima Preview", "Anima Preview 2", "Anima Preview 3 Base", "Anima 2.9B Preview BF16", "Anima 2.9B Preview INT8"];
    const field = workbookSettings.find(field => field.key === "MODEL_CHOICE")!;
    for (const model of models) {
      expect((field.options as readonly string[])).toContain(model);
      expect(requiredModelCacheVersion(model)).toBe(3);
      const files = requiredModelFiles(model);
      expect(files).toHaveLength(3);
      expect(driveSelectionIssue(files.map((name, i) => ({ name, id: `id${i}` })))).toBeNull();
    }
    expect(requiredModelCacheVersion("MOSS SFT INT8")).toBe(1);
    expect(requiredModelCacheVersion("Anima Base v1.0")).toBe(2);
  });

  test("blocks newly added models on an older gateway before allocating", async () => {
    const entries = new Map<string, string>();
    const calls: string[] = [];
    const c = new AutomationController({ async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); } },
      async path => { calls.push(path); return { status: "idle", workbook_transfer: 1, bootstrap_allocation: 1, model_cache: 2 }; });
    await c.save("owner", secrets);
    await c.saveWorkbookSettings("owner", { MODEL_CHOICE: "Anima Preview 2" });
    await c.saveDriveFiles("owner", requiredModelFiles("Anima Preview 2").map((name, i) => ({ name, id: `file${i}` })));
    await expect(c.start("owner")).rejects.toThrow("gateway_model_cache_update_required");
    expect(calls).toEqual(["/gateway/v1/runtime/bootstrap"]);
  });

  test("persists advanced workbook settings per user and applies them before allocation", async () => {
    const entries = new Map<string, string>();
    const calls: Array<{ path: string; body: any }> = [];
    const store = { async get(key: string, user: string) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key: string, value: string, user: string) { entries.set(`${user}:${key}`, value); } };
    const call = async (path: string, _method: string, _token: string, body?: any) => {
      calls.push({ path, body });
      if (path.endsWith("/bootstrap") && body === undefined) return { status: "idle", workbook_transfer: 1, bootstrap_allocation: 1 };
      return {};
    };
    const c = new AutomationController(store, call);
    await c.save("owner", secrets);
    await c.saveDriveFiles("owner", [
      { id: "a", name: "moss_image_sft_int8_convrot.safetensors" },
      { id: "b", name: "qwen3.5_9b_w4a8_gptq.safetensors" },
      { id: "c", name: "flux2-vae_small.safetensors" },
    ]);
    await c.saveWorkbookSettings("owner", { VRAM_MODE: "lowvram", BEAT_SECONDS: 15, LORA_URLS: "" });
    const reinstalled = new AutomationController(store, call);
    expect((await reinstalled.getWorkbookSettings("owner")).VRAM_MODE).toBe("lowvram");
    expect((await reinstalled.getWorkbookSettings("other")).VRAM_MODE).toBe("normalvram");
    await expect(c.saveWorkbookSettings("owner", { BEAT_SECONDS: 0 })).rejects.toThrow("workbook_settings_invalid");
    await c.start("owner");
    const workbook = calls.find(c => c.path.endsWith("/workbook-check"))?.body.workbook;
    const cells = JSON.parse(workbook.content).cells.map((cell: any) => cell.source?.join("") ?? "");
    expect(cells[8]).toContain("BEAT_SECONDS = 15");
    expect(cells[10]).toContain('VRAM_MODE = "lowvram"');
    expect(cells[16]).toContain('LORA_URLS=""');
    expect(cells[16]).toContain("UPLOAD_LOCAL_LORA=False");
    expect(cells[22]).toContain("GENERATE=False");
    expect(workbook.sha256).toHaveLength(64);
  });

  test("uses optional cache files and downloads missing files for a different model", async () => {
    const entries = new Map<string, string>();
    const calls: string[] = [];
    const c = new AutomationController({ async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); } },
      async path => { calls.push(path); return { status: "idle", workbook_transfer: 1, bootstrap_allocation: 1, model_cache: 2 }; });
    await c.save("owner", secrets);
    await c.saveDriveFiles("owner", [
      { id: "a", name: "moss_image_sft_int8_convrot.safetensors" },
      { id: "b", name: "qwen3.5_9b_w4a8_gptq.safetensors" },
      { id: "c", name: "flux2-vae_small.safetensors" },
    ]);
    await c.saveWorkbookSettings("owner", { MODEL_CHOICE: "Anima Base v1.0" });
    expect((await c.driveStatus("owner")).missing).toEqual(["anima-base-v1.0.safetensors", "qwen_3_06b_base.safetensors", "qwen_image_vae.safetensors"]);
    await c.start("owner");
    expect(calls).toContain("/gateway/v1/runtime/bootstrap");
    expect(calls).not.toContain("/gateway/v1/runtime/cache-check");
    const oldGateway = new AutomationController({ async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); } },
      async path => { if (path.endsWith("/bootstrap")) return { status: "idle", workbook_transfer: 1, bootstrap_allocation: 1 }; throw new Error("unexpected_gateway_call"); });
    const result = await c.saveDriveFiles("owner", [
      { id: "d", name: "anima-base-v1.0.safetensors" },
      { id: "e", name: "qwen_3_06b_base.safetensors" },
      { id: "f", name: "qwen_image_vae.safetensors" },
    ]);
    expect(result.complete).toBe(true);
    await expect(oldGateway.start("owner")).rejects.toThrow("gateway_model_cache_update_required");
    await c.start("owner");
    expect(calls).toContain("/gateway/v1/runtime/bootstrap");
  });

  test("loads eligible GPUs without allocating and forwards an explicit GPU choice", async () => {
    const entries = new Map<string, string>();
    const calls: Array<{ path: string; body: any }> = [];
    const controller = new AutomationController({
      async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); },
    }, async (path, _method, _token, body) => {
      calls.push({ path, body });
      if (path.endsWith("/specs")) return { specs: [{ accelerator: "L4", shape: "SHAPE_STANDARD" }] };
      if (path.endsWith("/bootstrap") && body === undefined) return { status: "idle", workbook_transfer: 1, bootstrap_allocation: 1 };
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
    expect(calls.find(call => call.path.endsWith("/bootstrap") && call.body?.allocate)?.body.allocate)
      .toEqual({ accelerator: "L4", shape: "SHAPE_STANDARD", confirm_non_default: true });
  });

  test("persists workflow LoRA and weight across controller reinstalls per user", async () => {
    const entries = new Map<string, string>();
    const store = { async get(key: string, user: string) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key: string, value: string, user: string) { entries.set(`${user}:${key}`, value); } };
    const first = new AutomationController(store, async () => ({}));
    await first.saveWorkflowLora("owner", { name: "moss/custom.safetensors", weight: 0.65 });
    const reinstalled = new AutomationController(store, async () => ({}));
    expect(await reinstalled.getWorkflowLora("owner")).toEqual({ name: "moss/custom.safetensors", weight: 0.65 });
    expect(await reinstalled.getWorkflowLora("other")).toEqual({ name: "", weight: 1 });
    await expect(first.saveWorkflowLora("owner", { name: "bad", weight: Infinity })).rejects.toThrow("workflow_lora_invalid");
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

  test("saves the idle timeout per user and reapplies it before allocating", async () => {
    const entries = new Map<string, string>();
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const controller = new AutomationController({
      async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); },
    }, async (path, method, _token, body) => {
      calls.push({ path, method, body });
      if (path.endsWith("/bootstrap") && method === "GET") return { status: "idle", workbook_transfer: 1, bootstrap_allocation: 1 };
      return {};
    });
    await controller.save("owner", secrets);
    await controller.saveDriveFiles("owner", [
      { id: "a", name: "moss_image_sft_int8_convrot.safetensors" },
      { id: "b", name: "qwen3.5_9b_w4a8_gptq.safetensors" },
      { id: "c", name: "flux2-vae_small.safetensors" },
    ]);
    await controller.idle("owner", 15);
    expect(await controller.getIdlePreference("owner")).toBe(15);
    expect(await controller.getIdlePreference("other")).toBeNull();
    await expect(controller.idle("owner", 99)).rejects.toThrow("idle_minutes_invalid");
    calls.length = 0;
    await controller.start("owner");
    const idle = calls.findIndex(call => call.path.endsWith("/idle"));
    const allocation = calls.findIndex(call => call.path.endsWith("/bootstrap") && call.method === "POST");
    expect(calls[idle].body).toEqual({ minutes: 15 });
    expect(idle).toBeLessThan(allocation);
  });

  test("refuses to allocate when the gateway cannot receive the final workbook", async () => {
    const entries = new Map<string, string>();
    const calls: Array<{ path: string; method: string }> = [];
    const controller = new AutomationController({
      async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); },
    }, async (path, method) => { calls.push({ path, method }); return { status: "idle" }; });
    await controller.save("owner", secrets);
    await controller.saveDriveFiles("owner", [
      { id: "a", name: "moss_image_sft_int8_convrot.safetensors" },
      { id: "b", name: "qwen3.5_9b_w4a8_gptq.safetensors" },
      { id: "c", name: "flux2-vae_small.safetensors" },
    ]);
    await expect(controller.start("owner")).rejects.toThrow("gateway_workbook_update_required");
    expect(calls.some(call => call.method === "POST" && call.path.endsWith("/bootstrap"))).toBe(false);
    const older = new AutomationController({ async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); } },
      async () => ({ status: "idle", workbook_transfer: 1, model_cache: 4 }));
    await expect(older.start("owner")).rejects.toThrow("gateway_workbook_update_required");
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

  test("saves partial Picker selections across visits", async () => {
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
    expect(first.missing).toHaveLength(2);
    await controller.saveDriveFiles("owner", [{ id: "b", name: "qwen3.5_9b_w4a8_gptq.safetensors" }]);
    const last = await controller.saveDriveFiles("owner", [{ id: "c", name: "flux2-vae_small.safetensors" }]);
    expect(last.complete).toBe(true);
    expect(last.missing).toEqual([]);
    expect(JSON.parse(entries.get("owner:automation-drive-cache-v1")!)).toHaveLength(3);
    expect(await controller.driveStatus("owner")).toEqual({ saved: true, missing: [], savedNames: ["moss_image_sft_int8_convrot.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"] });
    expect((await controller.driveStatus("other")).saved).toBe(false);
  });

  test("identifies missing fields and preserves saved credentials on partial updates", async () => {
    const entries = new Map<string, string>();
    const controller = new AutomationController({
      async get(key, user) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key, value, user) { entries.set(`${user}:${key}`, value); },
    }, async () => ({}));
    await controller.save("owner", { ...secrets, tailnetKey: "" });
    expect(await controller.credentialsStatus("owner")).toEqual({ saved: false });
    await expect(controller.status("owner")).rejects.toThrow("missing_tailnet_key");
    await expect(controller.save("owner", { ...secrets, basicUser: "invalid:user" })).rejects.toThrow("invalid_basic_user");
    await controller.save("owner", secrets);
    expect(await controller.credentialsStatus("owner")).toEqual({ saved: true });
    expect(await controller.credentialsStatus("other")).toEqual({ saved: false });
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
      if (path.endsWith("bootstrap")) return { status: "idle", workbook_transfer: 1, bootstrap_allocation: 1 };
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

  test("preserves a startup failure before acknowledging it and across reinstalls", async () => {
    const entries = new Map<string, string>(); const events: string[] = [];
    const store = { async get(key: string, user: string) { return entries.get(`${user}:${key}`) ?? null; },
      async put(key: string, value: string, user: string) { events.push(`save:${key}`); entries.set(`${user}:${key}`, value); } };
    const call = async (path: string, method: string) => {
      events.push(`${method}:${path}`);
      return method === "GET" ? { status: "finished", httpStatus: 504, result: { error: "timeout" } } : { ok: true };
    };
    const controller = new AutomationController(store, call);
    await controller.save("owner", secrets);
    expect(await controller.poll("owner")).toEqual({ status: "failed", error: "timeout" });
    expect(events.indexOf("save:automation-last-startup-v1")).toBeLessThan(events.indexOf("DELETE:/gateway/v1/runtime/bootstrap"));
    const again = new AutomationController(store, call);
    expect((await again.lastStartup("owner"))?.error).toBe("timeout");
    expect(await again.lastStartup("other")).toBeNull();
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
