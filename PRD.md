# Product Requirements Document
## Lumiverse Remote GPU Manager — Vast.ai First

**Version:** 2.0 | **Date:** 2026-11-18 | **Status:** Approved design direction; implementation and live validation pending  
**Supersedes:** PRD v1.1 (Colab-first). Retain that file as historical context.  
**Target:** Lumiverse Spindle extension + smallest necessary trusted host bridge + Vast.ai ComfyUI worker  
**Deployment:** Local development; existing Lumiverse Hugging Face Space remains the production host.

## 1. Executive summary

Make remotely hosted GPU inference feel like a native Lumiverse feature. A user selects a model and LoRA preset in Lumiverse and requests an image as usual. The manager automatically starts or resumes an authorized Vast.ai instance, prepares the selected model and required LoRA files, connects through an authenticated endpoint, then lets the existing Lumiverse image pipeline run. It keeps compute available during actual work and stops it after an adjustable idle period. Native image persistence, scene parsing, character tags, prompt presets, workflow controls, and LoRA weights remain authoritative.

The extension is an **infrastructure manager, not an image generation frontend**. Vast.ai is the primary automated backend. Google Colab remains a standalone/manual experimental option: no requirement to complete Google OAuth, managed-runtime lifecycle research or Ngrok integration before shipping Vast.ai. No paid rental, API-key transfer to an agent conversation, billing change or deployment is authorized merely by this PRD.

### 1.1 Success scenario

1. Configure a dedicated native ComfyUI connection once, enter a Vast.ai API key securely, choose compute limits and select a model profile.
2. Configure a native LoRA Studio preset, including existing filenames or Civitai references. Choose individual weights and character tags there.
3. Press the normal Lumiverse image generation action. No separate generator, notebook or Vast.ai console is required for routine supported use.
4. Manager admits the job, resumes or rents one appropriate machine, verifies worker identity and stages missing assets. Native generation proceeds exactly once, with native progress, cancellation and gallery persistence.
5. A second request reuses the warm worker. After five minutes of true inactivity (configurable), the manager stops the instance, confirms its state through Vast.ai and shows residual storage cost. A later request resumes it if hardware is available.

## 2. Baseline, scope and evidence

### 2.1 Retain existing artifacts

- `Lumiverse_Remote_GPU_Manager_PRD_v1.1.md`: provider abstraction, job leases, failure reconciliation, revisioned remote configuration, security contracts and earlier regression cases. Reuse these concepts, not Colab-specific assumptions.
- `Unified_MOSS_Anima_Colab_Studio_VRAM_Fix.ipynb`: current reference for model manifest, dependency installation, loader graphs, Civitai compatibility/download behavior and sampling defaults. Extract into tested non-notebook worker modules; keep interactive notebook intact.
- Prior user-reported results: MOSS base generation and Civitai LoRAs work in Colab; Ngrok API smoke test worked from Colab itself. These do not constitute a tested Vast.ai setup or end-to-end native generation from the Space.
- Native LoRA Studio screenshot: active preset, filename containing a `https://civitai.red/api/download/models/...` URL, model/CLIP weights, ordering and base tags. This demonstrates entry of direct download URLs, not a verified remote installation or successful render. Determine actual behavior from source and a live cold-cache test before implementing a redundant downloader.
- Actual coding-agent branch, deployed Lumiverse commit and Vast.ai account capabilities have not been inspected in this PRD. The agent must inventory them first.

### 2.2 P0 scope (initial production release)

- Vast.ai on-demand, one managed GPU instance at a time; offer selection, explicit start/stop/restart, automatic startup on native image request, warm reuse, idle stop, ownership-aware recovery and a hard safety deadline with independent cleanup where feasible.
- Authenticated ComfyUI connectivity with no mandatory Ngrok; stable native connection, per-instance endpoint discovery, secure HTTP and WebSocket or a verified native polling path.
- All eight existing MOSS/Anima profile choices; shared components, on-demand downloads, compatible workflow presets and controlled model switching.
- Native LoRA Studio integration; remote file availability, automatic Civitai URL resolution only where missing, model-only loaders, cache, compatibility and asset manifest.
- Remote worker settings and health dashboard, desired/effective configuration, secure credentials, spending limits, diagnostics, integration tests and deployment/runbook.

### 2.3 Deferred / non-goals

RunPod, Vast serverless/autoscaling, multi-GPU, multi-tenant scheduling, full-precision MOSS alternatives, training, generalized model hub, automatic migration of large caches between hosts, and reference-adapter support beyond proven Anima profiles are later enhancements. Retain optional Anima Base v1.0 adapter capability as a compatibility spike, not a blocker to standard image generation. No duplicated Prompt Studio, LoRA Studio, gallery or native workflow editor; no fork of the whole host; no browser automation or fake-activity workaround for Colab. No automatic destruction of existing personal resources or unauthorized cost escalation.

