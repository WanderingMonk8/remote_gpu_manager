# Remote GPU Manager — Lumiverse Spindle extension (M1 workspace)

> **Status:** M1 (warm connectivity) — local gateway + mock verified; live Lumiverse/Colab wiring pending owner approval.
> **Source of truth:** `Lumiverse_Remote_GPU_Manager_PRD_v1.1.md` (start with §1, §10, §15).

## Layout

```
spindle.json, package.json, tsconfig.json   # extension manifest & build (Spindle)
src/backend.ts                              # status RPC via host CORS proxy (M1: no provisioning)
src/frontend.ts                             # status panel
host-gateway/gateway.ts                     # loopback authenticated ComfyUI reverse proxy
tests/mock-comfyui/server.ts                # mock ComfyUI worker (upstream Basic Auth)
tests/integration.test.ts                   # gateway + mock integration tests (bun test)
tools/generate-moss-workflow.mjs            # emits workflows/*.json from the reference notebook graph
tools/validate-moss-workflow.mjs            # structural validation of workflow templates
tools/colab-eligibility-check.py            # read-only Colab eligibility probe (owner-run)
workflows/                                  # verified-structure baseline API workflows
docs/                                       # ADRs, M0 report, M1 record
Unified_MOSS_Anima_Colab_Studio.ipynb       # reference worker notebook (user artifact)
```

## Develop

```bash
bun install
bun test                  # integration tests (mock + gateway)
bun run build             # extension -> dist/
bun run mock:comfy        # mock worker on :8188 (upstream Basic Auth)
bun run gateway           # gateway on 127.0.0.1:8189 (needs GATEWAY_UPSTREAM, GATEWAY_BASIC_AUTH)
```

## Deploy / wire into Lumiverse

See `docs/m1-warm-connectivity.md`. Do **not** point a production Lumiverse profile at an unauthenticated worker; the native ComfyUI provider cannot send auth headers — the gateway adds them server-side. Deployment to the live HF Space requires explicit owner approval.

## Security

- No credentials in this repo, URLs, logs, prompts or workflow JSON.
- Gateway binds `127.0.0.1` only; upstream credentials live in the process environment.
- The extension never handles the upstream secret; it reads a token-guarded loopback status endpoint.
- Colab Free is **manual interactive mode only** (ADR-002). No provisioning automation exists in this codebase yet; nothing here allocates cloud compute.
