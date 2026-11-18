# Hugging Face Space deployment — walkthrough

> Deployment target: private HF Space with persistent `/app/data` and a custom Dockerfile (user-managed).
> The gateway runs **inside the same container, loopback-only** — HF only publishes the app's public port; the gateway port (8189) is **not reachable from the internet**.
> **The Space's Dockerfile is private and deliberately not in this repository** (owner decision, 2026-11-17). The blocks to add are in `docs/space-gateway-patch.md`. Nothing else about the Space is documented here.
> No changes to upstream Lumiverse are made. Everything here is additive and reviewable.

## What gets installed

| Component | How | Notes |
|---|---|---|
| Remote GPU Manager extension | Lumiverse UI: install from GitHub URL `https://github.com/WanderingMonk8/remote_gpu_manager` | default branch carries M1 |
| Host gateway (`dist-host/gateway.mjs`) | Cloned into the Space image at build time (patch block); started before Lumiverse | needs Bun (present in image), no npm deps |
| Gateway env (secrets) | HF Space → Settings → Variables and secrets | never in the Dockerfile, never in git |
| Lumiverse ComfyUI connection | UI: base URL `http://127.0.0.1:8189`; **do not** set any auth fields | native provider has none; auth is injected by the gateway upstream |
| Workflows | Import `workflows/moss-api.json` (+ Anima) via Configure Generation | field mappings auto-detected for prompt/steps/CFG/sampler/scheduler/seed; width/height (EmptyFlux2LatentImage / EmptyLatentImage) and UNET/CLIP/VAE need manual mapping |

## Applying the patch

See `docs/space-gateway-patch.md` for the exact blocks and where they go. Order of operations:

1. Add the gateway build block to your Dockerfile (clone `remote_gpu_manager`, verify `dist-host/gateway.mjs`, `ENV GATEWAY_PORT=8189`).
2. Add the `start_rgm_gateway()` function, the `start_rgm_gateway || true` call, the shutdown-handler kill/wait block, and the `grep -Fq` build guard.
3. Bash-syntax-check your edited startup script (`bash -n`).
4. Commit/push your Space; watch the build and runtime logs for `[rgm-gateway] Ready`.

## Gateway environment (set as HF Space secrets)

| Name | Example | Meaning |
|---|---|---|
| `GATEWAY_PORT` | `8189` | optional; default 8189 |
| `GATEWAY_UPSTREAM` | `https://<your-tunnel>.ngrok-free.app` | the ngrok domain of the **warm worker** (static domain strongly recommended) |
| `GATEWAY_BASIC_AUTH` | `user:password` | matches the notebook's tunnel Basic Auth (never the ngrok authtoken) |
| `GATEWAY_SKIP_BROWSER_WARNING` | `1` | drops ngrok's interstitial for API calls |
| `GATEWAY_CONTROL_TOKEN` | 32+ random chars | enables `/gateway/v1/status` for the extension panel; Bearer token |

## Verification (from inside the Space — not public)

```sh
curl -s http://127.0.0.1:8189/system_stats
# → upstream 401/200 tells you auth wiring (401 = wrong/missing upstream creds; 200 = OK)
curl -H "Authorization: Bearer $GATEWAY_CONTROL_TOKEN" http://127.0.0.1:8189/gateway/v1/status
# → {"gateway":{"version":"0.1.0-m1",...},"upstream":{"reachable":true,...}}
```

From your browser → Lumiverse → Settings → Image Generation → ComfyUI connection → **Test** → expect HTTP 200; then run a small generation in a chat; confirm the image lands in the gallery and the seed matches.

If `GATEWAY_UPSTREAM` is unset at deploy time, the gateway starts in "stay down" mode and Lumiverse starts normally — wire the worker first, then set the secret and restart.

## Rollback

Delete the connection in Lumiverse → revert the Space Dockerfile to previous commit → restart. The extension can be disabled/uninstalled from the Extensions panel; `data/` on the Space stays intact.

## Not covered here (deliberately)

- No unattended worker provisioning (owner decision 2026-11-17: manual-only).
- No changes to Lumiverse source; no fork required for M1.
- The Colab worker remains user-started; Lumiverse never starts it.
