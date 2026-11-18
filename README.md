# Remote GPU Manager — Lumiverse Spindle extension (V2, Vast.ai-first)

> **Status:** Vast.ai-first migration. V0 audit done; V1 (mock-first controller/provider) in progress; V2 (worker + Vast) blocked on owner authorization.
> **Source of truth:** `PRD.md` (v2.0). Migrations: `docs/migration-vast.md`, `docs/adr/`.

A Lumiverse Spindle extension that makes **Vast.ai on-demand GPU instances** feel like native image generation inside Lumiverse: a user picks a model + LoRA preset in Lumiverse's native UI and presses the normal generate button — the manager resumes or rents exactly one authorized instance, stages the model, connects securely, lets native generation run, persists natively, and idles down after real inactivity.

Lumiverse remains the authoritative image frontend (Prompt Studio, LoRA Studio, character bindings, gallery, scene pipeline). This extension is an **infrastructure manager**, not an image generator.

## Layout

```
PRD.md                         # v2.0 (authoritative) — v1.1 archived in docs/archive/
reference/                     # old Colab notebook, eligibility probe, fixtures (experimental)
docs/migration-vast.md         # reuse map, unknowns, test status
docs/adr/                      # 001 native gateway, 002 (superseded), 003 Vast lifecycle/transport, 004 LoRA resolution
docs/legacy/colab/             # historical M0/M1 records (not "current direction")
host-gateway/                  # loopback proxy used for the Space↔worker seam (retry, allowlist, WS)
src/backend.ts, src/frontend.ts  # Spindle extension shell (status drawer)
src/providers/vast/            # typed Vast API client + mock fixtures (V1)
src/controller/                # state machine, leases, single-flight, reconcile (V1)
tests/                         # mock ComfyUI worker + integration tests
workflows/                     # baseline MOSS + Anima API workflow templates
worker/                        # pinned worker bootstrap (V4)
```

## Develop (no credentials required)

```bash
bun install
bun test
bun run build                # extension → dist/
bun run gateway              # Space-side relay (loopback 127.0.0.1:8189)
bun run mock:comfy           # mock ComfyUI worker on :8188 (upstream Basic Auth)
```

Everything above runs against mocks. **No Vast API key is needed for tests.**

## Deploy / verify (blocked until owner authorizes)

The next milestone (V2) requires an explicit, capped authorization to rent a GPU (price cap, instance class, disk, duration) before any paid call — per `docs/adr/adr-003-vast-lifecycle-transport.md`. Nothing is deployed or rented without that approval.

## Security

- No credentials in the repo, URLs, workflow JSON, logs or frontend state.
- Gateway binds loopback-only; upstream auth is injected server-side.
- Secrets (Vast key, per-instance credential, Civitai/HF) live in documented host stores only, never in profile exports or logs.
- No unattended mode without an independently verified instance-side watchdog.