## 3. Proposed product interface

One Spindle drawer/panel or native-style settings surface. Do not place creative controls here.

| Area | Controls and behavior |
|---|---|
| Overview | Off/Starting/Bootstrapping/Connecting/Ready/Busy/Idle/Stopping/Stopped/Error/Unknown; GPU, VRAM, RAM, disk, queue, current workload, estimated cost, idle countdown; start, drain/stop, restart, diagnostics |
| Vast.ai | Masked API key, test credentials read-only, dedicated managed-instance identity, provider health, quote preview and authorization; choose GPU preferences, price cap, minimum RAM/VRAM, disk, reliability, network bounds |
| Lifecycle | Auto-start opt-in, idle stop (5 min default), maximum session deadline, daily/monthly allowance, replacement policy, stop vs destroy distinction; independent watchdog status |
| Models | Eight model profiles; download/refresh when authorized; mark installed/missing/active; planned switch, validated effective profile, memory settings, pinned ComfyUI revision and compatible native workflow |
| Assets | Native LoRA Studio remains the editor. Show read-only installation/cache state, errors, optional prefetch, retry, manual import, and explicit cleanup; no duplicate weight/order/tag fields |
| Security | Secret reference status, optional Civitai/HF credentials, worker identity; never show secrets in diagnostics or exports |
| Storage / billing | Running and stopped storage rates, estimated bandwidth and compute, disk used, cleanup/export controls, instance expiry and last confirmed provider status |

Read-only health, catalog browsing, opening settings, saving an offline profile, and viewing historical images must never start paid compute. Explicit prefetch/start may allocate only with the same pricing authorization as a generation job. Offline native catalog uses a labeled cached manifest where supported; it must not pretend a missing file is installed.

## 4. Architecture and integration contracts

```text
Browser / Lumiverse native UI (normal image request; native LoRA Studio)
    |
Lumiverse host on HF Space
    |-- Spindle extension: preferences, dashboard, controller, assets metadata
    |-- Native provider integration: preflight/admission + stable authenticated route
    |       (only a minimal host bridge if supported Spindle APIs are insufficient)
    |-- Durable state / secrets / native gallery
    |
    |-- Vast.ai official API (offers, rent, inspect, start, stop, destroy)
    |-- Encrypted/authenticated worker transport (HTTP + WS)
            |
      Vast.ai instance, pinned image / startup contract
         trusted gateway or outbound connector
             |-- worker supervisor / typed settings & asset service
             |-- loopback ComfyUI :8188
             |-- persistent model and LoRA files + manifest
             |-- scoped instance watchdog (where validated)
```

### 4.1 Native integration: mandatory discovery

Inspect the exact host checkout, installed `lumiverse-spindle-types` version and extension permissions. Trace native chat-scene/QuickGen/manual generation from UI through graph assembly, LoRA preset/character expansion, connection resolution, object discovery, WS handshake, prompt submission, cancellation, history/view and native persistence. Verify paths and call order with a mock upstream and redacted logs. Current public docs describe `spindle.imageGen.generate`, `generateStream` and optional `generateNative` host additions; these APIs let extensions initiate jobs, but do not by themselves prove a global hook into host-originated generation. Do not replace the normal button with a second generator and claim P0 is done.

Select the narrowest supported design:

A. Supported host preflight plus extension RPC and existing authenticated proxy, if actual host exposes all required functionality.
B. Dedicated stable gateway and minimal host adapter around native ComfyUI request admission and final workflow submission. Use the native job context to distinguish real work from catalog polling. If native opens WS/does discovery before POST /prompt, preflight must occur before that step. If early graph validation rejects URL literals, add a narrowly scoped resolver before filename validation while preserving native preset values.
C. Extension-initiated native generation as a temporary development harness only. If A/B cannot work, report P0 blocked and request approval for a bounded upstream patch; do not silently ship an alternative generation UI as a replacement.

Record the decision in ADR-001 with exact source locations, traces, supported versions and rollback. Leave unrelated native connections untouched; bind one dedicated managed profile. Native requests and final LoRA/field values are authoritative and must not be copied into permanent extension state.

### 4.2 Provider interface (proposed, not existing SDK)

```ts
interface GpuProvider {
  capabilities(): Promise<Capabilities>;
  searchOffers(policy: OfferPolicy): Promise<Quote[]>;
  listOwned(): Promise<InstanceRef[]>;
  create(quote: Quote, intentId: string): Promise<InstanceRef>;
  inspect(ref: InstanceRef): Promise<InstanceState>;
  start(ref: InstanceRef): Promise<void>;
  stop(ref: InstanceRef): Promise<void>;
  destroy(ref: InstanceRef): Promise<void>;
  discoverEndpoint(ref: InstanceRef): Promise<Endpoint>;
}
```

