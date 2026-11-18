# Hugging Face Space deployment — walkthrough (proposed edits staged)

> Deployment target: private HF Space, persistent `/app/data`, custom Dockerfile (`oven/bun:1-slim`, Lumiverse `staging` clone), user-reported v1.3.0.
> Gateway runs **inside the same container, loopback-only** — HF only publishes the app port (7860); the gateway port (8189) is not reachable from the internet.
> **Concrete proposed Dockerfile:** `docs/space-proposal/Dockerfile.proposed` — based on the user's uploaded Dockerfile, bash-syntax-verified. It adds exactly the blocks in the diff below. Nothing else is modified (no changes to Lumiverse, SearXNG, CLIProxyAPI, SQLite backup logic, or the shutdown ordering).
> No changes to upstream Lumiverse are made. Everything here is additive and reviewable.

## Build blocks to add (see the full proposal file for exact placement)

1. After the frontend `bun run build` stage, before the SearXNG block: `ARG RGM_BRANCH=main`, `ADD` the GitHub commit JSON (cache-bust), `git clone --depth 1` the extension repo into `/opt/remote-gpu-manager`, `test -f /opt/remote-gpu-manager/dist-host/gateway.mjs`, `ENV GATEWAY_PORT=8189`.
2. In `start-lumiverse.sh`, after `start_cliproxy() { … }`: `start_rgm_gateway()` — starts `bun run /opt/remote-gpu-manager/dist-host/gateway.mjs &`, waits up to 30 s for **any** non-`000` HTTP response from the loopback gateway (even `502`, which means "worker down", not "gateway broken"), logs status, and degrades gracefully if unset (`GATEWAY_UPSTREAM` absent → gateway stays down, Lumiverse starts anyway).
3. After `start_searxng || true` / `start_cliproxy || true`: `start_rgm_gateway || true`.
4. In `shutdown_handler()`: kill `RGM_GATEWAY_PID` and `wait` for it (same pattern as SearXNG/CLIProxyAPI).
5. In the trailing `grep -Fq` build guards: `grep -Fq 'start_rgm_gateway' …`.

Diff size: ~110 added lines, zero removed lines, zero behavior change when `GATEWAY_UPSTREAM` is unset.

## What gets installed

| Component | How | Notes |
|---|---|---|
| Remote GPU Manager extension | Lumiverse UI: install from GitHub URL `https://github.com/WanderingMonk8/remote_gpu_manager` | default branch now carries M1 (main @ ≥800b026) |
| Host gateway (`dist-host/gateway.mjs`) | Copied into the Space image at build time; starts before Lumiverse | needs Bun (present in image), no npm deps |
| Gateway env (secrets) | HF Space → Settings → Variables and secrets | never in the Dockerfile, never in git |
| Lumiverse ComfyUI connection | UI: base URL `http://127.0.0.1:8189`; **do not** set any auth fields | native provider has none; auth is injected by the gateway upstream |
| Workflows | Import `workflows/moss-api.json` (+ Anima) via Configure Generation | field mappings auto-detected for prompt/steps/CFG/sampler/scheduler/seed; width/height (EmptyFlux2LatentImage / EmptyLatentImage) and UNET/CLIP/VAE need manual mapping |

## Gateway environment (set as HF Space secrets)

| Name | Example | Meaning |
|---|---|---|
| `GATEWAY_PORT` | `8189` | optional; default 8189 |
| `GATEWAY_UPSTREAM` | `https://<your-tunnel>.ngrok-free.app` | the ngrok domain of the **warm worker** (static domain strongly recommended) |
| `GATEWAY_BASIC_AUTH` | `user:password` | matches the notebook's tunnel Basic Auth (never the ngrok authtoken) |
| `GATEWAY_SKIP_BROWSER_WARNING` | `1` | drops ngrok's interstitial for API calls |
| `GATEWAY_CONTROL_TOKEN` | 32+ random chars | enables `/gateway/v1/status` for the extension panel; Bearer token |

## Runtime layout inside the container

One CMD only — the Dockerfile must start two processes via a small wrapper script: gateway in background, then exec Lumiverse (so Lumiverse receives SIGTERM from HF on restart). Proposed wrapper (review before merge):

```sh
#!/bin/sh
set -e
: "${GATEWAY_UPSTREAM:?set GATEWAY_UPSTREAM secret}"
bun run /opt/remote-gpu-manager/gateway.mjs &
GATEWAY_PID=$!
trap 'kill $GATEWAY_PID 2>/dev/null' TERM INT
exec bun run /app/src/index.ts
```

(Exact paths/names follow the user's Dockerfile — see TODO after Dockerfile upload.)

## Verification (from inside the Space — not public)

```sh
curl -s http://127.0.0.1:8189/system_stats
# → upstream 401/200 tells you auth wiring (401 = wrong/missing upstream creds; 200 = OK)
curl -H "Authorization: Bearer $GATEWAY_CONTROL_TOKEN" http://127.0.0.1:8189/gateway/v1/status
# → {"gateway":{"version":"0.1.0-m1",...},"upstream":{"reachable":true,...}}
```

From your browser → Lumiverse → Settings → Image Generation → ComfyUI connection → **Test** → expect HTTP 200; then run a small generation in a chat; confirm the image lands in the gallery and the seed matches.

## Rollback

Delete the connection in Lumiverse → revert the Space Dockerfile to previous commit → restart. The extension can be disabled/uninstalled from the Extensions panel; `data/` on the Space stays intact.

## Not covered here (deliberately)

- No unattended worker provisioning (owner decision 2026-11-17: manual-only).
- No changes to Lumiverse source; no fork required for M1.
- The Colab worker remains user-started (notebook §1–13); Lumiverse never starts it.
