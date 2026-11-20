# ADR-005 — Worker endpoint resolution (Colab + Vast)

**Status:** Proposed — design only, nothing implemented
**Date:** 2026-11-19
**Relates to:** ADR-003 (Vast lifecycle + transport), PRD ("register endpoint per boot with runtime epoch")
**Supersedes:** nothing. Corrects one root-cause claim recorded in `docs/migration-vast.md` (see §12).

---

## 1. Problem

The Space reaches the worker at a URL that is minted per boot, and the Space has no way to
discover the replacement. Today that value lives in the HF secret `GATEWAY_UPSTREAM`, so every
worker restart costs: edit secret → Factory restart (2–4 min) → hope. It is the single largest
source of friction in the whole integration, and it is identical in shape on both backends.

## 2. Evidence

| Observation | Source |
|---|---|
| `*.trycloudflare.com` URL is new on every Colab session; secret + factory reboot required per session | `docs/m1-warm-connectivity.md` |
| `GATEWAY_UPSTREAM` is read once at module load and `new URL()` validated at boot | `host-gateway/gateway.ts:35-49` |
| Vast publishes a TCP port only when the image declares `EXPOSE`; `-p 8188` env alone does nothing | `docs/plans/vast-transport-plan.md` |
| Vast `public_ipaddr` + `ports` exist on the instance object but change per instance | `src/providers/vast/types.ts` |
| Vast Instance Portal (`OPEN_BUTTON_PORT=8188` → trycloudflare link) is **untested** | `docs/plans/vast-transport-plan.md` |
| The Spindle SDK exposes storage / userStorage / enclave / corsProxy — **no HTTP route registration** | `lumiverse-spindle-types@0.6.80`, `dist/spindle-api.d.ts` |
| HF Spaces publishes exactly one application port | HF Space runtime model |

The SDK line is the binding constraint: **the Space cannot accept a "here is my new URL" POST on
port 7860**, and HF publishes no second port. Any push-based registration therefore needs either a
local channel (extension → gateway, both inside the container) or an external rendezvous.

## 3. Why this is one problem, not two

| | Colab | Vast |
|---|---|---|
| Endpoint today | quick tunnel hostname | `public_ipaddr:host_port` map, or portal link |
| Stable across restarts? | no | no (new instance = new IP/port) |
| Space can ask the platform? | no such API | **yes** — `show_instance` |
| Who must deliver the value? | the user (or an external registry) | the Space itself (pull) |

So the platforms differ only in **how the current endpoint is learned**, not in what the gateway
does with it. That is the seam the design uses.

## 4. Option catalogue

### 4.1 Transport mechanisms (where the bytes go)

| # | Mechanism | Colab | Vast | Stable hostname | Cost | Notes |
|---|---|---|---|---|---|---|
| T1 | Cloudflare quick tunnel | works today | via container | no | $0 | current Colab path; unchanged URL churn |
| T2 | Vast Instance Portal (`OPEN_BUTTON_PORT`) | n/a | untested | no | $0 | portal link is itself a quick tunnel |
| T3 | Vast port map (`EXPOSE 8188`) | n/a | proven shape, not yet published | no | $0 | `ip:port` per instance; no extra hop |
| T4 | Cloudflare **named** tunnel | works | works | **yes** | ~$10/yr domain | one config, both platforms |
| T5 | Tailscale Funnel | **unverified** (userspace TUN) | works (root + TUN) | **yes** (`*.ts.net`) | $0 | fixed `--hostname` + ephemeral node key |
| T6 | Reverse tunnel (worker dials the Space) | needs a public route — blocked by §2 | not needed | n/a | $0 | 1–2 days; belongs with future work |
| T7 | SSH tunnel from Space | blocked (no HF Pro) | blocked | n/a | — | dead end |

### 4.2 Discovery mechanisms (how the endpoint is learned)

| # | Mechanism | Colab | Vast | Touch | Verified |
|---|---|---|---|---|---|
| D1 | Static env secret + restart | yes | yes | manual + 2–4 min downtime | yes (today) |
| D2 | Paste into extension → gateway (live swap) | yes | yes | one paste / boot | no (no live swap yet) |
| D3 | Provider API pull (`show_instance` → `ports`) | n/a | yes | none | API shape verified, publish unverified |
| D4 | External registry (Cloudflare Worker + KV, GitHub, etc.) | yes | yes | none after setup | no (WS/stream limits untested) |
| D5 | Automate HF secret + restart via API | yes | yes | none | yes, but restarts Lumiverse every boot |
| D6 | Stable hostname (T4/T5) | yes | yes | none | T4 yes, T5 untested |