Separate provider lifecycle from worker readiness and native gateway. The Vast client calls the official API with server-side Bearer authentication. Pin and validate request/response schemas against the current API reference/OpenAPI and actual read-only responses. Do not guess endpoint payloads; provider state strings are mapped explicitly into internal states. `start`/`stop` are not `create`/`destroy`. A provider-reported running container is not a Ready ComfyUI worker. Labels are useful for reconciliation but not sufficient proof of ownership; keep durable instance IDs and creation intents. Mock provider implements the same contract; manual Colab adapter has no unattended lifecycle operations.

### 4.3 Secure transport; no Ngrok dependency

Preferred: use a Vast-supported secured endpoint/proxy, or a pinned instance-side Caddy/other reverse proxy with TLS and project-owned per-instance credentials. Verify actual template capabilities for machine type, public ports, valid hostname/certificate and WebSocket support from the real HF Space. Never assume a public mapped port is HTTPS or that browser portal authentication works for machine-to-machine calls. ComfyUI stays bound to loopback; expose only the authenticated gateway. A stable trusted host route relays to current worker endpoint/epoch; dynamic public IPs/ports need no user edits.

Fallback if direct TLS/auth/WS is not reliable: an authenticated outbound connector/reverse tunnel to an explicitly configured broker under owner control, or a permitted authenticated tunnel; require deployment approval for external costs/services. SSH transport is acceptable for bootstrap/debugging, not automatically a stable public generation proxy. No public unauthenticated ComfyUI or certificate-verification disablement. No requirement for Ngrok authtoken/user/password on Vast; legacy notebook may retain them separately.

Proxy only verified native routes (baseline `/system_stats`, `/object_info`, `/prompt`, `/queue`, `/history/{id}`, `/view`, `/ws`; actual upload/cancel/catalog endpoints as used). Preserve query, HTTP status, binary images, WS client ID, abort signals, size limits and content type. Health is JSON plus expected instance identity, epoch, node/model capability and config revision. Restrict allowed origins/targets, redirects and control routes. If host gateway cannot support WS, prove native polling semantics before selecting that path. Do not log prompts or base64 images.

## 5. Vast.ai lifecycle and cost control

### 5.1 Offer selection and authorization

Defaults are proposals, not a fixed quote: one on-demand RTX 3090 preferred, 24 GiB minimum VRAM, at least 32 GB reported usable host/container RAM, 80–100 GB disk (100 GB suggested), reliability >=99% where matching offers exist, compatible CUDA/driver, verified network access and enough rental duration for job completion. Allow approved RTX 4090/5090/A5000 or equivalent with appropriate memory/driver if within constraints. Verify actual cgroup RAM, disk and driver on startup; do not treat marketplace metadata as proof. Prefer stable machine availability, cached image and fast download when rates are similar. No unapproved fallback to lower memory, more expensive GPU or interruptible bid. No paid rental until user approves explicit policy (hourly cap, aggregate limits, allowed hardware, storage, replacement behavior). Default example $0.20/hour maximum running estimate is an editable proposal, not approved spending or a live offer.

Quote actual offer compute plus running/stopped storage and bandwidth rates/units, remaining contract duration, and potential cold-start cost. Recheck before create/resume; if quote is stale or changed beyond approved limits, refuse with clear options. Use `on-demand` for initial release, not reserved or interruptible. Handle out-of-stock, expired offers, credit exhaustion, auth failure and rate limits. Never auto-refill account balance.

### 5.2 State machine and concurrency

```text
OFFLINE (no instance) -> PROVISIONING -> BOOTSTRAPPING -> CONNECTING -> READY
STOPPED (retained instance) -> STARTING -> BOOTSTRAPPING -> CONNECTING -> READY
READY -> BUSY -> IDLE -> STOPPING -> STOPPED
IDLE + admitted work -> BUSY
STOPPED -> DESTROYING -> OFFLINE (explicitly authorized destruction)
Any uncertain action -> UNKNOWN -> RECONCILE -> confirmed state or ERROR
```

One durable lock/single-flight startup per designated user/instance pool. Coalesce simultaneous requests and queue generation initially (batch one). Record allocation intent before API call, persist provider instance ID immediately after receipt, use stable labels and scope; on ambiguous create reconcile first, never blindly retry. If uncertain ownership, freeze mutations and alert. A new job during idle-stop cancels it under lock, or waits for confirmed stop then resumes. Do not let old epoch register endpoints, release leases or return results as current. Bound startup, download and job waits separately; show progress/cancel and correlated error IDs. Cancellation during startup only stops resources owned by controller and only if no other admitted job needs them.

