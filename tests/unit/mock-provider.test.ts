import { describe, test, expect } from "bun:test";
import { MockVastProvider } from "../../src/providers/mock/mock-provider";
import { StateMachine } from "../../src/controller/state-machine";

describe("MockVastProvider", () => {
  test("searchOffers applies policy filters", async () => {
    const p = new MockVastProvider();
    const all = await p.searchOffers();
    expect(all.length).toBeGreaterThan(0);
    for (const o of all) {
      expect(o.reliability).toBeGreaterThanOrEqual(0.99);
      expect(o.dph_total).toBeLessThanOrEqual(0.2);
    }
    const only3090 = await p.searchOffers({ gpuNames: ["RTX_3090"] });
    expect(only3090.every((o) => o.gpu_name === "RTX_3090")).toBe(true);
  });

  test("create -> inspect -> stop -> start -> destroy lifecycle", async () => {
    const p = new MockVastProvider(true); // start as stopped (like a created-stopped instance)
    const { instanceId } = await p.create({ offerId: 1, image: "img", diskGB: 100, label: "t" }, "intent-1");
    expect(p.calls.created).toBe(1);
    let info = await p.inspect(instanceId);
    expect(info?.actual_status).toBe("stopped");
    await p.start(instanceId);
    info = await p.inspect(instanceId);
    expect(info?.actual_status).toBe("running");
    await p.stop(instanceId);
    expect(p.calls.stopped).toBe(1);
    await p.destroy(instanceId);
    expect(p.calls.destroyed).toBe(1);
    expect(await p.inspect(instanceId)).toBeNull();
  });

  test("state machine + mock pair drive a mock-only lifecycle", async () => {
    const p = new MockVastProvider(true);
    const sm = new StateMachine("offline", 1);
    const { instanceId } = await p.create({ offerId: 1, image: "img", diskGB: 100 }, "intent");
    sm.assert("provisioning");
    const info = await p.inspect(instanceId);
    expect(info).not.toBeNull();
    sm.assert("bootstrapping");
    sm.assert("connecting");
    sm.assert("ready");
    sm.assert("busy");
    sm.assert("idle");
    sm.assert("stopping");
    await p.stop(instanceId);
    sm.assert("stopped");
    expect(sm.state).toBe("stopped");
    sm.assert("destroying");
    await p.destroy(instanceId);
    sm.assert("offline");
  });
});
