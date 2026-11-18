/**
 * Vast.ai provider types — derived from vast-ai/docs OpenAPI (`api-reference/openapi.yaml`,
 * retrieved 2026-11-18) and vast-cli source (`vastai/api/instances.py`, `client.py`).
 * Numbers for RAM/VRAM are MB for REST endpoints; disk is GB.
 * NOTE: `instance.id` in responses is the contract ID; create returns `new_contract`.
 */

export type VastOfferState = "ondemand" | "bid" | "reserved";

export interface VastOffer {
  id: number;
  machine_id: number;
  bundle_id?: number;
  gpu_name: string;
  gpu_ram: number; // MB
  cpu_ram: number; // MB
  disk_space: number; // GB
  reliability: number;
  dph_total: number; // $/hour, total ask
  min_bid?: number | null;
  inet_down: number; // MB/s
  inet_up: number;
  geolocation?: string;
  public_ipaddr?: string;
  rentable: boolean;
  rented: boolean;
  verified?: string;
  cpu_cores?: number;
  cpu_arch?: string;
  cuda_max_good?: number;
  storage_cost?: number; // $/GB/month
  duration?: number; // seconds offer remains available
  is_vm_deverified?: boolean;
}

export interface VastInstanceInfo {
  id: number; // contract ID
  machine_id: number;
  actual_status: "running" | "stopped" | "exited" | "unknown" | "loading" | string | null;
  intended_status?: string | null;
  cur_state?: string | null;
  next_state?: string | null;
  label: string | null;
  start_date?: number;
  end_date?: number | null;
  uptime_mins?: number | null;
  dph_total?: number;
  gpu_name?: string;
  gpu_ram?: number;
  cpu_ram?: number;
  ssh_host?: string;
  ssh_port?: number;
  public_ipaddr?: string;
  ports?: Array<[number, number]> | number[];
  jupyter_token?: string;
}

export interface OfferSearchPolicy {
  gpuNames?: string[]; // default "RTX 3090", "RTX 4090", "RTX 5090" — space-separated, as Vast stores them
  minVramMB?: number; // default 24000
  minRamMB?: number; // default 32000
  minDiskGB?: number; // default 80
  minReliability?: number; // default 0 = unfiltered (Vast applies no default reliability floor)
  maxDphHourly?: number; // default 0.50 (PRD default visible price filter)
  minDurationSeconds?: number; // default 0 = unfiltered
  geolocation?: string[];
  limit?: number; // default 64
}

export const DEFAULT_OFFER_POLICY: Required<OfferSearchPolicy> = {
  gpuNames: ["RTX 3090", "RTX 4090", "RTX 5090"],
  minVramMB: 24_000,
  minRamMB: 32_000,
  minDiskGB: 80,
  minReliability: 0, // unfiltered — vast-cli applies no reliability floor either
  maxDphHourly: 0.5,
  minDurationSeconds: 0, // unfiltered
  geolocation: [],
  limit: 64,
};

export interface VastCreateRequest {
  offerId: number;
  image: string;
  diskGB: number; // GB
  label?: string | null;
  onstart?: string | null; // ≤4048 chars
  env?: string | null; // "-e KEY=VAL -p host:container"
  runtype?: "ssh" | "args" | "ssh_proxy" | "ssh_direct" | "jupyter" | "jupyter_proxy";
  args?: string[] | null;
  target_state?: "running" | "stopped";
}

export interface VastCreateResult {
  success: boolean;
  new_contract?: number;
  error?: string;
  msg?: string;
  ask_id?: number;
}

export interface VastShowResult {
  instances: VastInstanceInfo | null;
}

export interface VastListResult {
  instances: VastInstanceInfo[];
  next_token?: string | null;
  total_instances?: number;
}

export interface VastSimpleResult {
  success: boolean;
  msg?: string;
  error?: string;
}
