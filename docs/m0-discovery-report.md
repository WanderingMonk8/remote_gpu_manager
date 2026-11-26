# M0 — Discovery report

**Milestone:** M0 · **Status:** Findings complete; ADRs written; live tests outstanding
**Date:** 2026-11-17
**Branch:** `m0-discovery` · Project root: `<local checkout>`

## 1. Version and artifact records

| Item | Record | Notes |
|---|---|---|
| Lumiverse upstream `main` (inspected) | `main` @ `45f8db563e1c314ed2aab227613b28eb5ea1084e` · package **1.2.5** | cloned `<local checkout>` (depth 50) |
| Lumiverse **staging** v1.3.0 (deployed build) | `staging` @ `5361e4fa` ("Merge PR #539 …exclude-html-island-images") · package **1.3.0** · pins `lumiverse-spindle-types` **0.6.80** | user reports Space on v1.3.0; staging worktree at `<local checkout>` |
| ComfyUI provider delta v1.2.5 → v1.3.0 | **None** — `comfyui.ts`, `comfy-runner.ts`, `comfyui-discovery.ts`, `comfyui-import.ts`, `comfyui-workflow-patch.ts`, `comfyui-workflow-parser.ts`, `comfyui-workflow-storage.ts` are byte-identical between main and staging | M0 findings carry over; no Basic Auth added |
| New in v1.3.0 (not present on main) | Inference scheduler (in-process admission queue, opt-in via `inferenceSchedulerConfig`; chat/embeddings/image generation leases; ComfyUI requests admitted as class `user`; loopback endpoints grouped as "local" resources); image-gen service wraps every provider call in `withInferenceLease`; `resolveImageProviderApiUrl` for default api_url; ~20 new hosted image providers (BFL, Replicate, Stability, …); `lumiverse-spindle-types` 0.6.49 → **0.6.80** | ComfyUI auth, WS ordering, LoRA patching, and connection-profile read-only semantics unchanged. Scheduler is orthogonal to gateway readiness but relevant for single-concurrent-inference sizing |
| Installed/deployed Space version | **v1.3.0** (user-reported; best match = `staging` @ `5361e4fa`; exact deployed commit unconfirmed) | behavior verified against staging, not against the running Space |
| Spindle types (host pin) | v1.2.5: 0.6.49 · **v1.3.0: 0.6.80** (= latest npm) | extension should target ^0.6.80 or feature-detect |
| Reference notebook (superseded 2026-11-17) | `wildthingsstudio101.ipynb` (2 618 834 bytes; 15 code + 14 markdown cells) = MOSS-Image Colab Studio | kept in git for reference |
| Reference notebook (current) | **`Unified_MOSS_Anima_Colab_Studio.ipynb`** (48 263 bytes; 26 cells; user-provided 2026-11-17) — one ComfyUI checkout serving MOSS + Anima families; committed default `MODEL_CHOICE='Anima Turbo v1.1'`, `INSTALL_ANIMA_ADAPTER=True` | user's new baseline; see PRD §2.2/§15 and §3′ below. MOSS family defaults 25 steps/CFG 2.5; `USE_MODEL_PRESET=True` |
| Unified notebook — new capabilities | family registry (8 model variants), family-scoped LoRA dirs (`models/loras/<family>`), managed model switch w/ `require_idle()` + `stop_owned_server()`, family-aware Civitai base matching, LoRA signature validation, Anima-only Reference Adapter (Base v1.0 target), ngrok rebuilt (default OFF, PREFERRED_DOMAIN, verified listener, auto-close on anonymous 200), `/free` idle cache release, `unified_workflow_api.json` + `<family>_workflow_api.json` exports | required for §3′ inventory; interface-wise forces a model-profile registry design in §7.5 of the PRD |
| Notebook ComfyUI revision | **Unpinned** (`git clone --depth 1 …/ComfyUI.git`, `git pull --ff-only`; "Use recent ComfyUI (0.42+)") | pin after local verification |
| MOSS model files | `moss_image_sft_int8_convrot.safetensors` (default) / `moss_image_base_int8_convrot.safetensors`; encoder `qwen3.5_9b_w4a8_gptq.safetensors`; VAE `flux2-vae_small.safetensors`; repo `Comfy-Org/MOSS-Image` | matches PRD §2.2 |
| Notebook generation defaults (as committed) | WIDTH=**1024**, HEIGHT=**1024**, STEPS=**30** (PRD says 768×768 / 25 — user edited the notebook; PRD table is stale) · CFG 2.5 · `er_sde`/`simple` · SEED −1 · CLIP_DEVICE `default` · LORA_LOADER `LoraLoaderModelOnly` | flag: PRD §2.2 should be updated |
| `ENABLE_NGROK` in committed notebook | **`True`** (cell 25), contradicting the cell's own guidance ("Leave OFF on restricted Colab Free runtimes") and §2.2's "Disabled by default" | flagged for user review |
| Google Colab API | REST `v1beta` runtimes create/get/list/delete; `runtimespecs.list` (with `eligible`); `getSubscription`; MCP endpoint `colaboratory.googleapis.com/mcp` (create_runtime/create_session/execute_code/list_runtime_specs/list_runtimes/delete_runtime) | see `adr-002-provider-feasibility.md` |

