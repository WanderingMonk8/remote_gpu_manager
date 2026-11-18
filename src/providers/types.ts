/**
 * Provider-agnostic GPU backend contract (PRD v2.0 §4.2).
 * Implementations: `providers/vast/` (real API, mocked HTTP in tests) and `providers/mock/`.
 */
import type { OfferSearchPolicy, VastCreateRequest, VastInstanceInfo, VastOffer } from "./vast/types";

export type { VastCreateRequest, VastInstanceInfo, VastOffer, OfferSearchPolicy } from "./vast/types";

export interface ProviderCapabilities {
  autoProvision: boolean;
  autoDelete: boolean;
  externalInferenceAllowed: boolean;
  supportsRuntimeDiscovery: boolean;
  persistentStorage: boolean;
}

export interface GpuProvider {
  capabilities(): Promise<ProviderCapabilities>;
  searchOffers(policy?: OfferSearchPolicy): Promise<VastOffer[]>;
  listOwned(): Promise<Array<VastInstanceInfo & { ownedByUs: boolean }>>;
  create(request: VastCreateRequest, intentId: string): Promise<{ instanceId: number }>;
  inspect(instanceId: number): Promise<VastInstanceInfo | null>;
  start(instanceId: number): Promise<boolean>;
  stop(instanceId: number): Promise<boolean>;
  destroy(instanceId: number): Promise<boolean>;
}
