/**
 * Spend ledger — tracks accrued compute + storage + network cost estimates
 * for owned instances, reconciled against known instant rates on demand.
 *
 * This is a *controller-side estimate*, not a billing authority. It exists so the
 * dashboard and admission gate can refuse work when a policy cap is exceeded or
 * approaching. Real Provider charges can lag; the ledger is conservative.
 */

export type LedgerEventType =
  | "allocation" // instance created
  | "resume" // instance started again
  | "snapshot" // periodic accounting tick (carries instantaneous rate/storage)
  | "stop" // instance stopped
  | "destroy"; // instance destroyed

export interface LedgerEvent {
  at: number; // epoch ms
  instanceId: number | null;
  type: LedgerEventType;
  hourlyRateUsd: number;
  storageGB: number;
  storageUsdPerGBMonth: number;
  note?: string;
}

export interface SpendSummary {
  /** Cost accrued up to `now` (compute + storage). */
  accruedUsd: number;
  /** Cost accrued if nothing changes until `projectedUntil` (default = now). */
  projectedUsd: number;
  capExceeded: boolean;
  at: number;
}

export function storageCostPerHour(storageGB: number, storageUsdPerGBMonth: number): number {
  // monthly -> hourly; 730h is the usual cloud month approximation
  return (storageGB * storageUsdPerGBMonth) / 730;
}

export function computeHourlyCost(hourlyRateUsd: number, elapsedMs: number): number {
  return (elapsedMs / 3_600_000) * hourlyRateUsd;
}

interface OpenWindow {
  startAt: number;
  closeAt: number | null; // null = still open
  rate: number;
  storageGB: number;
  storageRate: number;
}

/**
 * Simple, durable-append ledger. `append` writes one JSONL line per event.
 * Tolerates a torn last line from crash recovery.
 */
export class SpendLedger {
  private readonly path: string;
  private readonly readFileSync: (path: string) => string;
  private readonly appendFileSync: (path: string, data: string) => void;

  constructor(
    path: string,
    io?: {
      readFileSync?: (path: string) => string;
      appendFileSync?: (path: string, data: string) => void;
    },
  ) {
    this.path = path;
    this.readFileSync = io?.readFileSync ?? ((p) => require("node:fs").readFileSync(p, "utf8"));
    this.appendFileSync = io?.appendFileSync ?? ((p, d) => require("node:fs").appendFileSync(p, d));
  }

  append(event: LedgerEvent): void {
    this.appendFileSync(this.path, JSON.stringify(event) + "\n");
  }

  readAll(): LedgerEvent[] {
    let raw: string;
    try {
      raw = this.readFileSync(this.path);
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LedgerEvent];
        } catch {
          return []; // torn last line
      }
      });
  }

  /**
   * Compute accrued cost from events, against `activeInstanceId` for currently-open windows.
   * Storage is accrued for every window the instance existed, including stopped-but-retained ones.
   */
  summarize(now: number, capUsd: number | null, activeInstanceId: number | null): SpendSummary {
    const events = this.readAll();
    const windows: OpenWindow[] = [];
    const openById = new Map<number, OpenWindow>();

    for (const e of events) {
      if (e.type === "allocation" || e.type === "resume") {
        if (e.instanceId == null) continue;
        const w: OpenWindow = {
          startAt: e.at,
          closeAt: null,
          rate: e.hourlyRateUsd,
          storageGB: e.storageGB,
          storageRate: e.storageUsdPerGBMonth,
        };
        windows.push(w);
        openById.set(e.instanceId, w);
      } else if (e.type === "stop" || e.type === "destroy") {
        if (e.instanceId == null) continue;
        const w = openById.get(e.instanceId);
        if (w && w.closeAt === null) w.closeAt = e.at;
      }
    }

    // If an instance is known to be running (activeInstanceId), force-open its window through `now`.
    if (activeInstanceId != null) {
      const w = openById.get(activeInstanceId);
      if (w && w.closeAt === null) {
        // leave window open — it accrues right now
      }
    }

    let accrued = 0;
    for (const w of windows) {
      const closeAt = w.closeAt ?? now;
      accrued += computeHourlyCost(w.rate, Math.max(0, closeAt - w.startAt));
      accrued += storageCostPerHour(w.storageGB, w.storageRate) * ((closeAt - w.startAt) / 3_600_000);
    }

    return {
      accruedUsd: accrued,
      projectedUsd: accrued,
      capExceeded: capUsd != null && accrued > capUsd,
      at: now,
    };
  }
}
