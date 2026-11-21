/** Tracks manager-submitted jobs without retaining prompt contents. */
export class JobTracker {
  private pending = new Set<string>();
  private uncertain = false;
  private submitting = 0;
  private lastActivity: string | null = null;
  private lastEvent = "none";
  constructor(private onEvent: (event: string) => void = () => {}) {}
  private mark(event: string) { this.lastActivity = new Date().toISOString(); this.lastEvent = event; this.onEvent(event); }
  restoreUncertain() { this.uncertain = true; this.mark("restored_uncertain"); }
  submissionStarted() { this.submitting++; this.mark("submission_started"); }
  submissionFinished(status: number | null, body?: unknown) {
    this.submitting = Math.max(0, this.submitting - 1);
    if (status !== null && status >= 400 && status < 500) { this.mark("submission_rejected"); return; }
    const id = (body as any)?.prompt_id;
    if (status !== null && status >= 200 && status < 300 && typeof id === "string" && /^[0-9a-fA-F-]{36}$/.test(id)) {
      this.pending.add(id); this.mark("job_accepted");
    } else { this.uncertain = true; this.mark("submission_uncertain"); }
  }
  websocket(message: unknown) {
    if (typeof message !== "string" || message.length > 65536) return false;
    try {
      const event = JSON.parse(message); const id = event?.data?.prompt_id;
      if (typeof id !== "string" || !this.pending.has(id)) return false;
      if (event.type === "execution_success" || event.type === "execution_error" || event.type === "execution_interrupted" ||
          (event.type === "executing" && event.data.node === null)) {
        this.pending.delete(id); this.mark("job_finished"); return true;
      } else if (["executing", "progress", "execution_start", "execution_cached"].includes(event.type)) { this.mark("job_progress"); return true; }
    } catch { /* Ignore non-JSON and unrelated messages. */ }
    return false;
  }
  history(id: string, body: unknown) {
    const entry = (body as any)?.[id];
    if (this.pending.has(id) && entry?.status?.completed === true) { this.pending.delete(id); this.mark("job_finished"); }
  }
  reset() { this.pending.clear(); this.uncertain = false; this.submitting = 0; this.mark("runtime_ended"); }
  snapshot() { return { state: this.uncertain ? "uncertain" : this.submitting ? "submitting" : this.pending.size ? "active" : "idle", pendingJobs: this.pending.size, lastActivity: this.lastActivity, lastEvent: this.lastEvent }; }
  blocksIdle() { return this.uncertain || this.submitting > 0 || this.pending.size > 0; }
}
