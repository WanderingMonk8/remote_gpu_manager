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
| `connectionInfo.url` is a port-prefixed proxy host: `https://8080-gpu-t4-s-….us-west4.prod.r.colab.dev` | `docs/colab-runtime-api-result.json` (gitignored, token masked) |
| Proxy token is short-lived (`expireTime` present); refresh by re-`GET`ting the runtime | API schema `ConnectionInfo` |
| `eligible: true` in `ListRuntimeSpecs` is permission to ask, not a guarantee of stock; both states now observed | `docs/colab-eligibility-result.json` + the spike run |
| There is no "power on": `DELETE` unassigns, `POST` allocates a new runtime | API semantics |

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
- **Open technical question.** Does the proxy route by port prefix (`8080-…` → `8188-…`)? If yes,
  an API-created runtime can publish ComfyUI directly and the Funnel becomes optional. Test
  design: create a runtime, run a trivial HTTP server on 8188 inside it via the Jupyter API using
  `connectionInfo`, then `GET https://8188-<same-host>` with `X-Colab-Runtime-Proxy-Token`.
  Deferred until custody is settled.
- `connectionInfo.url` targets Jupyter (8080), not ComfyUI (8188). Do not assume parity.
- The bootstrap path (how our stack lands on a blank API-created runtime: Jupyter-API cell
  execution vs startup script) is unresolved and gates the extension-controlled start.

## 5. Alternatives considered

- Keep ADR-002's manual-only position — rejected: the owner's requirement is extension control.
- Local runtime — rejected: Drive mounting does not work outside managed runtimes.
- GCP Marketplace / Colab Enterprise — rejected for now: cost, against the $0 default and the
  $0.50/hr price filter.
- Vast lifecycle per ADR-003 — parked on `feat/vast-first`; untouched by this ADR.

## 6. Open items

1. Token custody decision (owner).
2. Port-prefix routing spike (§4).
3. Gateway endpoints: `POST/GET/DELETE /manager/v1/runtime`, idle-timer wiring, and the
   worker-config endpoint that hands Basic Auth to the worker.
4. Bootstrap design: how the notebook's cells execute on an API-created runtime.
