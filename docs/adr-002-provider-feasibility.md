# ADR-002 — Provider feasibility: Google Colab (and the unattended-automation gate)

**Status:** Accepted
**Date:** 2026-11-17
**Evidence sources:** Google Colab API (`developers.google.com/colab/api/reference/rest`, `/rest/v1beta/runtimes`, `/rest/v1beta/runtimespecs/list`, `/reference/mcp`), Colab FAQ & usage limitations (`research.google.com/colaboratory/faq.html`, reviewed 2026-11-17), user-confirmed Colab Free usage, prior ngrok connectivity test (from Colab, HTTP 200 + one generated image).

## Context

The user currently runs MOSS-Image on a **Google Colab Free** notebook (`wildthingsstudio101.ipynb`) and wants: fully automatic runtime start/shutdown triggered by generation, configurable retention, and remote management. The PRD's P1 scope ("Automatic start on a native generation request… activation is gated by host support and the feasibility proof") and §6.1 (Colab feasibility gate) require this to be proven before building unattended automation.

M0 reviews the API surface, the eligibility mechanics, and the published policy for each managed-Colab tier.

## Decision

1. **Google Colab (any managed tier) is not authorized as the unattended/automatic inference host for Lumiverse.** No Colab adapter will be built or enabled for unattended generation, and no fake keep-alive, simulated user activity, or browser/notebook automation will be introduced to work around provider limits — these are both prohibited by the PRD and unlawful against Google's published managed-runtime rules.
2. **Colab Free = manual interactive mode only (P0).** The extension shows launch instructions, `needs_manual_start` vs `offline` states, and diagnostics/status that are legitimately accessible; it never allocates/deletes runtimes, never drives the notebook UI or cells, and never opens/tunnels remotely except as the user manually does.
3. **Automatic (unattended) lifecycle remains blocked** until the user explicitly approves (a) a permitted host and (b) any associated cost. Candidate permitted hosts, in order of preference: the user's own always-on GPU machine running Lumiverse/ComfyUI; a GPU VM/host explicitly designed for remote inference (budget + approval required); Colab Enterprise via GCP Marketplace under the user's Cloud billing (explicit opt-in and cost disclosure required). Until one is approved and proven with a create→ready→connect→delete cycle, **P1/M5 automation is reported unfulfilled, not claimed complete.**
4. The provider-agnostic lifecycle layer (`GpuProvider` contract, mock provider, manual provider, state machine, single-flight, leases, idle shutdown) **will** be built and tested against mocks and any authorized warm host, so an approved host can be enabled later without re-architecting.

## Findings

### A. The Colab REST/MCP API is real, specific, and complete — but existence ≠ permission

Verified 2026-11-17:

- `GET /v1beta/runtimespecs` — lists specs (`variant` CPU/GPU/TPU, `accelerator` e.g. T4/L4/A100, `shape` STANDARD/HIGHMEM) with an `eligible` boolean for the calling user. Scope `colaboratory.readonly` suffices. **This read-only call is the safe first live test the user can authorize** (no compute allocated).
- `POST /v1beta/runtimes` (create; `requestId` UUID4 idempotency; `runtimeId` RFC-1034), `GET`/`LIST` `/runtimes`, `DELETE /runtimes/{name}` — lifecycle operations exist. Responses wrap a long-running `Operation` (`operations/get`, `operations/wait`), or use `create_runtime` via MCP.
- `runtimes/{id}.connectionInfo` returns `{ token, expireTime, url }`; the token (`X-Colab-Runtime-Proxy-Token` header) is **short-lived (~1 hour)** and refreshed by re-`get`-ing the runtime. Files and Jupyter kernels are reachable through documented runtime URL paths (`/files/…`, `/api/contents/…`, Jupyter REST).
- `GET /v1beta/subscription` (`getSubscription`) returns `free`/`Pro`/`Pro+`. MCP adds `create_session` / `execute_code` / `delete_session` for Jupyter kernel execution with re-attachable `executionId` semantics.

So programmatic **runtime assignment** is genuinely supported by Google's API — it is not a gray API or a scrape. What it is not: a license to run a remote inference service.

### B. Policy prohibits what the product would need

From the Colab FAQ (reviewed 2026-11-17), managed Colab runtimes prohibit, **for all tiers**:

- "connecting to remote proxies";
- "file hosting, media serving, or other web service offerings not related to interactive compute with Colab".

