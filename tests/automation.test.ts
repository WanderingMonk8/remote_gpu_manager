import { describe, expect, test } from "bun:test";
import { AutomationController, type AutomationSecrets } from "../src/automation";

const secrets: AutomationSecrets = { controlToken: "control", clientId: "id", clientSecret: "oauth-secret",
  refreshToken: "refresh", tailnetKey: "ts-secret", basicUser: "user", basicPass: "password" };

describe("automation controller", () => {
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
