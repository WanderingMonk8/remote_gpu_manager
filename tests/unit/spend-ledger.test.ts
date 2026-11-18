import { describe, test, expect } from "bun:test";
import { SpendLedger, computeHourlyCost, storageCostPerHour } from "../../src/controller/spend-ledger";

const store = () => {
  const file: string[] = [];
  const disk: Record<string, string> = {};
  const io = {
    readFileSync: (_p: string) => disk["x"] ?? "",
    appendFileSync: (_p: string, d: string) => {
      disk["x"] = (disk["x"] ?? "") + d;
    },
  };
  return { file, disk, io };
};

describe("SpendLedger", () => {
  test("allocation -> stop computes compute cost", () => {
    const { io } = store();
    const ledger = new SpendLedger("x", io);
    ledger.append({ at: 0, instanceId: 1, type: "allocation", hourlyRateUsd: 0.20, storageGB: 100, storageUsdPerGBMonth: 0.05 });
    ledger.append({ at: 3_600_000, instanceId: 1, type: "stop", hourlyRateUsd: 0.2, storageGB: 100, storageUsdPerGBMonth: 0.05 });
    const s = ledger.summarize(3_600_000, null, null);
    expect(s.accruedUsd).toBeCloseTo(0.2 + (0.05 * 100) / 730, 2);
  });

  test("active instance accrues through now", () => {
    const { io } = store();
    const ledger = new SpendLedger("x", io);
    ledger.append({ at: 0, instanceId: 1, type: "allocation", hourlyRateUsd: 0.1, storageGB: 100, storageUsdPerGBMonth: 0 });
    const s = ledger.summarize(7_200_000, null, 1);
    expect(s.accruedUsd).toBeCloseTo(0.2, 2);
  });

  test("capExceeded flag when accrued > cap", () => {
    const { io } = store();
    const ledger = new SpendLedger("x", io);
    ledger.append({ at: 0, instanceId: 1, type: "allocation", hourlyRateUsd: 1, storageGB: 100, storageUsdPerGBMonth: 0 });
    const s = ledger.summarize(60 * 60 * 1000, 0.5, 1);
    expect(s.capExceeded).toBe(true);
  });

  test("torn last line ignored", () => {
    const disk: Record<string, string> = {};
    disk["x"] = '{"at":0,"instanceId":1,"type":"allocation","hourlyRateUsd":1,"storageGB":1,"storageUsdPerGBMonth":0}\n{"partial":';
    const ledger = new SpendLedger("x", {
      readFileSync: () => disk["x"]!,
      appendFileSync: () => {},
    });
    expect(ledger.readAll()).toHaveLength(1);
  });
});

describe("cost math", () => {
  test("computeHourlyCost", () => {
    expect(computeHourlyCost(0.5, 3_600_000 * 2)).toBeCloseTo(1.0);
  });
  test("computeHourlyCost zero", () => {
    expect(computeHourlyCost(0.5, 0)).toBe(0);
  });
  test("storageCostPerHour", () => {
    expect(storageCostPerHour(100, 0.05)).toBeCloseTo(5 / 730, 6);
  });
});