## 2. Native Lumiverse image-generation path — verified facts

(Lumiverse `src/image-gen/*`, `src/services/image-gen.service.ts`, `src/services/character-lora.service.ts`)

1. **Auth:** The ComfyUI provider sends **no credentials** — `_apiKey` unused, `apiKeyRequired: false`. Validation = `GET /system_stats` (no headers). Only the **SwarmUI** path sends a `Cookie` (`swarm_token`) to `/ComfyBackendDirect`. There is no `Authorization: Basic|Bearer` support; WS open likewise carries headers only in the SwarmUI case. → **Native ComfyUI + ngrok Basic Auth = always 401/403.**
2. **Ordering:** `/ws?clientId=<uuid>` opens **before** `POST /prompt` (`client_id` included). Progress via WS (`progress`, `executing`, `execution_error`; binary preview frames are 8-byte-prefixed). Then `GET /history/{prompt_id}` → find image descriptors → `GET /view?filename=…`. Cancel = `POST /queue {delete:[id]}` + `POST /interrupt` if running.
3. **Workflow patching** (`patchWorkflow`): writes values into **pre-existing mapped nodes only; never inserts nodes**. Ordered LoRA stack entries map positionally onto mapped LoRA nodes (`buildLoraEntryMap`). Node classes with auto-detection hints: `CLIPTextEncode` (+1:1 heuristic: 2nd encode = negative), `KSampler`, `CheckpointLoaderSimple`, `UNETLoader`, `LoraLoader`. **No hints for `LoraLoaderModelOnly`/`LoraLoaderBypassModelOnly`, `CLIPLoader`, `VAELoader`, `EmptyFlux2LatentImage`** → manual field mappings required for the MOSS graph (seed/steps/CFG/sampler/scheduler OK; width/height/checkpoint/unet/LoRA need manual mapping; positive/negative OK).
4. **LoRA weight semantics:** `strength_clip` exists only on `LoraLoader`; `LoraLoaderModelOnly` has `strength_model` only → mapping a `lora_strength_clip` field onto a ModelOnly node would inject an unknown input ComfyUI rejects. MOSS LoRA sets must map `lora_name` + `lora_strength_model` only.
5. **Object info at generation time:** `getComfyUIObjectInfo` (5-minute cache) is fetched during the native generation patch path; failure returns `null`, no throw. Capability discovery (`discoverCapabilities`) fires parallel node queries — honoring "no GPU allocation for discovery" semantics on the worker side is the worker's responsibility; no native code polls health in the background.
6. **LoRA Studio storage:** lora presets live in image-gen settings (`loraPresets`, `activeLoraPresetId`, `loraStrengthScale`, bypass flags) — a native, per-user feature the extension must reuse via `ImageGenNativeRequestDTO.extraLoras`/`bypassActiveLoraPreset` semantics, or via the native panel; **no second LoRA UI** (PRD non-goal).
7. **Spindle write surfaces:** no connection-profile create/update/field-mapping mutation; no pre-image-generation hook; `generateNative()` runs the whole native pipeline (scene analysis, LoRA stack, workflow patch) and is the only native-route generator; `getPromptPresets?()` / `cancelNative?()` exist with QuickGen hosts.
8. **Permissions available to the extension:** free tier (events, storage, version, variables, …); gated: `image_gen`, `images`, `cors_proxy`, `oauth`, `ui_panels`, `ephemeral_storage`, `generation_parameters`, etc. Hard-blocked (no opt-in): `fs`, `child_process`, raw `http(s)`/`net`/`tls`, `Bun.serve`, `Bun.spawn`, `process.env` reads, sqlite. Install-time capabilities: `dynamic_code_execution`, `base64_decode` only.
9. **Enclave:** AES-256-GCM at-rest, per-user (`enclave.put/get/delete/has/list`) — correct place for ngrok/Civitai/Colab secret refs; profiles export opaque refs only.
10. **Storage:** `spindle.storage` (per-extension) / `spindle.userStorage` (per-user) for durable JSON state; no raw host DB access from extensions.
11. **No inbound listener:** see ADR-001 §3 — gateway is required on the request path for cold-start.

