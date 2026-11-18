/**
 * Typed Vast.ai REST client (V1 scope: read + lifecycle only).
 * Contracts validated against vast-ai/docs OpenAPI (`/api-reference/openapi.yaml`, 2026-11-18)
 * and vast-cli source (`vastai/api/instances.py`).
 *
 * Auth: `Authorization: Bearer <VAST_API_KEY>`.
 * Base: `https://console.vast.ai` (override with `baseUrl`).
 *
 * Notes baked into this client (not discovered at call time):
 *  - Offer search is `POST /api/v0/bundles` returning `{ offers: [...] }`.
 *  - Create is `PUT /api/v0/asks/{offerId}/`; success returns `new_contract`, NOT `id`.
 *  - Instance lookup is `GET /api/v0/instances/{id}/` returning `{ instances: {...} }`.
 *  - Listing owned instances uses the v1 endpoint `GET /api/v1/instances/` (paginated with
 *    `select_filters`/`order_by`/`limit`/`after_token`); v0 search is not used for owned instances.
 *  - Start/stop are `PUT /api/v0/instances/{id}/` with `{ state: "running"|"stopped" }`; destroy is `DELETE .../instances/{id}/`.
 *  - RAM/VRAM in REST are MB; disk is GB.
 */

import {
  OfferSearchPolicy,
  VastCreateRequest,
  VastCreateResult,
  VastInstanceInfo,
  VastListResult,
  VastOffer,
  VastShowResult,
  VastSimpleResult,
  DEFAULT_OFFER_POLICY,
} from "./types";

type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

const defaultFetch: FetchLike = async (input, init) => {
  const res = await fetch(input, init as RequestInit);
  return {
    status: res.status,
    ok: res.ok,
    json: () => res.json(),
    text: () => res.text(),
  };
};

export interface VastClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export class VastApiError extends Error {
  readonly status: number;
  readonly body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "VastApiError";
    this.status = status;
    this.body = body;
  }
}

export class VastClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: VastClientOptions) {
    if (!opts.apiKey || opts.apiKey.trim().length === 0) {
      throw new Error("VAST_API_KEY is required (server-side secret store or local env; never commit it)");
    }
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? "https://console.vast.ai").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = undefined;
      if (text.trim().length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new VastApiError(`Vast returned non-JSON (HTTP ${res.status})`, res.status, text.slice(0, 400));
        }
      }
      if (!res.ok) {
        throw new VastApiError(`Vast ${method} ${path} -> HTTP ${res.status}`, res.status, parsed);
      }
      return parsed as T;
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        throw new VastApiError(`Vast ${method} ${path} timed out after ${this.timeoutMs}ms`, 0);
      }
      if (err instanceof VastApiError) throw err;
      throw new VastApiError(`Vast ${method} ${path} failed: ${(err as Error).message ?? "network error"}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  async searchOffers(policy: OfferSearchPolicy = {}): Promise<VastOffer[]> {
    const p = { ...DEFAULT_OFFER_POLICY, ...policy };
    // vast-cli converts '_' -> ' ' in gpu_name values before querying; Vast stores names with spaces.
    const gpuNames = (p.gpuNames ?? [])
      .map((n) => n.trim().replace(/^["']+|["']+$/g, "").replace(/_+/g, " ").replace(/\s+/g, " "))
      .filter((n) => n.length > 0);
    const body: Record<string, unknown> = {
      limit: p.limit,
      type: "on-demand",
      rented: { eq: false },
      allocated_storage: 5,
    };
    if (gpuNames.length) body["gpu_name"] = { in: gpuNames };
    if (p.minReliability > 0) body["reliability"] = { gte: p.minReliability };
    if (p.minRamMB > 0) body["cpu_ram"] = { gte: p.minRamMB };
    if (p.minDiskGB > 0) body["disk_space"] = { gte: p.minDiskGB };
    if (p.minVramMB > 0) body["gpu_ram"] = { gte: p.minVramMB };
    if (p.maxDphHourly > 0) body["dph_total"] = { lte: p.maxDphHourly };
    if (p.geolocation?.length) body["geolocation"] = { in: p.geolocation };
    if (p.minDurationSeconds > 0) body["duration"] = { gte: p.minDurationSeconds };
    const res = await this.req<{ offers: VastOffer[] }>("POST", "/api/v0/bundles", body);
    return res.offers ?? [];
  }

  /** Create an instance from an offer. On success returns `new_contract` (the instance ID). */
  async createInstance(reqOffer: VastCreateRequest): Promise<VastCreateResult> {
    const body: Record<string, unknown> = {
      image: reqOffer.image,
      disk: reqOffer.diskGB,
      label: reqOffer.label ?? null,
      onstart: reqOffer.onstart ?? null,
      env: reqOffer.env ?? null,
      runtype: reqOffer.runtype ?? "ssh",
      ...(reqOffer.target_state ? { target_state: reqOffer.target_state } : {}),
      ...(reqOffer.args ? { args: reqOffer.args } : {}),
    };
    return this.req<VastCreateResult>("PUT", `/api/v0/asks/${reqOffer.offerId}/`, body);
  }

  async showInstance(id: number): Promise<VastInstanceInfo | null> {
    const res = await this.req<{ instances: VastInstanceInfo | null }>("GET", `/api/v0/instances/${id}/`);
    return res.instances ?? null;
  }

  /** Owned instances (v1 endpoint, paginated with `next_token`/`after_token`). */
  async listInstances(opts: { limit?: number; after_token?: string } = {}): Promise<VastListResult> {
    const params = new URLSearchParams();
    params.set("limit", String(opts.limit ?? 25));
    if (opts.after_token) params.set("after_token", opts.after_token);
    params.set("select_filters", JSON.stringify({}));
    params.set("order_by", JSON.stringify([{ col: "id", dir: "asc" }]));
    return this.req<VastListResult>("GET", `/api/v1/instances/?${params.toString()}`);
  }

  async startInstance(id: number): Promise<VastSimpleResult> {
    return this.req<VastSimpleResult>("PUT", `/api/v0/instances/${id}/`, { state: "running" });
  }

  async stopInstance(id: number): Promise<VastSimpleResult> {
    return this.req<VastSimpleResult>("PUT", `/api/v0/instances/${id}/`, { state: "stopped" });
  }

  async destroyInstance(id: number): Promise<VastSimpleResult> {
    return this.req<VastSimpleResult>("DELETE", `/api/v0/instances/${id}/`);
  }

  /** Convenience: map wire status → controller state. */
  static isInstanceRunning(info: VastInstanceInfo | null): boolean {
    return info?.actual_status === "running";
  }
}
