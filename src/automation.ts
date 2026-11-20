/** Automation orchestration with injected enclave and loopback transport. */
export interface AutomationSecrets {
  controlToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tailnetKey: string;
  basicUser: string;
  basicPass: string;
}

export interface AutomationStore {
  get(key: string, user: string): Promise<string | null>;
  put(key: string, value: string, user: string): Promise<void>;
}
export type GatewayCall = (path: string, method: string, token: string, body?: unknown) => Promise<any>;
const SECRETS = "automation-credentials-v1";
const STATE = "automation-tailnet-state-v1";

export class AutomationController {
  constructor(private store: AutomationStore, private call: GatewayCall) {}

  async save(user: string, secrets: AutomationSecrets): Promise<void> {
    if (!user || Object.values(secrets).some(v => typeof v !== "string" || !v.trim()) ||
        !/^[^:\s]+$/.test(secrets.basicUser)) throw new Error("invalid_credentials");
    await this.store.put(SECRETS, JSON.stringify(secrets), user);
  }

  private async secrets(user: string): Promise<AutomationSecrets> {
    if (!user) throw new Error("user_required");
    const saved = await this.store.get(SECRETS, user);
    if (!saved) throw new Error("credentials_required");
    return JSON.parse(saved) as AutomationSecrets;
  }

  async status(user: string): Promise<any> {
    const s = await this.secrets(user);
    await this.call("/gateway/v1/runtime/credentials", "POST", s.controlToken,
      { client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken });
    return this.call("/gateway/v1/runtime", "GET", s.controlToken);
  }

  async start(user: string): Promise<void> {
    const s = await this.secrets(user);
    const savedState = await this.store.get(STATE, user);
    const state = savedState ? JSON.parse(savedState) : {};
    const existing = await this.call("/gateway/v1/runtime/bootstrap", "GET", s.controlToken);
    if (existing.status !== "idle") throw new Error("bootstrap_result_pending");
    await this.call("/gateway/v1/runtime/credentials", "POST", s.controlToken,
      { client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken });
    const allocation = await this.call("/gateway/v1/runtime", "POST", s.controlToken);
    // Do not rerun notebook setup on a reused runtime that may contain work.
    if (allocation.reused) throw new Error("runtime_already_exists");
    await this.call("/gateway/v1/runtime/bootstrap", "POST", s.controlToken,
      { ts_authkey: s.tailnetKey, basic_user: s.basicUser, basic_pass: s.basicPass, state });
  }

  async poll(user: string): Promise<{ status: string; workerHealthy?: boolean; error?: string }> {
    const { controlToken } = await this.secrets(user);
    const job = await this.call("/gateway/v1/runtime/bootstrap", "GET", controlToken);
    if (job.status !== "finished") return { status: job.status };
    if (job.httpStatus !== 200 || !job.result?.ok) {
      // Clear only after capturing a nonsecret failure, permitting an explicit retry.
      const error = typeof job.result?.error === "string" ? job.result.error : "bootstrap_failed";
      await this.call("/gateway/v1/runtime/bootstrap", "DELETE", controlToken);
      return { status: "failed", error };
    }
    if (!job.result.state || typeof job.result.state["tailscaled.state"] !== "string") {
      throw new Error("identity_missing");
    }
    // Save before acknowledging: an enclave failure must leave the job recoverable.
    await this.store.put(STATE, JSON.stringify(job.result.state), user);
    await this.call("/gateway/v1/runtime/bootstrap", "DELETE", controlToken);
    return { status: "finished", workerHealthy: job.result.workerHealthy === true };
  }

  async stop(user: string): Promise<any> {
    const s = await this.secrets(user);
    await this.call("/gateway/v1/runtime/credentials", "POST", s.controlToken,
      { client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken });
    // A restarted gateway discovers its owned runtime before deletion.
    await this.call("/gateway/v1/runtime", "GET", s.controlToken);
    return this.call("/gateway/v1/runtime", "DELETE", s.controlToken);
  }

  async idle(user: string, minutes: number): Promise<any> {
    const { controlToken } = await this.secrets(user);
    return this.call("/gateway/v1/runtime/idle", "PUT", controlToken, { minutes });
  }
}