**Reference-artifact switch (2026-11-17):** the user replaced the MOSS-only notebook with `Unified_MOSS_Anima_Colab_Studio.ipynb` (full inspection: see PRD §2.2). The M0 findings that matter for integration **carry over unchanged in substance** — the workflow builder still emits `1 UNETLoader, 2 CLIPLoader, 3 VAELoader, 4/5 CLIPTextEncode, 6 latent, 7 KSampler, 8 VAEDecode, 9 SaveImage` with LoRAs ≥ 100 (`LoraLoaderModelOnly`), and the MOSS graph is byte-equivalent to the old notebook's for MOSS selections (same repositories/files). Anima adds: different encoder/VAE/clip_type/latent (`qwen_3_06b_base.safetensors`, `qwen_image_vae.safetensors`, `stable_diffusion`, `EmptyLatentImage`), Anima-only `AnimaRefAdapter` node (custom external node pack `ArcAnima/ComfyUI-Anima-Ref-Adapter`), Turbo defaults 10 steps/CFG 1.0.

## 3. Notebook settings inventory → apply-mode classification

Source (MOSS baseline): `wildthingsstudio101.ipynb` (code cell numbers shown). For the unified notebook (`Unified_MOSS_Anima_Colab_Studio.ipynb`) the same table applies plus these deltas:

| Setting (unified cell) | Control | Apply class |
|---|---|---|
| `MODEL_CHOICE` 8 variants (6) | Model profile selector (family-aware; fetch/verify before activate) | **Reprovision / idle apply** |
| `UPDATE_COMFYUI` bool (4) | Confirmed update action | Worker restart / bootstrap |
| `INSTALL_ANIMA_ADAPTER` bool (4) | Custom-node install action (approved revision only) | Bootstrap / worker restart |
| `DOWNLOAD_ADAPTER_WEIGHTS` bool (6) | Asset install (Anima-only) | Asset operation |
| `VRAM_MODE` lowvram/normalvram (8) | Memory mode selector | Worker restart |
| `USE_MODEL_PRESET` bool (18) | Preset vs. manual override toggle | Next job |
| `USE_REFERENCE_ADAPTER` + `ALLOW_EXPERIMENTAL_ADAPTER` (18) | Anima-only adapter gate | Next job / idle apply |
| `REF_GUIDANCE`, `ADAPTER_STRENGTH`, `REF_END`, `REF_MEGAPIXELS` (18) | Adapter tuning fields | Next job |
| `PREFERRED_DOMAIN` (23) | Tunnel approved domain | Idle reconnect / bootstrap |
| LoRA dirs `models/loras/<family>`; LORA rows carry family prefix (16) | Native LoRA Studio names are family-prefixed in the API graph | Asset / next job |
| `/free` unload (25, diagnostics) | Idle-only cache release action | Explicit action |
| `UPLOAD_REFERENCE` + `REFERENCE_LOCAL_PATH` (12) | Authenticated single-image reference upload (Anima only) | Asset operation |

