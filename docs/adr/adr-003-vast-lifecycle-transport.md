# ADR-003 — Vast.ai lifecycle and transport (V0–V2 focus)

**Status:** Accepted for design; no live validation yet
**Date:** 2026-11-18

## Context

PRD v2.0 makes Vast.ai the primary automated GPU backend. The existing v1.1 Colab chain (manual notebook + ngrok/quick tunnel + Space-side gateway) proved two things:

1. Lumiverse's native ComfyUI provider cannot send upstream credentials (HTTP and WS) — confirmed from source on `main` (v1.2.5) and `staging` (v1.3.0, pinned host).
2. The Space can be made to reach a worker it can route to — or it cannot, depending on HF egress (ngrok blocked for this Space after a burst; huggingface.co/github.com allowed).

Therefore transport on Vast should not bet on tunnels.

## Decision

1. **Provider interface** — wrap Vast REST in a typed `GpuProvider` (see `src/providers/vast/`): `capabilities`, `searchOffers`, `listOwned`, `create`, `inspect`, `start`, `stop`, `destroy`, `discoverEndpoint`. Mock implements the same contract for CI.
2. **Transport** — primary: **instance-side TLS termination on the Vast instance** via a pinned Caddy proxy with a per-instance Basic Auth credential; ComfyUI binds loopback (`127.0.0.1:8188`); Caddy publishes `https://<instance-host>:port` with a project-owned per-instance username/password. Verification from the Space is mandatory (TLS + Basic Auth + WS upgrade). Fallback (if image/template cannot run Caddy or TLS verification fails): a Vast-supported secured endpoint or, only with owner approval, an authenticated broker with TLS. **Ngrok and unauthenticated ports are not required and are not defaults.**
3. **Stable Space-side route** — one dedicated native ComfyUI connection profile (`http://<stable>` or `http://127.0.0.1:8189` relay) pointing at the Space-side gateway relay if needed; relay target = current worker endpoint + epoch. Keep the Space-side gateway code for this relay; transport details (TLS/basic auth) change, algorithm unchanged. Direct Space→Vasta instance `https://` is acceptable if TLS verifies cleanly from Space.
4. **Lifecycle** — one on-demand instance; `RUNNING/STOPPED/RESUMED/DESTROYED` mapped from Vast `actual_status/intended_status` (`exited|unknown|offline` = failed, never poll forever). Defaults (editable, not approved spend): RTX 3090, ≥24 GB VRAM, ≥32 GB RAM, ~60 GB disk (weights-optimized manifest), reliability ≥ 0.99, ≤ $0.20/hr, stop (not destroy) after 5 min idle. Stopping precedes destruction; destroy requires explicit approval and data-loss acknowledgement; stopped storage accrues and is shown to the user.
5. **Single-flight & reconciliation** — allocation intent persisted before `create`; `new_contract` persisted immediately as instance ID; ambiguous create → reconcile via `show_instance` before any retry; no blind repeat. Watchdog: scoped instance-side deadline + owner-configured provider-side cleanup, independently verified; **no unattended auto-start until an independent safety mechanism is proven**.
6. **Cost** — ledger written on every claimed instance (epoch-tagged), estimated running cost, stopped storage estimate, absolute expiry; any work beyond approved cap requires explicit owner approval before allocation.

## Vast API contract (from `vast-ai/docs` OpenAPI + `vast-cli` source, 2026-11-18)

Base: `https://console.vast.ai`. Auth: `Authorization: Bearer <VAST_API_KEY>`.

| Action | Endpoint | Notes |
|---|---|---|
| Search offers | `POST /api/v0/bundles` | Body: `{limit, type:"on-demand", rented:{eq:false}, gpu_name:{in:["RTX 3090","RTX 4090"]}, allocated_storage:5, dph_total:{lte:...}, disk_space:{gte:...}, cpu_ram (MB!), gpu_ram (MB!)}` → `{offers:[...]}` with `dph_total`, `gpu_ram` MB, `public_ipaddr`, `dph_total_adj`. NOTE: `type` is `"on-demand"` with a hyphen; `gpu_name` uses **space-separated names** (`RTX 4090`, `Tesla V100`) — vast-cli silently converts `_` → ` ` before querying. `verified`/`rentable`/`reliability` are NOT default-filtered by vast-cli; hard-coding them yields empty result sets. |
| Create instance | `PUT /api/v0/asks/{offer_id}` | Body: `{image, disk (GB), label, onstart (≤4048 chars), env ('-e K=V -p p:p'), runtype ('ssh'/'args'/...), target_state:"running", tz, args}` → `{success:true, new_contract:<instance_id>}` |
| Show instance | `GET /api/v0/instances/{id}` (v0) and `GET /api/v1/instances/{id}/?owner=me` (v1, paginated list elsewhere) | Response wraps `{instances: {...}}` (v0) or flat (v1); both include `actual_status`, `intended_status`, `ssh_host/ssh_port`, `dph_total`, `gpu_ram` MB, `label`, `machine_id`, `start_date`, `public_ipaddr`, `ports` |
| List instances | `GET /api/v1/instances/` (`select_filters`, `order_by`, `limit`, `after_token`) | CLI uses v1 for lists |
| Start/stop/label | `PUT /api/v0/instances/{id}` | Body: `{"state":"running"\|"stopped"}` or `{"label":"..."}` |
| Destroy | `DELETE /api/v0/instances/{id}` | Irreversible; requires explicit owner confirmation + loss warning |
| SSH key register | `POST /api/v0/ssh` (VM flow only) | Not needed for Docker template flow |

Quirks (from OpenAPI “Key Quirks”): `gpu_ram` REST = MB; create returns `new_contract` (not `id`); `onstart` ≤ 4048 chars; SSH key must exist before VM create; if `actual_status ∈ {exited, unknown, offline}` the instance will never reach `running` — treat as failed and clean up. Poll with `owner=me` filter. `host_id` may differ per offer.

## Consequences

- The Space-side gateway code path is preserved for an internal relay if Space→Vast TLS fails; direct `https://<vast-host>` (verified) is preferred.
- `start`/`stop` are distinct from create/destroy everywhere; UI shows three destructive affordances (Stop = pause billing only on compute, Destroy = delete disk + data).
- Unattended production auto-start is blocked until an independently verified watchdog exists — even for a fully automated offer.
- All pricing values shown in UI must come from a live quote or a clearly labeled “estimate from cached offer”; never from a static table.