Free tier without a positive compute-unit balance additionally prohibits (and may terminate): "remote control such as SSH shells, remote desktops" and "bypassing the notebook UI to interact primarily via a web UI". Running ComfyUI on a managed runtime and serving an external Lumiverse Space's generation traffic through it is (i) a web-service offering not related to interactive compute and (ii) an interaction pattern the free tier explicitly de-prioritizes and terminates. The plain-HTTP ngrok tunnel in the notebook is already a remote proxy; the notebook itself documents the restriction and instructs "Leave OFF on restricted Colab Free runtimes" (cell 24/25) and the user leaves it on only on permitted hosts.

Paid consumer tiers (Pro/Pro+/Pay-as-you-go) lift **some** free-tier restrictions with a positive compute-unit balance, but do **not** lift the all-tiers prohibitions on remote proxies and web-service offerings. The documented ways to run without enforcement are: buying compute via **GCP Marketplace** (dedicated capacity), **Colab Enterprise** (Vertex AI), or a **local runtime** — none of which are Colab Free. Drive mounting is explicitly not supported on those alternatives.

12-hour maximum VM lifetime, idle-timeout termination, and dynamic, undisclosed usage limits apply regardless of automation intentions; nothing in the API guarantees a runtime stays alive for on-demand inference.

### C. Prior user evidence is connectivity proof, not authorization or availability proof

The user's ngrok tunnel test (HTTP 200 from within Colab; one image returned via the remote ComfyUI API) demonstrates TCP/TLS reachability and working credentials **from Colab**, not: authorization for external Lumiverse traffic, entitlement to GPU allocation on demand, survival past idle/lifetime limits, or reachability **from the actual Lumiverse Space** (recognizing HF Spaces egress may behave differently). It stays on file as a feasibility signal only.

### D. What a permitted automatic path would look like (for the P1 decision)

If the user later approves an authorized host (own always-on GPU, dedicated cloud VM, or Colab Enterprise under their billing), the same provider contract applies: `capabilities()` → `autoProvision: boolean`, `listOwned()`, `provision()` (with `requestId` idempotency, record provider runtime ID before awaiting), `bootstrap()` (pinned worker install), `inspect()`, `release()` (only the owned runtime), with typed errors (`UNSUPPORTED`, `AUTH_REQUIRED`, `QUOTA_EXCEEDED`, `POLICY_RESTRICTED`, `TIMEOUT`, `OFFLINE`, `AMBIGUOUS`). A full Google-Cloud-Project → OAuth (`colaboratory.readonly` first) → `runtimespecs.list` eligibility check → create/delete only on explicit opt-in can then be implemented and is separately documented in `docs/colab-eligibility-test.md` — it does not exist yet because the user has not provided OAuth authorization.

## Consequences

- M1–M4 proceed against the manual provider + mocks; manual Colab Free mode ships as the supported P0 experience with `needs_manual_start` semantics (R-03 manual path) and no automatic allocation.
- M5 (cold-start automation on Colab) is **not deliverable** as scoped; it requires explicit user approval of a permitted paid host (or Enterprise) and a fresh eligibility proof. Do not mark M5 done with mocks or with the manually started notebook.
- The `Capabilities` reported by the Colab adapter (whenever built) must default `externalInferenceAllowed: false` until proven and explicitly enabled; treating API existence as authorization is a hard failure of the PRD's critical constraint.
- No-new-paid-service constraint is satisfied: nothing is purchased, provisioned or scheduled without the user's explicit opt-in and cost disclosure.
- The honest-status rule: if no authorized automatic backend is available at release, the delivery is partial and lifecycle automation is marked unfulfilled (PRD release criteria; §10 "If no authorized automation backend is available, deliver partial release…").

## Open items (need user input / live tests)

1. **OAuth eligibility test (no allocation):** requires the user to (a) create/enable the Colab API in a Google Cloud project, (b) complete the OAuth flow with the `colaboratory.readonly` scope, (c) store the refresh token server-side. Outcome recorded as: subscription tier, eligible GPU specs (`T4`/`L4`/`HIGHMEM`, etc.), and quota notes. No runtime is created.
2. **User decision on the unattended host** (own GPU / approved cloud GPU / Colab Enterprise / stay manual-only). This gates P1/M5 and any paid spend.
3. Confirmation whether the user's Colab Free usage (manual notebook + manual ngrok) has been terminated or limited by Google to date, to calibrate the manual-mode UX.