The rest of the MOSS inventory below remains valid; treat MOSS rows as the MOSS-family subset of the unified profile registry.

All `@param` widgets and hardcoded bootstrap choices are covered; native prompt fields are noted for completeness (native UI remains authoritative).

| # | Notebook setting (cell) | Lumiverse control (proposed) | Apply class |
|---|---|---|---|
| 1 | GPU/runtime check (2; no widget) | Runtime-spec selector + capacity display; capability-gated | **Reprovision** |
| 2 | `USE_DRIVE` bool (4) | Persistence toggle + approved-storage preset/root (Drive mount stays interactive-only) | **Bootstrap / restart or reprovision** |
| 3 | `CACHE = /content/moss_cache` (4, hardcoded) | Storage root preset; Drive path only when interactively mounted | Bootstrap |
| 4 | ComfyUI checkout: `git clone --depth 1`, `git pull --ff-only` (6) | Pinned approved revision picker + confirmed update action | **Worker restart / bootstrap** |
| 5 | pip installs: `-r requirements.txt`, `huggingface_hub`, `requests`, `pillow`, `ipywidgets`, `safetensors` (6) | Pinned dependency profile (no arbitrary installs); restart on change | Worker restart |
| 6 | `MODEL_CHOICE` = `SFT INT8`/`Base INT8` (8) | Model profile selector; fetch/verify before activation | **Stage + idle apply** |
| 7 | `ENCODER` `qwen3.5_9b_w4a8_gptq.safetensors` (8, hidden) | Encoder selector (registered, pinned, hash-verified) | **Stage + idle apply** |
| 8 | `VAE` `flux2-vae_small.safetensors` (8, hidden) | VAE selector (registered, pinned) | **Stage + idle apply** |
| 9 | Weight source `Comfy-Org/MOSS-Image` (8, hardcoded repo/path) | Approved repository registry (no arbitrary URLs) | Bootstrap |
| 10 | `acquire_weight()` cache/hardlink logic (8) | Shared cache restore (idempotent; hardlink→copy fallback) | Bootstrap |
| 11 | LoRA cache restore glob (10) | Restore policy: required/pinned/none | **Bootstrap / idle apply** |
| 12 | ComfyUI launch `--listen 127.0.0.1 --port 8188 --lowvram` (12) | Memory mode (low/normal VRAM), loopback bind, fixed port | **Worker restart** |
| 13 | `LOG=/content/comfyui.log` (12, hardcoded) | Log path within approved root; redacted viewing in diagnostics | Config / explicit action |
| 14 | `BASE_URL` local (12/14, hardcoded) | Read-only managed endpoint (gateway-owned) | Config / next job |
| 15 | `/object_info` verify list incl. `LoraLoaderModelOnly` (14) | Readiness fingerprint (nodes + MOSS encoder + names); config via schema | Config / next job |
| 16 | Workflow export `/content/moss_workflow_api.json` (22) | Signed workflow template artifact; native import path unchanged | Explicit action |
| 17 | `DOWNLOAD_WORKFLOW` bool — **user fix** (23) | UI toggle in settings (no forced download) | Explicit action |
| 18 | `UPLOAD_LOCAL_LORA` bool (16) | Authenticated manual `.safetensors` upload on supported worker | **Asset operation** |
| 19 | Civitai token `Password` widget (18) | Write-only secret → enclave ref; sent only to Civitai hosts | **Asset operation** |
| 20 | LoRA rows: source / strength −5..5 / enabled (18; 2 rows by default) | **Native LoRA Studio is authoritative** (presets/character bindings); worker installs assets + manifest | Asset / next job |
| 21 | Civitai resolve rules (MOSS base match, `.safetensors`, SHA-256, `civitai_<ver>_<file>_<name>`) (18) | Reused verbatim in worker installer (M3) | Asset operation |
| 22 | `POSITIVE_PROMPT` / `NEGATIVE_PROMPT` (20) | Native prompt fields / scene parser; standalone defaults only | **Next job** |
| 23 | `WIDTH`/`HEIGHT` (1024), `STEPS` (30), `CFG` (2.5), `SEED` (−1), `SAMPLER` (`er_sde`), `SCHEDULER` (`simple`) (20) | Native generation controls / workflow mappings (profile = defaults only) | **Next job** |
| 24 | `CLIP_DEVICE` `default`/`cpu` (20) | Advanced compatibility field, validated vs `/object_info` | Next job / idle apply |
| 25 | `LORA_LOADER` `LoraLoaderModelOnly` / `LoraLoaderBypassModelOnly` (20) | Advanced field; exactly-once loader; validated | Next job / idle apply |
| 26 | `ENABLE_NGROK` bool — **currently `True`** (25) | Tunnel mode off/on, approved domain or dynamic endpoint | **Idle reconnect / bootstrap** |
| 27 | ngrok authtoken + Basic Auth creds via `getpass` (25) | Enclave refs (`ngrok_auth_token`, `tunnel_basic_auth`); rotate action | Asset/secret op (bootstrap applies) |
| 28 | Tunnel health check + URL print (25) | Authenticated gateway probe; epoch registration | Bootstrap / reconnect |
| 29 | Diagnostics: `comfy_ready()`, model/LoRA inventory, last log lines, RAM/VRAM/`nvidia-smi` (27–28) | Dashboard + bounded redacted logs | Explicit action |
| 30 | Shutdown: optional `comfy_proc.terminate()`; ngrok `close()` | **Stop worker vs. release runtime**, distinct actions | Explicit action |
| 31 | (Not in notebook) Lifecycle: autoStart, idleMinutes, maxRuntime, jobTimeout, poll interval | Manager settings (extension+gateway) | **Hot apply (controller)** / reprovision if provider requires |