### 4.3 Ranked per platform

Ordering is by "effort × risk per unit of friction removed", cheapest useful thing first.

**Vast** (own the image, root available, provider API reachable):

| Rank | Option | Why here |
|---|---|---|
| 1 | T3 + D3 — `EXPOSE 8188` + `show_instance` pull | No third party, no cost, no tunnel, and discovery is zero-touch. Only real work is the image and the ports normalisation. |
| 2 | T2 — Instance Portal | Free and image-independent, but the portal link is itself an ephemeral quick tunnel plus a hop we do not control. Cheap to test, weaker to depend on. |
| 3 | T4 — named tunnel | Stable hostname with the least machinery, but per-instance tunnels need a per-instance token; more moving parts on Vast than on Colab. |
| 4 | T5 — Tailscale Funnel | Works (root + TUN) and is $0, but every rented instance joins the tailnet and needs an auth key at boot. |
| 5 | T6 — reverse tunnel | Correct long-term answer, most code, shared with the Colab future. |

**Colab** (no root, no TUN, no provider API):

| Rank | Option | Why here |
|---|---|---|
| 1 | T4 — named tunnel | Deletes the churn outright with no new component and no bandwidth cap. Only cost is the domain. |
| 2 | T5 — Tailscale Funnel | $0 stable hostname, but `--tun=userspace-networking` is unverified on Colab (no `/dev/net/tun`). Spike decides it in 20 minutes. |
| 3 | T1 + D2 — quick tunnel + live swap | Works today; one paste per session instead of secret + restart. The floor, not the goal. |
| 4 | D4 — Worker + KV registry | Fully automatic, but adds infrastructure and rests on unproven WS/stream limits. |
| 5 | T6 — reverse tunnel | Blocked: Colab has no public route to dial into. |

**Dropped on evidence:** T7 (SSH from the Space — needs HF Pro), ngrok static domain (egress cap +
its edge RST'd the Space's egress), D5 (restarts Lumiverse every session).

### 4.4 What "works on both" actually requires

A mechanism is cross-platform only if all five hold. This is the checklist any future candidate
must pass before it enters the catalogue:

1. **Same surface** — terminates on the gateway's existing HTTP + WS routes, so the extension and
   Lumiverse stay unchanged.
2. **Same privileges** — startable on Colab (no root, no TUN) and on Vast (root) with one script.
3. **No Space mutation** — a worker restart never requires editing an HF secret or rebooting the
   Space.
4. **Full traffic shape** — passes the `/ws` upgrade and ≥13 MB `/view` bodies without buffering.
5. **$0 to operate** — no per-GB egress tier and no paid relay.

Only **T4 (named tunnel)** and **T5 (Tailscale Funnel)** pass all five today; T5's item 2 is the one
unverified box. T3/T2 are Vast-shaped (no Colab table row) and T1 is Colab-shaped (no stable
hostname). That asymmetry is exactly what Layer 1 + Layer 2 absorb: the gateway does not care, and
each platform contributes only its own adapter.

## 5. Decision

Adopt a three-layer model. The gateway stops caring which platform produced the value.

**Layer 1 — Endpoint registry inside the gateway (mandatory, platform-neutral).**
`GATEWAY_UPSTREAM` becomes the *initial* value, not the permanent one. A small registry holds the
current `WorkerEndpoint`, re-read on every request, mutated through the existing loopback control
plane (`POST /gateway/v1/endpoint`, bearer `GATEWAY_CONTROL_TOKEN`). Effective immediately — no
container restart, ever.

**Layer 2 — One adapter per platform, same interface.**
- *Vast:* pull. `VastProvider.discoverEndpoint(instanceId)` reads `show_instance`, maps the
  container port, returns an epoch-tagged endpoint. Zero-touch.
- *Colab:* push. The extension writes the pasted URL; optional D4 registry later.

**Layer 3 — Optional stabiliser.**
If T4 or T5 pans out, Layer 2 collapses to a constant and Layers 1–2 still hold unchanged.

**Explicit non-goals:** no per-request retry across epochs, no resubmission of `POST /prompt` after
an uncertain send (ADR-003 §5 still governs), no new third-party dependency without a spike.

## 6. Interface sketch