Real work leases cover native admission, bootstrap for that job, missing-asset download, queued/running generation, output retrieval and native persistence. Native queue and history reconcile alongside durable job/prompt IDs. Health polling, WS ping, catalog browsing and merely open UI do not reset idle. If job lasts longer than idle timer, do not interrupt it; hard authorized cost/session limits have separate drain/cancel policy and clear warnings. A timeout after POST /prompt is ambiguous: reconcile queue/history/client ID; never blindly submit a duplicate image. Release lease only after final persistence/cancel/failure adjudicated. Persist `lastRealActivity`, `idleDeadline`, session start and absolute expiry; use wall-clock timestamps across process restarts and monotonic in-process timers.

### 5.3 Stop, restart, destroy and recovery

- Idle policy defaults to STOP, preserving instance disk as supported. Vast confirms stopped state before UI reports GPU compute paused; storage keeps accruing. Resume the same instance first, subject to capacity and contract expiry. Restart worker service for memory/profile changes when appropriate; restart GPU instance only when necessary and allowed.
- Destroy is separate destructive action: show data-loss and storage/billing consequences, preserve verified manifest/backup and fetch outputs first, require explicit approval for manual destroy or a separately opted-in retention rule. Verify instance and attached storage state; do not assume volume deletion or billing cessation for everything.
- If a stopped host is unavailable, expose blocked state and replacement quote; only automatic replacement within prior explicit policy, no duplicate running instance and no deleting an old cache unless authorized. Restore assets from source manifests or explicitly approved backup. Track stopped storage even if a replacement is rented; do not accumulate abandoned instances silently.
- Reconcile on startup, shutdown, reconnect and periodically while resources are owned. HF Space sleep and agent/extension crash can suspend the host timer. Implement an independently verified worker/provider-side hard deadline/watchdog, using only the scoped instance credential or provider facility if supported. It must stop only its own instance, distinguish active workload from polling, receive bounded leases/expiry and never require the master Vast key on a GPU host. Verify scope and behavior experimentally; if no independently reliable safety mechanism exists, disable unattended production auto-start or require explicit operation with warning. A watchdog cannot guarantee operation during provider/network outage; expose last confirmed state, runbook and residual billing uncertainty.

### 5.4 Spend ledger and limits

Maintain estimated compute + storage + network ledger by instance/epoch, reconcile with provider billing data when available. Track accrued plus projected costs for all owned instances, including stopped storage. Max running hourly, daily/monthly spend and session duration; deny new work when authorization exhausted, notify and apply approved safe-stop policy. Caps are controller safeguards, not guaranteed provider hard billing limits; provider charges can lag and disk/network costs vary. Document minimum balance, storage retention and renewal/expiry behaviors from real account. No API key in logs; test read-only account/offer endpoints before any paid test.

## 6. Worker bootstrap and remote model configuration

Use a pinned, reproducible Docker image or tested Vast ComfyUI template plus deterministic install script. Agent must verify actual acceptable CUDA/PyTorch, node revisions and package compatibility. Prefer immutable dependencies (commit/digest) with small onstart command, process supervisor and typed worker API. Avoid running arbitrary notebook cells or remote shell from extension UI. Start ComfyUI locally on `127.0.0.1:8188`. Readiness includes asset validation, `/object_info`, required loaders, identity/epoch, active profile and effective revision. Stream log progress without secrets. Recover idempotently after interrupted bootstrap, download or restart; do not clone/reinstall everything on every start.

### 6.1 Model registry (from corrected unified notebook)

| Profile | Diffusion weight | Steps / CFG |
|---|---|---|
| Anima Turbo v1.1 | `anima-turbo-v1.1.safetensors` | 10 / 1.0 |
| Anima Aesthetic v1.1 | `anima-aesthetic-v1.1.safetensors` | 30 / 4.5 |
| Anima Base v1.0 | `anima-base-v1.0.safetensors` | 30 / 4.5 |
| Anima Turbo v1.0 | `anima-turbo-v1.0.safetensors` | 10 / 1.0 |
| Anima Aesthetic v1.0 | `anima-aesthetic-v1.0.safetensors` | 30 / 4.5 |
| Anima Aesthetic v1.0b | `anima-aesthetic-v1.0b.safetensors` | 30 / 4.5 |
| MOSS SFT INT8 | `moss_image_sft_int8_convrot.safetensors` | 25 / 2.5 |
| MOSS Base INT8 | `moss_image_base_int8_convrot.safetensors` | 25 / 2.5 |

