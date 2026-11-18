# M1 — Warm connectivity: status and verification record

**Milestone:** M1 · **Date:** 2026-11-17 · **Branch:** `m1-warm-connectivity`
**Exit condition (PRD §10):** warm start of a permitted already-running ComfyUI or mock; stable gateway/native connection; authenticated health/catalog/WS; native workflow import; image generated from actual Lumiverse server and saved natively; current connections preserved.

## What is complete and verified locally

| Item | State | Evidence |
|---|---|---|
| Mock ComfyUI worker with upstream Basic Auth (`tests/mock-comfyui/server.ts`) | Done | reproduces `/system_stats`, `/object_info`(+node), `POST /prompt`, `GET /history/{id}`, `GET /view`, `/queue`, `/interrupt`, `/upload/image`, `WS /ws` |
| Host-side gateway (`host-gateway/gateway.ts`) | Done | loopback-only; route allowlist (9 routes + WS); injects `Authorization: Basic` + `ngrok-skip-browser-warning`; bounded bodies; per-route timeouts; JSON validation for catalog/health routes; WS proxy both directions with 10 s handshake timeout; deny-by-default 403; one-line audit log without query strings/bodies/credentials |
| WS end-to-end through gateway | Done | test proves `POST /prompt` → `executing node 7` → `node null` → `/history` outputs → `/view` PNG magic bytes |
| Upstream-auth failure surfacing | Done | gateway with wrong credentials relays upstream 401; missing credentials fail health checks loudly |
| Control plane (`/gateway/v1/status`) | Done | Bearer-token guarded; reports gateway version/uptime + upstream reachability/latency |
| Integration test suite (`tests/integration.test.ts`) | **9/9 pass** | covers allowlist deny (403), method-path mismatch (403), all catalog reads, full generation lifecycle, control-plane auth |
| Baseline workflow templates | Done | `workflows/moss-api.json`, `workflows/anima-turbo-v1.1-api.json` — structure validated (`bun tools/validate-moss-workflow.mjs`); content derived from the reference notebook's `build_workflow()`; **NOT yet verified against a live ComfyUI** |
| Extension shell (Spindle) | Done | `spindle.json` (permissions `cors_proxy`, `ui_panels`; `minimum_lumiverse_version: 1.3.0`), `src/backend.ts` (status RPC via host cors proxy → gateway `/gateway/v1/status` + upstream `/system_stats` read; no provisioning calls), `src/frontend.ts` (status panel; save gateway URL; probe), `bun run build` → `dist/{backend,frontend}.js` |

## What is NOT done (honest status)

- **Native generation from the real Lumiverse Space to a warm worker** — blocked on: (a) user approval to change the Space (gateway sidecar or fork route), (b) the Space running the gateway, (c) authorizing a test against the user's own Colab worker. The ngrok tunnel remains user-managed and interactive.
- **Native workflow import test** (MOSS + Anima into the actual Lumiverse UI) — requires the same live Lumiverse access; the templates are staged for it (MOSS-first, Anima second).
- **Native LoRA stack test** (off/0.6/1.0/two-LoRA, fixed seed) — M3 scope; requires live ComfyUI.
- **Live ngrok Basic Auth round-trip from outside the notebook** — the prior user test was Colab→Colab; a Space→ngrok test has never been run.
- **`/system_stats` retry/backoff on startup (ngrok 404/502 warmup), epoch registration, single-flight provisioning** — M4 scope; the gateway currently fails fast with `upstream_unreachable/timeout` by design (no hidden reprovisioning).

## Local verification commands

```bash
# terminal 1
MOCK_PORT=18188 bun tests/mock-comfyui/server.ts
# terminal 2
GATEWAY_PORT=8189 GATEWAY_UPSTREAM=http://127.0.0.1:18188 \
  GATEWAY_BASIC_AUTH=lumiverse:test-secret \
  GATEWAY_CONTROL_TOKEN=dev-token \
  bun host-gateway/gateway.ts
# terminal 3
curl -u anything http://127.0.0.1:8189/system_stats   # gateway injects its own creds upstream
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:8189/gateway/v1/status
```

Integration tests: `bun test`.

## Wiring into Lumiverse (manual, for your review — do not apply without approval)

1. Run the gateway on the Space host loopback (`127.0.0.1:8189`) with `GATEWAY_UPSTREAM=https://<ngrok-domain>` and `GATEWAY_BASIC_AUTH=<user>:<pass>` in the Space's env (never in the Lumiverse UI, never in the profile URL).
2. In Lumiverse → Settings → Image Generation → add ComfyUI connection, base URL `http://127.0.0.1:8189`.
3. Import `workflows/moss-api.json`; confirm mappings (prompt, negative, steps/CFG/sampler/scheduler/seed/width/height → nodes 7/6; unet 1; clip 2; vae 3); negative ≈ second CLIPTextEncode.
4. Repeat with `workflows/anima-turbo-v1.1-api.json`.
5. Use LoRA Studio for weights: map `lora_name`/`lora_strength_model` only (see ADR-001 §5); model-only loader nodes are embedded in the MOSS graph only if you add them — see §7.2 PRD.
6. Test button must return HTTP 200; generation must save to the native gallery with the native seed; progress/cancel behave as usual.

## Risks / notes

- Windows leaves orphaned mock/gateway processes if a test run is interrupted; ports for tests are randomized, and manual strays can be killed safely.
- The gateway's WS client relies on Bun's non-standard `headers` option for the upstream WebSocket handshake; verified working against the mock. Re-verify against real ngrok (M1 live test).
- v1.3.0's inference scheduler (opt-in) will queue native generations per loopback origin; orthogonal to this design, but note the interactive-priority behavior if many images are queued.