```ts
export interface WorkerEndpoint {
  /** Gateway-facing base URL, e.g. https://x.trycloudflare.com */
  baseUrl: string;
  /** Where it came from — shown in the panel, never inferred. */
  source: "static" | "provider-api" | "pushed" | "named-tunnel";
  /** New value ⇒ new worker process/instance. Invalidates cached capability data. */
  epoch: string;
  /** Which backend produced it (drives the UI copy and the resolver). */
  backend: "colab" | "vast";
  /** Optional. Absent = no wall-clock trust beyond "still probes 200". */
  expiresAt?: number;
  /** Optional per-epoch upstream credentials; omitted ⇒ use GATEWAY_BASIC_AUTH. */
  auth?: { kind: "basic"; username: string; password: string };
  /** Free-form provenance: instance id, portal link, notebook session, etc. */
  meta?: Record<string, string>;
}
```

Provider contract addition (extends the existing `GpuProvider` in `src/providers/types.ts`):

```ts
discoverEndpoint?(instanceId: number): Promise<WorkerEndpoint | null>;
```

Control plane addition (`host-gateway/gateway.ts`):

```
GET  /gateway/v1/endpoint   -> { endpoint, ageMs, probe }
PUT  /gateway/v1/endpoint   -> validates, swaps, re-probes, returns the new state
DELETE /gateway/v1/endpoint -> reverts to the env-provided value
```

Validation on `PUT` is strict, because this mutates where credentials get sent:
http(s) only, no userinfo, no query/fragment, hostname allowlist per source
(`*.trycloudflare.com`, `*.ts.net`, `*.hf.space`, plus a Vast IP literal), and a 2 KB body cap.
A rejected swap leaves the previous endpoint untouched.

## 7. Discovery details per platform

**Vast (pull).** `show_instance` returns `public_ipaddr` and `ports`; `ports` is typed
`Array<[number, number]> | number[]` in `src/providers/vast/types.ts` and **both shapes occur**, so
the mapper must normalise before picking the container port 8188. Endpoint is only valid while
`actual_status === "running"`; on `stopped|exited|unknown|offline` the registry entry is marked
stale and the extension offers stop/destroy rather than retrying the endpoint. If T2 wins, the same
adapter returns the portal URL instead — the interface does not change.

**Colab (push).** The notebook prints the URL; the user pastes it once into the extension panel.
The extension PUTs it to `127.0.0.1:8189/gateway/v1/endpoint` with the control token (held in the
enclave, entered once). If D4 is later adopted, the notebook POSTs to the registry and the
extension polls it; again the interface does not change.

## 8. Credentials

Two acceptable models, in order of preference:

1. **Shared project credential** (default). One `GATEWAY_BASIC_AUTH` value, minted once, stored in
   HF secrets and in the enclave; the worker's Caddy is started with the same value at deploy time.
   Simple, platform-neutral, no secret ever crosses the control plane.
2. **Per-epoch credential** (hardening). The endpoint carries `auth`; the extension pushes it over
   loopback at deploy time. The gateway must hold it in memory only — never log it, never persist
   it, never echo it in `/gateway/v1/endpoint`.

Rotation is an explicit action in both models. The control plane never returns a credential.

## 9. Failure modes and epoch rules

| Situation | Required behaviour |
|---|---|
| Endpoint swapped mid-generation | in-flight request fails once; the UI says the worker changed; **no** automatic `/prompt` replay |
| Endpoint stale (Colab died, Vast stopped) | status probe marks worker unreachable; registry keeps the last value for display with its age |
| Two generations race a swap | single-flight swap; the losing request observes the new epoch on its next call |
| Capability data cached from a previous epoch | invalidated on epoch change (node sets differ between Vast images) |
| Malformed / disallowed endpoint PUT | 400, previous endpoint untouched, audit line without the body |

## 10. Open spikes (each time-boxed, cheapest first)

1. **Live endpoint swap (D2/L1)** — 1–2 h. No external dependency; required by every other option.
2. **Vast Instance Portal reachability (T2)** — 30 min on a live instance: deploy with
   `OPEN_BUTTON_PORT=8188`, click Open, `curl /system_stats` from the Space.
3. **Vast port map (T3)** — 3–6 h: custom image with `EXPOSE 8188`; confirms the pull adapter end to end.
4. **Tailscale Funnel on Colab (T5)** — 20 min: `tailscaled --tun=userspace-networking` +
   `tailscale funnel 8189`. Decides whether a $0 stable hostname exists for both platforms.
5. **Worker + KV registry (D4)** — only if 4 fails; must first prove WS upgrade passthrough and a
   13 MB image stream on the free tier.

## 11. Consequences

- One gateway, one allowlist, one auth-injection path, one audit format — for both backends.
- The extension panel gains a meaningful status line: endpoint, source, epoch age, last probe.
- D1 (today) remains valid as the initial value, so nothing breaks if Layer 2 is never built.
- No new runtime dependency, no new secret on the wire, no domain required.
- Cost of the "stable hostname" branch is deferred until a spike says it is worth it.

