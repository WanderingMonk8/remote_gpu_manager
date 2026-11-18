# Vast.ai migration audit + V0 rebaseline (2026-11-18)

**Scope:** pivot from Colab-first (v1.1) to Vast.ai-first (v2.0). This document is the promised reuse/remove/defer map and current test-status snapshot. No paid calls were made; nothing was rented; no secrets were moved off the local machine.
**Branch:** `feat/vast-first` (from `main` @ `b95d948`).
**Supersession rule:** v2.0 PRD (now `PRD.md`) is authoritative. `docs/archive/PRD_v1.1_colab-first.md` kept for history; `docs/legacy/colab/*` keep the old records.

## What changed vs v1.1 (brief)

- Primary backend: Vast.ai on-demand GPU (RTX 3090-class, ≥24 GB VRAM) managed for automatic start/stop on native Lumiverse image requests.
- Ngrok/Cloudflare quick tunnels, Google OAuth, Drive mounts, notebook cell execution and manual-only policy are removed from the production path. Colab remains standalone/manual experimental reference; no further OAuth or Drive work.
- Native integration remains the same shape (gateway/route in front of Lumiverse's native ComfyUI provider), but transport changes to Vast-supported secured endpoints or an instance-side Caddy proxy with per-instance credentials; no dependency on Ngrok/quick tunnels.
- Native LoRA Studio remains authoritative; our Civitai resolver is a behind-the-scenes gap filler only if native behavior proves insufficient.

## Repository inventory

| Item | State |
|---|---|
| Current branch | `feat/vast-first` @ `main b95d948` (no remote yet) |
| Deployed Lumiverse | **v1.3.0** (user-reported) = upstream `staging` @ `5361e4fa`; upstream pins `lumiverse-spindle-types` 0.6.80; `main` v1.2.5 pins 0.6.49. ComfyUI provider files byte-identical between the two |
| Local Lumiverse clone | `D:\Programming\Lumiverse` (main, read-only reference) and `D:\Programming\Lumiverse-staging` (staging worktree) |
| Reference notebook | moved to `reference/Unified_MOSS_Anima_Colab_Studio.ipynb` (tracked, master-derived 2026-11-17; VRAM-fix variant `_VRAM_Fix.ipynb` referenced by v2.0 is **not in this repo** — flagged as open item) |
| Vast API docs | OpenAPI YAML retrieved from `vast-ai/docs` (`/api-reference/openapi.yaml`, 351 KB), vast-cli source (`vastai/api/instances.py`, `client.py`) reviewed for exact endpoints and semantics |
| Untracked user files | `docs/Coding_Agent_Migration_Directive_VastAI.md` (now moved to `docs/`) |

## Reuse / adapt / archive map

| Artifact | Disposition | v2.0 relevance |
|---|---|---|
| `host-gateway/gateway.ts` (loopback allowlist proxy, auth injection, WS proxy, retry, audit) | **Adapt** | Pattern reused for the *Space-side* relay if required for auth/stability, and for any *worker-side* proxy (instance-side Caddy is preferred on Vast). Route allowlist, WS forwarding, retry-on-reset, audit-without-prompt-images are all re-used verbatim in concept |
| `tests/mock-comfyui/server.ts` | **Reuse** — now becomes the mock GPU worker side of contract tests | Worker contract tests pin expected ComfyUI behavior (system_stats, object_info, prompt, history, view, WS) |
| `tests/integration.test.ts` | **Adapt** — mock-to-gateway tests become mock-to-worker-proxy + client-to-Vast-API (mocked HTTP fixtures) tests | Vast adapter contract tests + worker bootstrap tests |
| `workflows/moss-api.json`, `workflows/anima-turbo-v1.1-api.json` | **Reuse** (templates unchanged; ComfyUI target unchanged) | Worker-side native workflow import |
| `src/{backend,frontend}.ts` + `spindle.json` | **Adapt** — rebrand ("Remote GPU Manager" stays; Colab references removed from UI strings); permissions stay `cors_proxy`, `ui_panels`; `image_gen` NOT required for P0 (native button is the generator) | Extension shell for Vast lifecycle dashboard |
| Native provider research (v1.2.5/v1.3.0: no Basic Auth, WS before `/prompt`, LoRA patcher is write-into-existing-nodes + `LoraLoader`-only detection) | **Reuse** (unchanged conclusion) | ADR-001 outcome persists; transport/secret specifics change (Vast proxy, per-instance credential) |
| `docs/adr/adr-001-native-integration.md` | **Adapt** — update transport details; keep gateway decision; add Vast endpoint focus | ADR-001 (updated) |
| `docs/adr/adr-002-provider-feasibility.md` | **Superseded** — kept as history; Colab/manual mode demoted to standalone experimental | archived note |
| `tools/colab-eligibility-check.py` | **Archive** (moved to `reference/`) | none (Colab API not in scope) |
| `docs/legacy/colab/*` (m0 report, m1, Space deployment, gateway patch) | **Archive** — historical record; the gateway/cutover experience is still useful for the Space-side relay decision | historical |
| `Space.Dockerfile` | Unchanged (Space-side, gitignored) | deployment path unchanged for the Space; worker is a separate Vast instance |
| `sdk-inspect/` | gitignored scratch; keep read-only | SDK 0.6.80 verification reused |
| `workflows/*` + `profiles/` | reuse | native workflow + model profile export |
| `docs/archive/PRD_v1.1_colab-first.md` | archived | superseded by `PRD.md` v2.0 |

## What is genuinely new in v2.0 (no existing code)

- Vast API client (`searchOffers`, `createInstance`, `showInstance`, `start/stop/destroy`, `listInstances` (v1), endpoint discovery), cost/ledger reconciliation, offer-scoring by 3090/24GB/99%/≤$0.20
- Worker bootstrap image (docker + onstart, systemd/supervisord, ComfyUI pinned commit), instance-side Caddy proxy with per-instance Basic Auth or Vast-supported TLS endpoint
- Owned-instance reconciliation (labels + durable IDs), stop-vs-destroy semantics, watchdog
- Civitai "gap-filler" resolver (only where native LoRA Studio proves insufficient — V3)

## Actual blockers / unknowns (validated so far)

| ID | Unknown / blocker | Impact |
|---|---|---|
| U1 | Actual Vast.ai account state, balance, allowed offer pool, SSH key registration, quotas — none inspected | Cannot validate searchOffers or instantiate; V1 mock-only until owner provides a read-only probe (opt-in with capped test) |
| U2 | Native hook for pre-generation admission (WS-before-`/prompt`) — still required but under **Vast** transport | ADR-001 holds; gateway/relay pattern unchanged |
| U3 | Worker proxy TLS/auth specifics on Vast (instance-side Caddy vs provider-supported proxy) and whether direct public 443 works from the Space | ADR-003 spike; decide from real instance; until then mock |
| U4 | v1.3.0 fixed `lumiverse-spindle-types` 0.6.80; 0.6.49 pins differ on main — extension must feature-detect QuickGen additions | Already documented |
| U5 | `_VRAM_Fix.ipynb` referenced by v2.0 not in repo | Notebook stays frozen reference; extract nothing until present |
| U6 | Whether the user's Vast account supports SSH keys pre-registration (needed for VM instances) | Only relevant if template/VM route chosen; Docker route avoids this for create |
| U7 | Native ComfyUI `/object_info` auth on the worker — worker must expose it; that's a given, but confirm at worker bootstrap | Part of V2 |

## Test status snapshot (as of `feat/vast-first` cut)

| Suite | Status |
|---|---|
| Integration: mock worker → gateway (Basic Auth, deny-by-default allowlist, WS path, /system_stats, full generation lifecycle, control plane) | **9/9 pass** (`bun test`) |
| Gateway unit/integration | **0 dedicated** (gaps tracked) |
| Unit (TypeScript) | none yet |
| Live Space → Space worker (Cloudflare tunnel) HTTP 200 | Pass once (2026-11-18); not reproducible now without worker; not production-grade |
| Native Vast provider | **0** — not implemented |
| Worker bootstrap | **0** — not implemented |
| Native LoRA URL behavior | unverified |

## V0 exit criteria (this document)

- [x] Inventory, supersession, reuse map — this file
- [x] ADR-001 updated (Vast transport focus; gateway decision retained)
- [x] ADR-002 marked superseded; Colab demoted to manual/experimental
- [x] ADR-003 (Vast lifecycle + transport) — written
- [x] ADR-004 (native LoRA resolution strategy) — written
- [x] Vast API contract documented from OpenAPI + vast-cli source (paths, auth, payload shapes, quirks)
- [ ] No paid calls — held (ready for V1 mock-only work)

## V1 starting point (safe local work, no credentials)

Done on `feat/vast-first` (2026-11-18):

- `src/providers/types.ts` — `GpuProvider` contract (capabilities, searchOffers, listOwned, create/inspect/start/stop/destroy)
- `src/providers/vast/{types,client}.ts` — typed Vast REST client, bearing from env, **no network in tests** (mocked fetch fixtures from the OpenAPI shape); `searchOffers`, `createInstance` (`new_contract` semantics preserved), `showInstance`, `listInstances` (v1), `start/stop/destroy`; tests in `tests/unit/vast.test.ts`
- `src/providers/mock/mock-provider.ts` + contract tests (`tests/unit/mock-provider.test.ts`)
- `src/controller/{state-machine,leases,admission}.ts` — deterministic controller core + single-flight admission with TTL reclaim + lease tracking; tests in `tests/unit/lifecycle.test.ts`
- All 29 tests pass; extension builds.

Not done yet: single-flight `ensureReady` on native request path (needs native admission hook investigation, ADR-001), budget ledger with enforcement, watchdog for unattended mode, worker bootstrap (V2), Vast transport TLS verification from Space (V2), live offer search/create (needs owner authorization of a capped test), deployment.
"
## Live evidence (2026-11-18)

- **Native Lumiverse image generation succeeded at 512×512 / 25 steps (MOSS, user-reported and verified) and the image persisted to the gallery.**
- 768×768 and 1024×1024 attempts fail **on the HF Space side**, not inside Colab: ComfyUI returned `/history` → `/view -> 200` every time; the toast fires *after* bytes land in Lumiverse (in the base64 → `saveImageFromDataUrl` → sharp/persistence path). The `[runtime] critical memory pressure` line repeats every second and bottomed near ~2.3 GB available.
- Re-tested 2026-11-18 after a Space factory reboot: **768×768 / 25 steps MOSS generated and landed in the gallery.**
- Re-tested 2026-11-18 after disabling embeddings/memory-cortex: **1024×1024 / 25 steps generated successfully.** The embeddings pipeline (LanceDB maintenance + retrieval + vector cache in every startup path) was the dominant consumer; with it off, the Space holds a 1024×1024 inference chain. Trade-off: memory/cortex/embeddings semantics revert to keyword behavior; anything relying on vector memory (world-book retrieval, long-term recall) won't function until re-enabled.
- The image in the gallery proves the full native path end-to-end on the current stack (Space → gateway → Cloudflare quick tunnel → Caddy Basic Auth → Colab ComfyUI → native gallery).
- This localizes the earlier failures to resource/wall-clock pressure, not to auth or transport; it does not change any Vast.ai decision (the Vast worker targets a ≥24 GB GPU, where 768–1024+ is comfortable).
"
