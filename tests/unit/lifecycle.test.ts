import { describe, test, expect } from "bun:test";
import { StateMachine, IllegalTransitionError } from "../../src/controller/state-machine";
import { LeaseTracker } from "../../src/controller/leases";
import { AdmissionManager } from "../../src/controller/admission";

describe("StateMachine", () => {
  test("offline -> provisioning -> bootstrapping -> connecting -> ready -> busy -> idle -> stopping -> stopped", () => {
    const sm = new StateMachine("offline", 1);
    expect(sm.state).toBe("offline");
    sm.assert("provisioning");
    sm.assert("bootstrapping");
    sm.assert("connecting");
    sm.assert("ready");
    sm.assert("busy");
    sm.assert("idle");
    sm.assert("stopping");
    sm.assert("stopped");
    expect(sm.state).toBe("stopped");
  });

  test("idle + admitted work -> busy is legal", () => {
    const sm = new StateMachine("idle", 7);
    sm.assert("busy");
    expect(sm.state).toBe("busy");
  });

  test("illegal transition throws IllegalTransitionError", () => {
    const sm = new StateMachine("offline", 1);
    expect(() => sm.assert("ready")).toThrow(IllegalTransitionError);
  });

  test("stopped -> destroying -> offline", () => {
    const sm = new StateMachine("stopped", 3);
    sm.assert("destroying");
    sm.assert("offline");
    expect(sm.state).toBe("offline");
  });
});

describe("LeaseTracker", () => {
  test("admit -> bind -> isActive -> release", () => {
    let t = 1_000;
    const lt = new LeaseTracker(() => t);
    const lease = lt.admit("job-1", "req-1", 60_000);
    expect(lease.phase).toBe("queued");
    expect(lt.isActive()).toBe(true);
    lt.transition("job-1", "running");
    lt.bindPromptId("job-1", "prompt-x");
    expect(lt.asList()[0].phase).toBe("running");
    lt.forceRelease("job-1");
    expect(lt.isActive()).toBe(false);
  });
});

describe("AdmissionManager", () => {
  test("single-flight: first acquire wins, second waits for release", async () => {
    let t = 1_000;
    const am = new AdmissionManager({ now: () => t });
    expect(am.tryAcquire({ requestId: "r1", provider: "vast", profileId: "p1" })).toBe(true);
    expect(am.tryAcquire({ requestId: "r2", provider: "vast", profileId: "p1" })).toBe(false);
    const waitP = am.waitFor("r2", 1000);
    am.release();
    expect(await waitP).toBe(true);
  });

  test("expired intent is reclaimable", () => {
    let t = 1_000;
    const am = new AdmissionManager({ now: () => t, defaultTtlMs: 100 });
    am.tryAcquire({ requestId: "r1", provider: "vast", profileId: "p1" });
    t += 200; // past TTL
    expect(am.tryAcquire({ requestId: "r2", provider: "vast", profileId: "p1" })).toBe(true);
  });
});
