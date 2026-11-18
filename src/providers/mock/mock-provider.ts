/**
 * Deterministic mock Vast provider — same GpuProvider contract, no network.
 * Used for controller/reconciliation tests and for UI work before any paid
 * access is granted.
 */
import { GpuProvider, ProviderCapabilities } from "../types";
import {
  OfferSearchPolicy,
  VastCreateRequest,
  VastInstanceInfo,
  VastOffer,
} from "../vast/types";
import { DEFAULT_OFFER_POLICY } from "../vast/types";

export interface MockCalls {
  offers: number;
  created: number;
  started: number;
  stopped: number;
  destroyed: number;
  inspected: number;
}

export class MockVastProvider implements GpuProvider {
  readonly calls: MockCalls = { offers: 0, created: 0, started: 0, stopped: 0, destroyed: 0, inspected: 0 };
  private readonly instances = new Map<number, VastInstanceInfo>();
  private nextId = 900001;

  constructor(private readonly startAsStopped = false) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      autoProvision: true,
      autoDelete: true,
      externalInferenceAllowed: true,
      supportsRuntimeDiscovery: false, // Vast has no session API; readiness proven via ComfyUI /system_stats
      persistentStorage: true,
    };
  }

  private readonly offersFixture: VastOffer[] = [
    {
      id: 1001, machine_id: 11, gpu_name: "RTX_3090", gpu_ram: 24576, cpu_ram: 65536,
      disk_space: 512, reliability: 0.999, dph_total: 0.18, inet_down: 4000, inet_up: 1500,
      geolocation: "US", public_ipaddr: "203.0.113.10", rentable: true, rented: false,
      verified: "verified", duration: 86_400 * 30,
    },
    {
      id: 1002, machine_id: 12, gpu_name: "RTX_4090", gpu_ram: 24576, cpu_ram: 131072,
      disk_space: 1024, reliability: 0.998, dph_total: 0.28, inet_down: 6000, inet_up: 3000,
      geolocation: "DE", public_ipaddr: "198.51.100.7", rentable: true, rented: false,
      verified: "verified", duration: 86_400 * 30,
    },
  ];

  async searchOffers(policy?: OfferSearchPolicy): Promise<VastOffer[]> {
    this.calls.offers++;
    const p = { ...DEFAULT_OFFER_POLICY, ...(policy ?? {}) };
    return this.offersFixture.filter((o) =>
      p.gpuNames.includes(o.gpu_name)
      && o.reliability >= p.minReliability
      && o.gpu_ram >= p.minVramMB
      && o.cpu_ram >= p.minRamMB
      && o.disk_space >= p.minDiskGB
      && o.dph_total <= p.maxDphHourly,
    );
  }

  async listOwned() {
    return [...this.instances.values()].map((i) => ({ ...i, ownedByUs: true }));
  }

  async create(request: VastCreateRequest, _intentId: string) {
    this.calls.created++;
    const id = this.nextId++;
    const running = !this.startAsStopped;
    this.instances.set(id, {
      id,
      machine_id: 9001,
      actual_status: running ? "running" : "stopped",
      intended_status: running ? "running" : "stopped",
      cur_state: running ? "running" : "stopped",
      label: request.label ?? null,
      start_date: Math.floor(Date.now() / 1000),
      end_date: null,
      uptime_mins: 0,
      dph_total: 0.18,
      gpu_name: "RTX_3090",
      gpu_ram: 24576,
      cpu_ram: 65536,
      ssh_host: `ssh${id}.vast.mock`,
      ssh_port: 12345,
      public_ipaddr: "203.0.113.10",
      ports: [9443],
    });
    return { instanceId: id };
  }

  async inspect(instanceId: number) {
    this.calls.inspected++;
    return this.instances.get(instanceId) ?? null;
  }

  async start(instanceId: number) {
    this.calls.started++;
    const i = this.instances.get(instanceId);
    if (!i) return false;
    i.actual_status = "running";
    return true;
  }

  async stop(instanceId: number) {
    this.calls.stopped++;
    const i = this.instances.get(instanceId);
    if (!i) return false;
    i.actual_status = "stopped";
    return true;
  }

  async destroy(instanceId: number) {
    this.calls.destroyed++;
    return this.instances.delete(instanceId);
  }
}
