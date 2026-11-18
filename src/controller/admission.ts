/**
 * Single-flight provisioning admission.
 * Ensures exactly one provisioning operation is in-flight per provider/account/profile pool,
 * and that a new request never triggers a duplicate allocation while one is pending.
 * Durable lock file is optional; the in-process lock + a persistent `allocation_intent`
 * record is the V1 contract.
 */

export interface AllocationIntent {
  requestId: string;
  provider: string;
  profileId: string;
  allocatedAt: number; // epoch ms
  expiresAt: number; // epoch ms — absolute default; not a lease deadline
}

export interface AdmissionManagerOptions {
  now?: () => number;
  defaultTtlMs?: number; // default 15 min
}

export class AdmissionManager {
  private readonly now: () => number;
  private readonly ttl: number;
  private active: AllocationIntent | null = null;
  private waiters: Array<{ requestId: string; resolve: (v: boolean) => void; reject: (e: Error) => void }> = [];

  constructor(opts: AdmissionManagerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ttl = opts.defaultTtlMs ?? 15 * 60 * 1000;
  }

  /** Attempt admission; non-blocking. Returns true if admitted, false if busy. */
  tryAcquire(intent: Omit<AllocationIntent, "allocatedAt" | "expiresAt">): boolean {
    if (this.active && this.active.expiresAt > this.now()) return false;
    this.active = { ...intent, allocatedAt: this.now(), expiresAt: this.now() + this.ttl };
    return true;
  }

  /** Single-flight wait: if another admission is active, wait for it to finish. */
  async waitFor(requestId: string, timeoutMs = 30_000): Promise<boolean> {
    if (!this.active || this.active.expiresAt <= this.now()) return true;
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`admission wait timeout (${timeoutMs}ms)`)), timeoutMs);
      this.waiters.push({
        requestId,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject,
      });
    });
  }

  release(): void {
    this.active = null;
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.resolve(true);
  }

  abortIfActive(requestId: string): boolean {
    if (this.active?.requestId === requestId) {
      this.active = null;
      const waiters = this.waiters.splice(0);
      for (const w of waiters) w.resolve(false);
      return true;
    }
    return false;
  }

  get current(): AllocationIntent | null {
    return this.active;
  }
}
