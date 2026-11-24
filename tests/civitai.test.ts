import { describe, expect, test } from "bun:test";
import { parseCivitaiUrl, parseCivitaiVersion, validateCivitaiSelection } from "../src/civitai";
import { AutomationController } from "../src/automation";

const raw = { id: 45, modelId: 12, name: "v1", baseModel: "Anima", model: { name: "Example", type: "Checkpoint" }, files: [
  { id: 67, name: "model.safetensors", type: "Model", sizeKB: 1234, hashes: { SHA256: "a".repeat(64) } },
  { id: 68, name: "evil.ckpt", type: "Model", sizeKB: 1234 },
] };
describe("Civitai checkpoint selection", () => {
  test("only accepts Civitai links and extracts model and version IDs", () => {
    expect(parseCivitaiUrl("https://civitai.com/models/12/name?modelVersionId=45")).toEqual({ modelId: 12, versionId: 45 });
    expect(parseCivitaiUrl("https://civitai.red/api/download/models/45?fileId=67")).toEqual({ versionId: 45 });
    expect(() => parseCivitaiUrl("https://civitai.com.attacker.invalid/models/12")).toThrow("civitai_url_invalid");
    expect(() => parseCivitaiUrl("http://civitai.com/models/12")).toThrow("civitai_url_invalid");
  });
  test("filters unsafe files and requires supported model family", () => {
    const version = parseCivitaiVersion(raw);
    expect(version.files).toHaveLength(1);
    expect(validateCivitaiSelection({ version, fileId: 67 }).version.family).toBe("anima");
    expect(() => validateCivitaiSelection({ version, fileId: 68 })).toThrow("civitai_selection_invalid");
    expect(() => parseCivitaiVersion({ ...raw, baseModel: "SDXL 1.0" })).toThrow("civitai_model_unsupported");
  });
  test("accepts Civitai diffusion model files and preserves selection", () => {
    const version = parseCivitaiVersion({ ...raw, baseModel: "MOSS Image", files: [
      { id: 3308921, name: "moss_image_turbo_00004_bf16.safetensors", type: "Diffusion Model", sizeKB: 9926429.6796875 },
      { id: 2, name: "encoder.safetensors", type: "Text Encoder", sizeKB: 100 },
    ] });
    expect(version.files.map(file => file.id)).toEqual([3308921]);
    expect(validateCivitaiSelection({ version, fileId: 3308921 }).version.family).toBe("moss");
  });
  test("custom choice sends private metadata only after preflight and never puts token in workbook", async () => {
    const map = new Map<string, string>();
    const calls: any[] = [];
    const store = { async get(k: string, u: string) { return map.get(`${u}:${k}`) ?? null; }, async put(k: string, v: string, u: string) { map.set(`${u}:${k}`, v); } };
    const controller = new AutomationController(store, async (path, method, _token, body) => {
      calls.push({ path, method, body });
      if (path.endsWith("/bootstrap") && method === "GET") return { status: "idle", workbook_transfer: 1, bootstrap_allocation: 1, model_cache: 4 };
      return {};
    });
    await controller.save("alice", { controlToken: "control", clientId: "id", clientSecret: "secret", refreshToken: "refresh", tailnetKey: "tailnet", basicUser: "user", basicPass: "pass" });
    await controller.saveCivitaiToken("alice", "private-token");
    await controller.saveCivitaiSelection("alice", { version: parseCivitaiVersion(raw), fileId: 67 });
    await controller.saveWorkbookSettings("alice", { MODEL_CHOICE: "Custom Civitai" });
    await controller.saveDriveFiles("alice", [{ id: "a", name: "qwen_3_06b_base.safetensors" }, { id: "b", name: "qwen_image_vae.safetensors" }]);
    await expect(controller.saveCivitaiCache("alice", [{ id: "cache", name: "wrong.safetensors" }])).rejects.toThrow("civitai_cache_invalid");
    await controller.saveCivitaiCache("alice", [{ id: "cache", name: "model.safetensors" }]);
    const oldCalls: string[] = [];
    const oldGateway = new AutomationController(store, async path => { oldCalls.push(path); return { status: "idle", workbook_transfer: 1, bootstrap_allocation: 1, model_cache: 3 }; });
    await expect(oldGateway.start("alice")).rejects.toThrow("gateway_model_cache_update_required");
    expect(oldCalls).toEqual(["/gateway/v1/runtime/bootstrap"]);
    expect((await controller.getCivitaiCache("alice"))?.id).toBe("cache");
    await controller.start("alice");
    const request = calls.find(c => c.path.endsWith("/bootstrap") && c.method === "POST").body;
    expect(request.civitai.token).toBe("private-token");
    expect(request.civitai.fileId).toBe(67);
    expect(request.workbook.content).not.toContain("private-token");
    expect(request.workbook.content).toContain("Custom Civitai");
    expect(request.drive_files).toHaveLength(3);
    expect(request.drive_files[2].name).toBe("model.safetensors");
  });

  test("supports non-ASCII names without persisting raw Unicode in the enclave", async () => {
    const map = new Map<string, string>();
    const store = { async get(k: string, u: string) { return map.get(`${u}:${k}`) ?? null; }, async put(k: string, v: string, u: string) { map.set(`${u}:${k}`, v); } };
    const c = new AutomationController(store, async () => ({}));
    const version = parseCivitaiVersion({ ...raw, model: { name: "???", type: "Checkpoint" }, files: [{ ...raw.files[0], name: "? ???.safetensors" }] });
    await c.saveCivitaiSelection("owner", { version, fileId: 67 });
    await c.saveCivitaiCache("owner", [{ id: "drive-file", name: "? ???.safetensors" }]);
    expect((await c.getCivitaiCache("owner"))?.name).toBe("? ???.safetensors");
    expect([...map.values()].every(value => /^[\x00-\x7f]*$/.test(value))).toBe(true);
  });

  test("model, token, checkpoint and Drive cache survive reinstall and switching models", async () => {
    const map = new Map<string, string>();
    const store = { async get(k: string, u: string) { return map.get(`${u}:${k}`) ?? null; }, async put(k: string, v: string, u: string) { map.set(`${u}:${k}`, v); }, async delete(k: string, u: string) { map.delete(`${u}:${k}`); } };
    const before = new AutomationController(store, async () => ({}));
    await before.saveCivitaiToken("owner", "secret");
    await before.saveCivitaiSelection("owner", { version: parseCivitaiVersion(raw), fileId: 67 });
    await before.saveCivitaiCache("owner", [{ id: "drive-id", name: "model.safetensors" }]);
    await before.saveWorkbookSettings("owner", { MODEL_CHOICE: "Custom Civitai", VRAM_MODE: "lowvram" });
    const reinstalled = new AutomationController(store, async () => ({}));
    expect((await reinstalled.getWorkbookSettings("owner")).MODEL_CHOICE).toBe("Custom Civitai");
    expect((await reinstalled.getWorkbookSettings("owner")).VRAM_MODE).toBe("lowvram");
    expect((await reinstalled.getCivitaiSelection("owner"))?.fileId).toBe(67);
    expect((await reinstalled.getCivitaiCache("owner"))?.id).toBe("drive-id");
    expect(await reinstalled.civitaiTokenStatus("owner")).toEqual({ saved: true });
    await reinstalled.saveWorkbookSettings("owner", { MODEL_CHOICE: "MOSS SFT INT8" });
    await reinstalled.saveWorkbookSettings("owner", { MODEL_CHOICE: "Custom Civitai" });
    const afterSwitch = new AutomationController(store, async () => ({}));
    expect((await afterSwitch.getCivitaiSelection("owner"))?.fileId).toBe(67);
    expect((await afterSwitch.getCivitaiCache("owner"))?.id).toBe("drive-id");
    expect(await afterSwitch.civitaiTokenStatus("owner")).toEqual({ saved: true });
  });

  test("token and custom selection survive controller reinstalls and remain per user", async () => {
    const map = new Map<string, string>();
    const store = { async get(k: string, u: string) { return map.get(`${u}:${k}`) ?? null; },
      async put(k: string, v: string, u: string) { map.set(`${u}:${k}`, v); },
      async delete(k: string, u: string) { map.delete(`${u}:${k}`); } };
    const c = new AutomationController(store, async () => ({}));
    await c.saveCivitaiToken("alice", "private-token");
    await c.saveCivitaiToken("alice", "");
    await c.saveCivitaiSelection("alice", { version: parseCivitaiVersion(raw), fileId: 67 });
    const again = new AutomationController(store, async () => ({}));
    expect(await again.civitaiTokenStatus("alice")).toEqual({ saved: true });
    expect(await again.civitaiTokenStatus("bob")).toEqual({ saved: false });
    expect((await again.getCivitaiSelection("alice"))?.fileId).toBe(67);
    expect(await again.getCivitaiSelection("bob")).toBeNull();
    await again.removeCivitaiToken("alice");
    expect(await again.civitaiTokenStatus("alice")).toEqual({ saved: false });
    expect((await again.getCivitaiSelection("alice"))?.fileId).toBe(67);
  });
});
