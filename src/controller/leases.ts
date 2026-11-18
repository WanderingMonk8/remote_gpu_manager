/**
 * Lease tracker — bounds "real work" admission and idle determination.
 * JobLease covers: admitted job, queued job, download, output retrieval, native persistence.
 * Health polling and catalog browsing do NOT create leases.
 */

export type LeasePhase = "queued" | "admitted" | "downloading" | "running" | "retrieving" | "persisting";

export interface JobLease {
  jobId: string;
  requestId: string;
  promptId?: string;
  phase: LeasePhase;
  createdAt: number;
  updatedAt: number;
  deadlineMs: number;
}

export class LeaseTracker {
  private readonly now: () => number;
  private readonly leases = new Map<string, JobLease>();

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  admit(jobId: string, requestId: string, deadlineMs: number): JobLease {
    const now = this.now();
    const lease: JobLease = { jobId, requestId, phase: "queued", createdAt: now, updatedAt: now, deadlineMs };
    this.leases.set(jobId, lease);
    return lease;
  }

  transition(jobId: string, phase: LeasePhase): JobLease | null {
    const lease = this.leases.get(jobId);
    if (!lease) return null;
    lease.phase = phase;
    lease.updatedAt = this.now();
    return lease;
  }

  bindPromptId(jobId: string, promptId: string): JobLease | null {
    const lease = this.leases.get(jobId);
    if (!lease) return null;
    lease.promptId = promptId;
    lease.updatedAt = this.now();
    return lease;
  }

  /** Any tracked lease counts as real work (download/retrieve/persist included). */
  isActive(): boolean {
    return this.leases.size > 0;
  }

  forceRelease(jobId: string): void {
    this.leases.delete(jobId);
  }

  asList(): JobLease[] {
    return [...this.leases.values()];
  }
}