## 4. Technical blockers and unsupported capabilities

| ID | Blocker / unsupported capability | Impact | Route |
|---|---|---|---|
| B1 | Native provider cannot send upstream auth (Basic/Bearer) to ComfyUI | M1 native path returns 401/403 against any authenticated worker | Gateway (ADR-001) |
| B2 | No pre-generation hook anywhere in the native path; WS opens before `/prompt` | Cold-start cannot be added inside the extension | Gateway owns `ensureReady` on the request path |
| B3 | Native LoRA auto-detection is `LoraLoader`-only; native patcher never inserts nodes | MOSS model-only LoRAs need manual mappings into embedded optional nodes (or a host patch) | M1/M3 test; host patch only with explicit approval |
| B4 | `EmptyFlux2LatentImage` & `CLIPLoader`/`VAELoader`/`UNETLoader` not auto-detected | MOSS template import needs manual field mappings | Document in setup guide; test in M1 |
| B5 | Spindle: no inbound listeners, no connection-profile mutation, no image-gen interceptor | "Pure extension" solution impossible | Gateway / fork route (ADR-001) |
| B6 | Google Colab managed runtimes: **all-tiers** prohibition of remote proxies & web-service offerings; Free additionally prohibits web-UI-primary interaction and is idle/12h-lifetime limited | Unattended Colab (Free or paid consumer) = policy-blocked | Manual mode only; P1 needs user-approved host (ADR-002) |
| B7 | End-to-end authenticated connectivity **from the Lumiverse Space** unverified (prior test ran Colab→Colab) | M1 exit criterion not yet met | M1 test against real Space (needs Space URL + approval) |
| B8 | Installed Space Lumiverse version ≠ confirmed; upstream main is v1.2.5 and behavior (e.g. auth) may differ | Findings may not match the deployed build | Ask user for Space version or read it from the Space |
| B9 | Space persistent-volume path (`/app/data`?) and sleep behavior unknown | Durable state design (M2) and provider watchdog assumptions | Ask user / verify on the Space |
| B10 | ComfyUI unpinned in notebook (`master`) | Reproducibility (R-04) | Pin tested commit (M1/M2) |
| B11 | Remote config delivery to a Free managed runtime has no permitted channel (no remote code channel; Drive mount is interactive-only) | R-13/R-15 "configure the running worker remotely" unverifiable on Colab Free | Only on authorized hosts (M4/M5); Free = offline staging + manual apply |
| B12 | `sessions` on Colab API are Jupyter kernels, not ComfyUI; no first-party "run ComfyUI" action | bootstrap must be delivered by the worker itself (notebook/CLI), not via MCP `execute_code` bypassing policy | Worker-side bootstrap; MCP only under authorized host |
| B13 | Deploying gateway on the HF Space requires Space container/entrypoint change | Needs explicit user approval; otherwise local-only dev | Ask user; fallback = local-only for M1 dev |
| B14 | PRD's own defaults table stale (768²/25 steps vs committed 1024²/30) | Docs accuracy | PRD updated alongside this report |