## 12. Correction to a recorded root cause

`docs/migration-vast.md` (branch `feat/vast-first`) attributes the 1024×1024 failures to HF Space
memory pressure and to the embeddings pipeline. That is **not** what happened. The real cause —
proven on 2026-11-19 — is `Bun.serve`'s default 10 s idle timeout closing the gateway's `/view`
response while it was still silent, buffering a 12 s image transfer. 512 px finished under 10 s and
usually survived; 1024 px did not. Fixed in `1c2c897` (`idleTimeout: 255` + streaming `/view`).

When `feat/vast-first` merges, that paragraph must be corrected rather than carried forward. The
Vast worker itself (≥24 GB VRAM) is unaffected by this — but the lesson generalises: **any proxy on
this path must have its idle timeout raised above the slowest transfer**, which applies equally to
the instance-side Caddy on Vast.

## 13. Selection (2026-11-19): T5 first, Colab first

The owner selected **Tailscale Funnel (T5)** and asked for the Colab path to be proven before any
work on Vast. Rationale: it is the only $0 option that passes §4.4 without new infrastructure, and
if it holds, `GATEWAY_UPSTREAM` becomes a constant — which removes the per-session secret edit and
Factory restart entirely, on both backends.

The runnable spike is `docs/spike-tailscale-funnel.md` (prerequisites, the cell, the measurements,
and the fail conditions). Nothing is committed to the notebook until it passes.

Three findings from preparing the spike that change the risk profile and must not be lost:

1. **Funnel does not require a kernel TUN.** `tailscaled --tun=userspace-networking` +
   `tailscale funnel --bg` is the documented Docker/container pattern and is in use in the field.
   Colab's missing `/dev/net/tun` is therefore not a blocker. Layers 1 and 2 of §5 are unchanged.
2. **Certificate duplication is the hidden constraint.** Funnel issues a TLS certificate per node,
   and Let's Encrypt allows roughly five duplicate certificates per week for one identifier set. A
   fresh ephemeral node each Colab session would start failing within a week. Mitigation: persist
   `tailscaled`'s state directory across sessions (Drive), which preserves both node identity and
   the cached certificate. This also makes the hostname stable in the first place, so the mitigation
   and the goal are the same action.
3. **Throughput is the real risk, not connectivity.** Funnel is beta, is subject to
   non-configurable bandwidth limits, and with userspace networking its inbound path runs through
   gVisor's netstack — which Tailscale documents as roughly 5× slower than binding a server to a
   tailnet IP. Public reports include relay transfers at tens of KB/s. Our `/view` bodies are
   1.3–1.4 MB, so the spike must measure that transfer specifically; the idle-timeout fix means a
   slow transfer succeeds, but not that it is acceptable.

T5 stays "selected for trial", not "accepted", until measurements 1–7 in the spike document are
recorded. If T5 fails, the fallback order in §4.3 stands: T4 (named tunnel, needs the ~$10/yr
decision), then Layer 1 alone (one paste per session).

### 13.1 Colab trial, 2026-11-19: functional pass

The spike was run on Colab and the owner reports the Funnel path working end to end: multiple
1024 px generations went through it, and the worker kept working across a Colab disconnect and
reconnect. Two of the risks that could have disqualified T5 outright are therefore settled:

- **Egress (risk 5) is not blocked.** `tailscaled` reached the control plane and DERP from a Colab
  runtime with `--tun=userspace-networking`.
- **The relay carries a real session, not just a health check.** Generations completed through
  `funnel` → Caddy → ComfyUI on 443.

A fifth finding that belongs with the three above, because it is a constraint on any future
implementation rather than a detail of this cell:

4. **`tailscaled`'s state directory cannot live on Drive.** It creates a unix socket inside
   `--statedir`, and the Drive FUSE mount cannot host sockets — the daemon exits in under a second.
   The state file itself is also a poor fit for FUSE (`flock`, atomic rename). The working shape is
   the one now in the notebook: run on `/content/ts-run`, mirror `tailscaled.state` and `certs/` to
   Drive after the certificate is issued, restore on the next start. The first run of the spike
   failed exactly here, which is why the design is recorded rather than left implicit.

T5 is "selected and working", still not "accepted". What remains before acceptance is evidence, not
opinion: proof that the post-reconnect run was a *fresh VM* restoring state from Drive (otherwise the
tunnel never restarted and the premise is untested), the §5 throughput numbers — especially a
1.3–1.4 MB `/view` body — and a `/ws` → `101` through the Funnel. See
`docs/spike-tailscale-funnel.md` §8.