Anima source `circlestone-labs/Anima`, `split_files/` prefix, shared `qwen_3_06b_base.safetensors`, `qwen_image_vae.safetensors`, CLIP type `stable_diffusion`, `EmptyLatentImage`. MOSS source `Comfy-Org/MOSS-Image`, shared `qwen3.5_9b_w4a8_gptq.safetensors`, `flux2-vae_small.safetensors`, CLIP type `moss_image`, `EmptyFlux2LatentImage`. Source repo paths and weights are copied from notebook, not a fresh live download test; pin actual revisions and verify licensing, node compatibility, family metadata and checksums before use. Defaults `er_sde` / `simple`, 768x768, batch 1, randomized seed if -1. Preserve native per-job overrides. Proposed initial profile Anima Turbo v1.1 (matches unified notebook); MOSS SFT as other family's smoke-test profile. No silent precision downgrade or resolution/LoRA changes to fit memory. 1024-class resolutions are an optional tested hardware capability, not guarantee.

Model-only LoRA loader `LoraLoaderModelOnly` (bypass variant only if supported). Reference Adapter only when optional compatible Anima Base v1.0 workflow and dependencies are validated; never apply to MOSS; other variants experimental and explicit. Registry extensible; core controller must not hardcode architecture. Download selected components on demand, reuse shared files, retain cached inactive weights on disk subject to quota, one selected profile active at a time. Drain and switch at job boundaries; if native workflow requests another profile, reconcile with explicit setting, never silently substitute.

### 6.2 Memory and resource policy

Vast hardware can exceed Colab limitations; don't assume it has unlimited RAM. Default to ComfyUI automatic VRAM mode (no `--normalvram` flag; corrected notebook fix). Optional `--lowvram` only when installed version supports it; dynamic VRAM behavior depends on version, so validate via logs and peak measurements. Expose supported memory/offload/cache options as safe enums; no arbitrary CLI injection. Use actual cgroup RAM, GPU VRAM and available disk preflight, including peak loads and streaming scratch space. On OOM report, clean up idle cache or restart service after drain; no infinite retry or unauthorized model, size, or hardware change. `/free` only when idle, test behavior. Benchmark both families with multiple LoRAs and 768/1024 where feasible.

### 6.3 Remote settings, configuration revisions and application

Carry forward v1.1 remote configuration as P0, replacing notebook forms with shared typed profiles consumed by Vast worker. Offline edits persist and apply on next startup without allocating anything. All settings exposed must have validation, capability and application class; display desired vs effective revision, pending changes and failure/rollback.

| Settings | Apply class |
|---|---|
| Provider/GPU, price, disk, image digest, instance type, network | Reprovision or next allocation; approval if costs/storage change |
| Idle timeout, budget policy, diagnostic intervals | Hot controller policy; tighten bounds safely |
| Model/encoder/VAE, worker dependency version, VRAM flags | Drain + worker reconfigure/restart; reprovision only when required |
| Storage path/cache limits/volume, retention | Plan; safe idle operation or controlled migration with approval |
| API credentials, transport identity | Secure refresh/reconnect; rotation with epoch verification |
| Asset metadata/downloads | On demand/preflight; stage before use |
| Native prompt, negative prompt, seed, resolution, steps, CFG, sampler, tags, LoRA order/weights | Native job values; not a duplicate settings authority; model defaults used only where native settings permit |

Proposed authenticated control API: `/manager/v1/config/schema`, `GET /manager/v1/config`, `POST /manager/v1/config/plan`, `PUT /manager/v1/config` with expected revision and operation ID, `GET /manager/v1/operations/{id}`, `GET /manager/v1/health`, and asset endpoints below. Internal design contract, not an existing Vast or Lumiverse API. Restrict typed fields and filesystem roots; no arbitrary URLs/commands/config scripts. Record desired/effective revisions, epoch, last-known-good revision and plan; reject stale writes, defer conflicting changes, verify worker read-back before committing; rollback or explicit degraded state on failure. Share schema between extracted worker and optional offline notebook helpers only if useful; don't rewrite working notebook merely for migration.

## 7. Native LoRA integration and remote asset resolution

### 7.1 Source discovery and no-duplication rule

Before building Civitai integration, use actual native LoRA Studio with a small licensed compatible LoRA and a clean cache. Test direct `.com` and `.red` download URLs, existing local filenames, native discovery/catalog, one and two model-only LoRAs, actual applied weights and generated output. Trace whether host converts URL, downloads (where?), delegates to ComfyUI or sends URL literally, and whether model-only stacking is supported. Existing screenshot does not prove any of these. If native code safely downloads to the remote worker and handles authentication and compatibility, reuse it. Add only missing pieces (ensure worker/path/cache). If native support differs by provider, scope the adapter to dedicated Vast ComfyUI connection. No duplicate downloads or loader insertion.

### 7.2 Resolver contract (only if needed)

