import { describe, expect, test } from "bun:test";
import { AutomationController, type AutomationSecrets } from "../src/automation";

const secrets: AutomationSecrets = { controlToken: "control", clientId: "id", clientSecret: "oauth-secret",
  refreshToken: "refresh", tailnetKey: "ts-secret", basicUser: "user", basicPass: "password" };

describe("automation controller", () => {
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
});
