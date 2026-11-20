# ADR-006 — Colab runtime lifecycle through the Colab API v1beta

**Status:** Accepted for the mechanism; one blocker open (token custody, §4)
**Date:** 2026-11-20
**Relates to:** ADR-002 (provider feasibility; its "manual-only" position), ADR-005
(worker endpoint resolution), PRD lifecycle state machine
**Supersedes:** the "manual-only indefinitely" position of ADR-002, for the Colab provider only.
Vast work stays parked on `feat/vast-first`.

---

## 1. Problem

The owner wants the extension to start and stop the Colab instance, keep it alive before an
idle disconnect, and apply a customizable idle-disconnection time. ADR-002 recorded
"manual-only indefinitely" because no sanctioned control surface existed. That premise
changed: the Colab API v1beta is now public (discovery revision 20261118).

## 2. Evidence

| Observation | Source |
|---|---|
| Public API: `POST/GET/DELETE /v1beta/runtimes`, `GET /v1beta/runtimespecs`; scope `…/auth/colaboratory` | live discovery document |
| Free tier **allocates**: `VARIANT_GPU / T4 / SHAPE_STANDARD` created as `runtimes/rgm-spike-eefd1a`, `connectionInfo` returned, runtime deleted | `tools/colab-runtime-api.py`, run 2026-11-20 |
| **Gateway path verified end to end against real Colab (2026-11-20):** credentials → `POST /gateway/v1/runtime` (allocated `runtimes/rgm-gw-3411f931`, T4 STANDARD, 5.6 s) → status `ready` → `DELETE` → `confirmed: true` → `offline` | local gateway, `tools/test-lifecycle.mjs` |
| Allocation landed in **asia-southeast1**: `8080-gpu-t4-s-ass1c3-….asia-southeast1.prod.r.colab.dev` | same run |
| `connectionInfo.url` is a port-prefixed proxy host: `https://8080-gpu-t4-s-….us-west4.prod.r.colab.dev` | `docs/colab-runtime-api-result.json` (gitignored, token masked) |
| Proxy token is short-lived (`expireTime` present); refresh by re-`GET`ting the runtime | API schema `ConnectionInfo` |
| `eligible: true` in `ListRuntimeSpecs` is permission to ask, not a guarantee of stock; both states now observed | `docs/colab-eligibility-result.json` + the spike run |
| There is no "power on": `DELETE` unassigns, `POST` allocates a new runtime | API semantics |
| **The owner's real MOSS workbook bootstraps headless (2026-11-20):** cells 2,4,6,8,10,12,14,16,18,20 ran verbatim over the Jupyter API; 12.1 GiB of weights from HF, ComfyUI `0.46.0` answered `/system_stats`, the pinned `MOSS-Image-NSFW-Uncensored-LoRA-ComfyUI` LoRA installed (70.9 MiB), runtime deleted | `tools/colab-bootstrap-probe.py --notebook …_Final.ipynb` |
| `drive.mount()` blocks headless (no browser → `input()` never returns); a guard that skips Drive when `RGM_AUTOMATION=1` fixes it, with no other cell changes | cell 4, preflight timeout then guard |
| **Colab Secrets are unavailable headless:** `userdata.get` fails with "Secrets can only be fetched when running from the Colab UI" | cell 6 HF token warning |
| Without Drive, every start re-downloads 12.1 GiB (~10 min) | cell 6 timing |
| **Tunnel works headless (2026-11-20):** cells 2,4,8,10,25 with the stub → Caddy on 8189 + tailscaled + Funnel; returned `https://worker.tail00000.ts.net`, captured as `GATEWAY_UPSTREAM`, runtime deleted | `tools/colab-bootstrap-probe.py --stub` |
| Ephemeral tailnet state ⇒ hostname gains a `-N` suffix (`moss-comfy` → `moss-comfy-1`) and a fresh TLS cert is issued every session | cell 25 output |

The spike holds OAuth tokens in memory only and writes nothing but the masked result file.

## 3. Decision

Lifecycle control is the gateway's job, called through the Colab API — not the notebook's:

- **Start** = `POST /v1beta/runtimes` with an eligible spec (T4 STANDARD on Free).
- **Stop** = `DELETE /v1beta/runtimes/{id}`.
- **Session continuity** comes from Drive-persisted state (models, tailnet identity, Caddyfile,
  credentials file), which already exists; a recreated runtime rehydrates instead of rebuilding.
