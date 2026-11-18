# ADR-001 — Native integration (gateway) for the Remote GPU Manager

**Status:** Accepted structurally; transport retargeted by v2.0 (Vast.ai). See `docs/adr/adr-003-vast-lifecycle-transport.md` for the current transport decision.
**Date (original):** 2026-11-17 · **Updated (v2.0 retarget):** 2026-11-18
**Evidence sources:** Lumiverse upstream `main` @ `45f8db56` (v1.2.5) and `staging` @ `5361e4fa` (v1.3.0), `lumiverse-spindle-types` 0.6.49/0.6.80, `docs.lumiverse.chat` (2026-11-17), `lumiverse.chat/guides/image-generation/setup/`, Vast.ai OpenAPI + vast-cli (2026-11-18)

> **v2.0 retarget note:** The decision (loopback gateway pattern, route allowlist, auth injection, WS support) stands. What changes: the upstream is no longer an ngrok/quick-tunnel URL entered manually. It is a **Vast instance endpoint discovered via the Vast API** (`ssh_host`/`public_ipaddr`/ports) or a Space-side relay pointed at it. TLS with per-instance credentials is the default; the trigger for upstream auth headers is the dedicated managed connection. The gateway is now optional for the direct case (if Vast endpoint TLS+creds verify from the Space), mandatory for the relay case. Ngrok/Basic-Auth-over-quick-tunnel is no longer the reference implementation.

## Context

The product requirement (PRD §2.3, §5.2) is to make remote ComfyUI feel like a native Lumiverse image-generation provider without rebuilding Lumiverse features, and to reuse native connectivity (saved ComfyUI connection profile, workflow import, LoRA Studio, native gallery) wherever supported.

M0 inspection of the installed/pinned source shows exactly what "native" can and cannot do today, and where the seam must be.

## Decision

Use a **narrowly scoped, loopback-only host-side gateway** (separate trusted process on the same machine/container as Lumiverse) as the stable ComfyUI endpoint configured on the native connection profile. The gateway:

1. Binds `127.0.0.1` only; never exposes a new public port on the Space or dev host.
2. Proxies only an allowlisted set of ComfyUI routes (versioned list: `GET /system_stats`, `GET /object_info` + `/object_info/{node}`, `POST /prompt`, `GET /history/{id}`, `GET /view`, `GET /queue`, `POST /interrupt` + allowlisted `/queue` mutations, `POST /upload/image`, catalog routes actually used by the provider, `/ws` upgrade). No arbitrary upstream proxy, no SSRF, no redirects with credentials.
3. Injects upstream authentication server-side (e.g. `Authorization: Basic …` plus `ngrok-skip-browser-warning: 1`) read from a gateway-local secret store; TLS upstream; never logs credentials or prompts.
4. Implements `ensureReady` semantics on the request path: if the worker is offline and the selected provider mode permits automation, provision/await readiness (single-flight) before proxying; in manual mode, fail fast with a typed "needs manual startup" error instead of auto-starting.

Fallback (only if the isolated gateway process is rejected for the deployment): a **first-party route in a local Lumiverse fork** with the same loopback binding and allowlist semantics. A narrow provider patch that only injects an `Authorization` header is acceptable **only** as an M1 stopgap; it cannot deliver cold-start and is not sufficient for M5.

The Spindle extension owns the dashboard, durable state, settings/profiles and enclave secrets, and drives the gateway through a loopback-only control API (extension → host `spindle.cors()` to `127.0.0.1`, which the host proxy explicitly permits for private/loopback targets). The gateway is the enforcement point on the generation request path; the extension never claims to have made the worker ready — it reads back verified gateway state.

## Findings that forced this decision (verified against source)

### 1. Native ComfyUI provider cannot send upstream auth
`src/image-gen/providers/comfyui.ts`: the profile's API key is never used (`_apiKey` parameter), `apiKeyRequired: false`; connection validation does `fetch(\`${baseUrl}/system_stats\`)` with **no headers**. `src/image-gen/providers/comfy-runner.ts` builds headers via `buildHeaders(cookie)` — **Cookie only** (used for SwarmUI `/ComfyBackendDirect`); no `Authorization: Basic` or Bearer support anywhere. WS open (`openWebSocket`) also sends headers only when a cookie is set. `src/image-gen/comfyui-discovery.ts` (`resolveComfyTarget`) maps `swarmui` → `/ComfyBackendDirect` with a `swarm_token` cookie; for `comfyui` it returns the raw base URL with no auth.

Consequence: a native ComfyUI connection pointed at an ngrok Basic Auth endpoint **will fail validation, model listing, object_info, WS connect, prompt submission and image fetch** (all return 401/403). This is the same gap the PRD predicted ("missing Basic Auth support … treat this as a regression test"); it is confirmed on current `main`, not assumed.

### 2. Native request ordering opens WS before submission
`executeComfyWorkflowStream` (comfy-runner.ts): opens `/ws?clientId=<uuid>` **first**, then `POST /prompt` with `client_id`. With an offline worker the WS connect itself fails, so the native pipeline never reaches `/prompt`. Any cold-start design must therefore act **before or inside the gateway**, not after the native call starts; there is no extension-visible "about to generate" hook in the native path.

### 3. Spindle extensions cannot register inbound HTTP/WS listeners
`docs.lumiverse.chat/getting-started/capabilities/`: `fs`, `child_process`, raw sockets (`http`, `https`, `net`, `tls`), `Bun.serve`, `Bun.spawn` etc. are hard-blocked with no opt-in capability. `spindle.cors()` / `spindle.corsProxy` are **outbound** only (they do permit loopback/private targets — which is what makes the extension→gateway control channel viable). No inbound listener API exists. Therefore "just build the gateway inside the extension" is impossible.