Input is the final native resolved ordered LoRA stack including character bindings, plus selected profile/family and request context. Native Studio remains the only source of creative intent; preserve preset URLs/filenames and weights unchanged. For each reference, resolve to a canonical worker-relative filename that actually exists in `models/loras`; rewrite only transient submission graph fields. Use native final graph or documented preflight hook; don't invent hidden selection state or insert another stack after native graph assembly. Bypassed layers must not trigger a download. If a native filename is ambiguous/missing and no manifest source exists, show actionable error/explicit import; do not search by fuzzy title and guess.

- Accept existing safe relative filenames, direct `/api/download/models/{versionId}` and standard Civitai model-page URLs including `modelVersionId` on allowlisted Civitai domains. Treat explicit version as authoritative; wrong family is a hard error, not a first-version fallback. For generic model pages, fetch metadata and choose only unambiguous compatible version; otherwise show a version-choice remediation and remember the selection for that source/profile. Preserve `.red` support only after verifying its API/redirect behavior; normalize domains/IDs safely. Do not persist signed URLs or tokens in presets.
- Maintain separate `loras/anima/` and `loras/moss/` directories; own asset manifest with Civitai model/version/file ID, source, family, compatible subtypes, filename, expected hash/size, installed path and validation date. ComfyUI filenames use relative path syntax confirmed in `object_info`. Resolve exact versions deterministically with version ID + sanitized name, detect collisions, lock concurrent downloads per asset, invalidate stale files and preserve old bindings on explicit migration. Compatibility uses approved metadata mapping and real graph validation; unknown/unlabeled versions require explicit handling, no silent override.
- Download directly to worker (don't relay multi-GB payload through Space); use a narrow authenticated typed installer, stream to temp file, enforce disk/size/quota, checksum when available, validate safetensors header/type and safe file extension, atomically publish after validation. Restricted/gated downloads require user-provided token and authorization; no bypass. Never send Civitai key to arbitrary redirects; allow only documented CDN flow without forwarding auth to untrusted origin. Reject arbitrary hosts, SSRF, DNS rebinding, path traversal, symlinks escaping roots, unsupported executable/pickle formats, unsafe archives. Manual import is optional approved upload path; validate same rules. Use only assets the user can legally access.
- Refresh native discovery after installation (verify any required cache invalidation). New asset references use stable filenames without altering saved native preset or character data. Cache hit must not re-download. If download fails, fail before native prompt submission; never generate with a silently omitted LoRA or changed weight. LoRA model-only nodes have no CLIP strength; leave irrelevant native CLIP field in preset without inventing encoder patching. If workflow needs a different loader, feature-detect and reject unsupported changes.
- Provide optional read-only installed assets view, explicit prefetch/install retry and cleanup if not referenced/in use. API proposal `POST /manager/v1/assets/resolve`, `POST /manager/v1/assets/install`, `GET /manager/v1/assets`, `DELETE /manager/v1/assets/{id}` with owner/epoch and lease checks. Never delete asset used by queued/active jobs; warn about native references on removal.

### 7.3 Storage strategy

Start with persistent instance disk and a stopped-instance resume strategy. Prefer 100 GB with honest footprint quote; calculate checkpoint/encoder/VAE and LoRA scratch before allocating/download. Deduplicate shared components via single storage root/hardlinks where supported; no accidental Hugging Face cache duplicate. If volume supported and owner opts in, verify host affinity, mount path, retention and exact costs; don't assume portable volume or automatic cross-host attachment. Keep lightweight manifests/profile state on durable Lumiverse storage, backed up independently. Optional approved backup destination for irreplaceable custom assets; public models can rehydrate by immutable revision when allowed. No mandatory Google Drive mount in Vast. Persist native final images through Lumiverse; retrieve before stopping, destruction or migration.

## 8. Security, data and operations

- Vast master API key lives only in documented host/Spindle secret store (verify enclave access and gateway sharing); no frontend/localStorage, committed env files, runtime arguments or screenshots. Least privilege where provider supports it; worker receives only short-lived per-instance/control credentials or verified instance-scoped key. Civitai/HF token stored separately, sent only to authorized downloader as necessary, never passed to native prompt graph. Rotate/revoke; redacted config export. Treat marketplace host as third-party infrastructure; no unnecessary private chat/history, keys or data on it.
- Use owner-scoped permission checks and documented Spindle APIs, minimal permissions; don't bypass process sandbox or manipulate host DB directly. Validate all Civitai inputs/endpoint identity, TLS, auth, rate/size caps. Separate lifecycle control plane and inference data plane; no open reverse proxy, arbitrary shell or arbitrary filesystem access. Protect prompt/history/media paths under gateway auth.
- Persist durable records: `ProviderPolicy`, `InstanceRecord` (ID, ownership, epoch, rates, contract, deadlines, confirmed/desired state), `AllocationIntent`, `JobLease` (job/prompt IDs, activity), `WorkerProfile` (revision), `ConfigOperation`, `AssetManifest`, `SpendLedger`, `AuditEvent`. Use durable Space-mounted path (verify existing `/app/data` and filesystem/DB transaction semantics; don't assume); handle process suspension and restarts. No duplicate prompt/gallery database.
- Log redacted correlation IDs, latency stages, offer/rate selection, estimated spend, worker resource snapshots, download/cache hit, active/pending counts, unknown/stopped instances, cleanup status; show last provider confirmation timestamp. Alert on stale communication, failed stop or orphan candidates. Never claim completion after a network timeout. Include manual Vast console/CLI cleanup runbook and identify only owned IDs. Disabling extension or changing provider drains and reconciles running resources; no secret removal before cleanup unless deliberate override.

## 9. Migration and repository plan

Keep existing repository and preserve history. Inventory branch status, tests, ADRs, manifests, permissions and deployment wiring. Create `feat/vast-first` or equivalent branch from current work; avoid destructive resets. Move Colab-only prototype code behind an explicitly manual/experimental boundary; archive ADR-002 if about Colab and append supersession note rather than erase it. Do not silently change existing user profiles or deployed Space. Reuse lifecycle abstraction, mock, typed config, durable state, downloader and workflow builders; replace notebook executor, Google OAuth, Drive assumptions and mandatory Ngrok in production path. Keep notebook files as fixtures/reference.

Suggested organization (adapt to existing repo instead of wholesale refactor):

```text
PRD.md                         # v2.0; old PRD archived
spindle.json
src/{backend,frontend}.ts
src/controller/               # policy, leases, state, reconcile, billing
src/providers/{vast,mock,manual-colab}/
src/integrations/              # native preflight / gateway client
src/{assets,settings,schemas}/
worker/                        # pinned image/bootstrap + supervisor + typed API
worker/profiles/               # model manifest and compatible workflow fixtures
host-bridge/                   # only if native API gap proven
reference/                     # corrected unified notebook, archived PRD
docs/adr/                      # architecture decisions and supersession
 tests/{unit,integration,e2e}/ # adapt naming to current project
```

## 10. Milestones and gates

| Gate | Deliverable and exit criterion |
|---|---|
| V0 — audit / rebaseline | Inventory actual agent repo and host commit, reuse map, ADR-001 native hook/proxy, ADR-002 superseded Colab direction, ADR-003 Vast transport/lifecycle and ADR-004 LoRA resolution. Mock native trace; read-only API test only with local secret. No rentals. |
| V1 — deterministic core | Vast adapter schemas and mock HTTP fixtures, controller locks/leases/reconciliation/cost policy, settings/dashboard, credential and security tests. Mock clock proves lifecycle including concurrent requests, crash and ambiguity. |
| V2 — worker and warm proof | Build pinned worker locally/mock; owner authorizes one capped live test, select offer, bootstrap one instance, secure real Space endpoint, native saved image + progress/cancel. Test MOSS and Anima family independently; cold caches and actual resource peaks. Stop/verify even on test failure. |
| V3 — native assets | Determine native URL behavior, implement only required resolver, compatible model-only stacking and cache; preserve exact native values. Test direct URLs, standard pages, blocked/incompatible files, cache hits and two LoRAs on both tested families; validate remaining profiles before labeling supported. |
| V4 — full lifecycle | Actual normal native image request while stopped/no instance, one resume/create, no manual launch, correct profile/LoRA prep, native persistence, warm reuse, automatic idle stop confirmed. Validate restart of Space, duplicate requests, sleep/watchdog and spend/cleanup safety. No release if fail-safe unattended policy unresolved. |
| V5 — profile coverage and deployment | All eight profile smoke tests/live or explicitly marked unverified; config plan/apply, disk/LoRA persistence, reconnection, measured cold/warm latency and cost, rollback/security docs. Owner approves deployment and paid automation policy separately. |

No further Google OAuth investigation needed for primary path. Continue against mocks if paid approval is pending. Each gate reports actual pass/fail/skipped/blocked, commits and rollback instructions. A notebook or mock-only success does not satisfy V2/V4.

## 11. Acceptance criteria

| ID | Test | Expected outcome |
|---|---|---|
| A01 | Native warm request from actual Space | Image saved normally, prompts/negative/seed/weights match final native graph; progress/cancel preserved |
| A02 | Native cold request | One authorized allocation or resume; no duplicate submission; status visible through startup |
| A03 | Two simultaneous requests | One instance, separate job IDs and prompt IDs, no race during startup |
| A04 | Offline catalog/health/settings | No paid resource allocation |
| A05 | Idle 5 min; second request just before expiry | Stop only after last real work + configured time; new work cancels stop or resumes safely |
| A06 | Long job/asset download/output retrieval | No idle interruption; authorized maximum deadline policy enforced separately |
| A07 | Stop/resume with cache | Provider confirms stopped before paused status, storage estimate visible; resume keeps weights/files where supported; no repeat download |
| A08 | Unavailable/expired host | Actionable error or only preauthorized replacement; leftover storage visible; no unrelated deletion |
| A09 | Timeout/rate limit after create / prompt | Reconcile before retry; no duplicate rental or image |
| A10 | Space restart/sleep/controller crash | Durable state/leases recovered, stale epoch blocked; independent cleanup safety tested or unattended mode blocked |
| A11 | Price change/budget exceeded | Block unapproved provisioning/resume; no key leakage/refill; show estimate limitations |
| A12 | Wrong auth/HTML 200/expired cert | Never Ready; reject auth, no public/insecure fallback; WS transport tested |
| A13 | Existing filename and direct Civitai link | Correct verified worker file resolved; native preset unchanged; native cache invalidated where required |
| A14 | Multi-version page and incompatible explicit ID | Deterministic compatible choice or prompt to resolve; explicit wrong family rejected |
| A15 | Missing token, corrupt/incomplete file, path escape | Fail before prompt; no published bad file; safe cleanup and redacted diagnostics |
| A16 | No LoRA / 0.6 / 1.0 / stacked / bypass | Inspect exact model-only graph, compare controlled-seed outputs; no double insertion, bypass no download; CLIP semantics correct |
| A17 | Switch MOSS/Anima and profile revisions | Correct loaders/encoder/VAE/latent and catalog; drain then switch; old-family assets never applied accidentally |
| A18 | Offline config changes, stale revision, failed apply | Persist desired profile, no startup; verify effective before commit; conflict/rollback visible |
| A19 | Normal VRAM and OOM | No unsupported `--normalvram`; safe recovery with no silent degradation or unapproved GPU |
| A20 | Stop/force stop/destroy | Drain by default; explicit force approval; ownership verified; destructive retention behavior correct |
| A21 | Secret scan and security tests | No secrets in git/browser/logs; unauthorized requests, SSRF, unsafe file and stale workers denied |
| A22 | Colab legacy regression | Standalone corrected notebook preserved; no unattended Colab fallback or required OAuth/Ngrok in Vast path |

## 12. Open decisions for owner and developer

- Exact Vast hourly/daily/monthly caps, session limit, storage retention and replacement authorization. Proposed 5-min idle and $0.20/hr are editable defaults only; no spending authorized.
- Actual native hook and LoRA URL behavior, host bridge necessity, provider-template TLS/WS viability, and HF Space deployment permissions. Agent must prove them from local source and actual environment.
- Instance watchdog/credential scope, provider failure behavior, supported storage/volume availability and billable rates. Unattended mode stays gated until fail-safe test passes.
- Pin worker image/dependencies/models after smoke tests. Reference adapter optional; full precision and serverless deferred until measured need. No claim all variants already work on Vast.ai.

## 13. Official references and local fixtures (reviewed 2026-11-18)

- Vast API overview: https://vast.ai/developers/api ; schemas: https://github.com/vast-ai/docs/blob/main/api-reference/openapi.yaml ; official SDK/CLI: https://github.com/vast-ai/vast-cli
- Lifecycle and storage: https://github.com/vast-ai/docs/blob/main/guides/instances/manage-instances.mdx ; https://github.com/vast-ai/docs/blob/main/guides/instances/storage/types.mdx ; https://github.com/vast-ai/docs/blob/main/guides/instances/storage/volumes.mdx
- Pricing and docker: https://github.com/vast-ai/docs/blob/main/guides/pricing.mdx ; https://github.com/vast-ai/docs/blob/main/guides/instances/docker-environment.mdx
- Lumiverse extension docs: https://docs.lumiverse.chat/ ; https://docs.lumiverse.chat/backend-api/image-generation/ ; https://docs.lumiverse.chat/getting-started/runtime/ ; https://docs.lumiverse.chat/getting-started/capabilities/ ; https://docs.lumiverse.chat/getting-started/quick-start/
- Lumiverse upstream: https://github.com/prolix-oc/Lumiverse ; native setup: https://lumiverse.chat/guides/image-generation/setup/
- ComfyUI: https://github.com/Comfy-Org/ComfyUI ; Civitai API: https://github.com/civitai/civitai/wiki/REST-API-Reference
- Models: https://huggingface.co/circlestone-labs/Anima ; https://huggingface.co/Comfy-Org/MOSS-Image
- Local fixtures: v1.1 PRD, corrected unified notebook, user screenshot. Source references inform the design; exact installed versions and runtime behavior require live validation. All proposed internal interfaces are specifications, not implemented APIs.