- **Idle timer** is gateway-side: N minutes without *work* (ComfyUI queue depth plus last request
  from the Space) → `DELETE`. Not wall-clock idleness, and not the notebook's supervisor.
- The notebook's section 3b supervisor stays: it covers in-session liveness (ComfyUI/tunnel
  restarts). The API covers session-level liveness. Complementary, not redundant.

## 4. Consequences

- **Reverses ADR-002 for Colab.** Unattended operation becomes the design. The owner selected
  "prove allocation first" and proceeded; that is the approval of the reversal.
- **Free-tier policy exposure.** Colab's FAQ disallows, for free users without a positive compute
  unit balance, "bypassing the notebook UI to interact primarily via a web UI". This architecture
  is exactly that shape. Allocation works; continued availability is not guaranteed. No technical
  mitigation exists; the paid plan removes the restriction. Standing constraint unchanged: no paid
  rental without explicit owner approval.
- **BLOCKER — OAuth custody.** The write scope needs a refresh token that outlives one shell
  process. Options: (a) HF Space secret (new secret; owner approval required), (b) Spindle Secure
  Enclave. Decision required before any gateway code.
- **RESOLVED — port-prefix routing does not work.** Tested against four live runtimes
  (`asia-southeast1`, `us-west1`, `us-west4`): a server started on 8188 inside the runtime
  answered `200` from inside (`urllib` → `http://127.0.0.1:8188/`), but the proxy returned
  `404` for both `8188-<suffix>` and `8081-<suffix>`, while `8080-<suffix>/api/kernels`
  returned `200`. The proxy routes only the Jupyter port. **The Funnel stays** for ComfyUI;
  the port-prefix shortcut is not available. Probe: `tools/colab-port-routing-probe.py`.
- `connectionInfo.url` targets Jupyter (8080), not ComfyUI (8188). Confirmed, not assumed.
- **RESOLVED — bootstrap works.** `tools/colab-bootstrap-probe.py` pushed notebook cells
  2, 4, 8, 10 into a fresh runtime over the Jupyter API and ComfyUI came up:
  `COMFY 200` with `comfyui_version 0.46.0` on `/system_stats`, runtime deleted after.
  Patches: `USE_DRIVE=False` (no interactive Drive mount), `LIFECYCLE=False` (no
  supervisor), and a stub replacing section 3's multi-GB weight download. ComfyUI runs
  with no models, which is enough to prove the mechanism. The full profile adds cell 6
  (weights) and cell 25 (tunnel).
- **Headless constraints found on the real workbook.**
  (a) `drive.mount()` blocks; guarded by `AUTOMATION` in cell 4.
  (b) Colab Secrets cannot be read headless, so every credential must arrive from the
  enclave via env injection.
  (c) Without Drive, weights re-download (12.1 GiB) on every start — a caching decision
  still open.
- **Tailnet identity must persist, or the endpoint is not stable.** Headless runs use
  ephemeral `tailscaled` state, so each start creates a new node: the Funnel hostname gains
  a `-N` suffix and a fresh TLS certificate is issued (Let's Encrypt allows ~5 duplicate
  certs per hostname per week). Until state persists, the ADR-005 assumption that
  `GATEWAY_UPSTREAM` is set once does not hold. Options: gateway-mediated state custody
  (worker uploads `tailscaled.state` before stop, downloads it at start), a non-interactive
  Drive mount, or a dedicated automation hostname plus node cleanup.

## 5. Alternatives considered

- Keep ADR-002's manual-only position — rejected: the owner's requirement is extension control.
- Local runtime — rejected: Drive mounting does not work outside managed runtimes.
- GCP Marketplace / Colab Enterprise — rejected for now: cost, against the $0 default and the
  $0.50/hr price filter.
- Vast lifecycle per ADR-003 — parked on `feat/vast-first`; untouched by this ADR.

## 6. Open items

1. Token custody decision (owner).
2. Gateway endpoints: `POST/GET/DELETE /manager/v1/runtime`, idle-timer wiring, and the
   worker-config endpoint that hands Basic Auth to the worker.
3. Bootstrap: reduced profile proven (`tools/colab-bootstrap-probe.py`). Remaining is the
   full profile — cell 6 (weights) and cell 25 (tunnel) — plus returning the Funnel URL so
   `GATEWAY_UPSTREAM` can be repointed without a secret edit (ADR-005).
4. Funnel stays: the proxy does not route port 8188, so the worker must be published through
   the existing Tailscale Funnel (or equivalent) as before.
