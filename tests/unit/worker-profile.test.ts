import { describe, test, expect } from "bun:test";
import { validateWorkerProfile, defaultWorkerProfile } from "../../src/schemas/worker-profile";

describe("validateWorkerProfile", () => {
  test("accepts the default profile", () => {
    const p = validateWorkerProfile(defaultWorkerProfile());
    expect(p.bootstrap.modelProfileId).toBe("moss-sft-int8");
    expect(p.lifecycle.idleMinutes).toBe(10);
  });

  test("rejects unknown fields", () => {
    const bad = { ...defaultWorkerProfile(), hacker: true } as any;
    expect(() => validateWorkerProfile(bad)).toThrow(/Unknown field/);
  });

  test("rejects bad dimensions", () => {
    const bad = { ...defaultWorkerProfile(), generationDefaults: { ...defaultWorkerProfile().generationDefaults, width: 512, height: 513 } };
    expect(() => validateWorkerProfile(bad)).toThrow(/multiples of 16/);
  });

  test("rejects invalid sampler", () => {
    const bad = { ...defaultWorkerProfile(), generationDefaults: { ...defaultWorkerProfile().generationDefaults, sampler: "huge-step" } };
    expect(() => validateWorkerProfile(bad)).toThrow(/sampler/);
  });

  test("rejects bad idleMinutes", () => {
    const bad = { ...defaultWorkerProfile(), lifecycle: { ...defaultWorkerProfile().lifecycle, idleMinutes: 7 } };
    expect(() => validateWorkerProfile(bad)).toThrow(/idleMinutes/);
  });

  test("rejects wrong loraLoader", () => {
    const bad = { ...defaultWorkerProfile(), generationDefaults: { ...defaultWorkerProfile().generationDefaults, loraLoader: "LoraLoader" } };
    expect(() => validateWorkerProfile(bad)).toThrow(/loraLoader/);
  });

  test("rejects schemaVersion != 1", () => {
    const bad = { ...defaultWorkerProfile(), schemaVersion: 2 };
    expect(() => validateWorkerProfile(bad as any)).toThrow(/schemaVersion/);
  });
});