### 4. Spindle cannot mutate native connection profiles or hook native image generation
`lumiverse-spindle-types` 0.6.49/0.6.80: image-gen surfaces are `listConnections`/`getConnection`/`getModels` (read-only); there is no create/update connection API and no profile-field write API. The only image-gen write surfaces are `generate`/`generateNative`/`generateStream` (extension-initiated generation, not a native-request hook). `generateNative()` runs the full native pipeline (scene parse, LoRA stack, workflow patch) and is suitable for smoke tests only. Interceptors are LLM-only; no image-gen interceptor exists. `image_gen` permission is required for any of these and must be requested explicitly.

### 5. Native LoRA insertion is write-into-existing-nodes only; auto-detection is LoraLoader-only
`src/image-gen/comfyui-workflow-patch.ts` (`patchWorkflow`): values are **only** written into mapped, pre-existing nodes; it never inserts nodes. Ordered LoRA stack entries are mapped positionally onto mapped LoRA nodes (`buildLoraEntryMap`). `comfyui-workflow-parser.ts` `KNOWN_FIELD_HINTS` contains `LoraLoader` (`lora_name`, `strength_model`, `strength_clip`) but **not** `LoraLoaderModelOnly` / `LoraLoaderBypassModelOnly`. `EmptyFlux2LatentImage` (width/height), `UNETLoader`, `CLIPLoader`, `VAELoader` are likewise not auto-detected. `KSampler`, `CLIPTextEncode` (with the two-encode→second-is-negative heuristic) and `CheckpointLoaderSimple`/`UNETLoader(unet)` are hinted. Character/preset/extra LoRA layers are merged in `image-gen.service.ts` and passed as ordered `loras` patch values (§ `applyActiveComfyUIWorkflowConfig`), but only mapped nodes receive them.

Consequence for the MOSS template: the shipped API workflow must either (a) embed the optional model-only LoRA nodes (IDs ≥ 100, before KSampler) with **manual field mappings** (`lora_name`, `lora_strength_model`; never `lora_strength_clip`), or (b) receive a narrow host patch to splice `LoraLoaderModelOnly` nodes. Option (a) with manual mappings is preferred for M1/M3; any host patch is conflict-prone and needs explicit approval (see §11 PRD; decision pending real testing). "MOSS via native LoRA Studio" is **not** plug-and-play today.

### 6. Discovery/health behavior at generation time
`applyActiveComfyUIWorkflowConfig` calls `getComfyUIObjectInfo(baseUrl)` (5-min cache; `queryAllNodeInfo` failure → `null`, no throw) then `patchWorkflow(...)`. Discovery (`discoverCapabilities`) fires parallel node queries on demand (capabilities button). So at generation time there is at most one upstream `/object_info` (cache-dependent); health polling is **not** part of the native path. This matches PRD R-05's requirement that discovery requests must not allocate a GPU.

### 7. No per-connection auth fields exist for the ComfyUI provider
The ComfyUI connection form has no username/password/bearer fields (`apiKeyRequired: false`, `has_api_key` semantics exist on the profile DTO but the provider ignores the key). Storing Basic Auth in the profile's API-key field would not work without a provider patch; storing it in `metadata` would have no transport effect either.

## Rejected alternatives

- **Pure Spindle extension:** impossible — no inbound listener, no header injection into native path, no profile mutation, no image-gen hook. Rejected.
- **Notebook/browser automation to bypass auth or provider policy:** prohibited by the PRD and by Colab policy. Rejected.
- **Public unauthenticated gateway on the Space:** prohibited by PRD R-01/R-12; rejected.
- **Configurable upstream URL proxy ("generic fetch" gateway):** SSRF/credential-leak risk; rejected in favor of a versioned route allowlist.
- **Forking Lumiverse just to inject `Authorization: Basic`** (provider-only patch): viable M1 stopgap, but it is not a lifecycle solution and creates fork drift; keep as documented fallback only.

## Consequences

- M1 can be developed and tested locally with a mock ComfyUI + the gateway; **but** end-to-end validation from the real Lumiverse Space to the ngrok/Colab worker remains outstanding (the user's prior HTTP 200 test originated from Colab itself, not from the Space).
- Deploying the gateway to the HF Space requires a small, reviewable change to the Space's container/entrypoint (start the gateway alongside Lumiverse, loopback-bound). This is a Space change requiring explicit user approval before it happens.
- The control channel extension→gateway uses `spindle.cors()` + `cors_proxy` permission targeting loopback; enclave stores the gateway-upstream secrets; gateway restart policy and health are part of the host-side deployment docs (M6).
- The Spindle types host pin (0.6.49) is older than latest (0.6.80); the extension must feature-detect optional methods (`getPromptPresets?`, `cancelNative?`) and pin its own SDK dependency to a compatible range.

## Open items (need user input / live tests)

1. HF Space deployment details: base image, how Lumiverse is started there, persistent path (historically `/app/data`, confirmed by upstream Dockerfile `ENV DATA_DIR=/app/data`), and whether a sidecar gateway process is acceptable (vs. local-fork route). **User chose: no Space change approved yet for v1.3.0.**
2. Installed Space version: **v1.3.0** (user-reported). Verified as `staging` @ `5361e4fa`; exact deployed commit unconfirmed. Behavior re-checked against staging — ComfyUI provider identical to main; findings stand. WS handshake test still pending.
3. Live authenticated WS handshake test through the gateway from the real Space (M1). Pending Space approval.
4. Whether a narrow `ensureReady` entrypoint patch is still wanted if the gateway route variant is adopted (PRD Option 3) — expected answer: no, the gateway covers it.