## 5. M0 gate checklist vs. PRD §10

| M0 deliverable | State |
|---|---|
| Record installed Lumiverse version/commit and notebook versions | **Partial** — upstream main v1.2.5 @ 45f8db56 recorded; Space install unknown (B8) |
| Inspect provider auth HTTP/WS, LoRA insertion, request ordering | **Done** (§2, ADR-001) |
| Verify Colab eligibility and permitted operations separately | **Done** — policy + API review (ADR-002) and the read-only live probe ran 2026-11-17 (`tools/colab-eligibility-check.py`): tier `SUBSCRIPTION_TIER_FREE`; eligible: CPU/STANDARD, GPU **T4**/STANDARD, TPU V5E1/STANDARD; rest ineligible. No runtime created. |
| Inventory notebook settings and classify apply modes | **Done** (§3) |
| Verify remote config delivery before bootstrap and while running | **Not verified** — requires an authorized running worker; M2/M4 work; documented, not claimed |
| Produce ADRs for gateway and provider feasibility | **Done** — `docs/adr-001-native-integration.md`, `docs/adr-002-provider-feasibility.md` |
| No production changes | **Held** — no changes to the Space or upstream Lumiverse |

**M0 verdict:** Source-level M0 is complete, and the Colab eligibility probe has been run (tier FREE; T4 STANDARD eligible). Remaining deployment-dependent gates: (1) live authenticated connectivity from the actual Space to a warm worker, (2) Space gateway-deployment approval. Neither blocked M1 work against mocks and permitted warm hosts, per the PRD's own rule ("M0 must not block M1–M4 against mocks or permitted warm hosts").

## 6. Immediate next actions (after user sign-off)

1. User confirms: deployed Space version + persistent path; **Colab eligibility probe complete (2026-11-17)** — no further action; manual-only decision recorded; gateway sidecar approval for the Space (or fork-route variant) still pending.
2. M1 (warm connectivity): stand up mock ComfyUI + loopback gateway; authenticated `/system_stats` → `/object_info` → WS → `/prompt` → `/history` → `/view` path; native workflow import of a MOSS API template with manual field mappings; live Space test if approved.
3. Keep PRD §2.2/§2.3/§6.1/§12 in sync with this report (done in `PRD` working copy).
