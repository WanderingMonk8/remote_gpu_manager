# LumiverSE Vast.ai worker

Goal: a functioning Vast.ai GPU instance with ONLY the model families the user selected,
in ComfyUI, normal VRAM, small enough that storage stays cheap. No tunnel —
the Space-side gateway is the transport (ADR-001/ADR-003).

## Bootstrap (`bootstrap.py`, v3 — selective)

Runs on the vast.ai host via the instance `onstart` hook alongside the image
entrypoint (`yanwk/comfyui-boot:cu126-slim` — ComfyUI starts normally on `0.0.0.0:8188`).
Idempotent; per-file skips when target exists (>100 MB). Prints `BOOTSTRAP_COMPLETE`
(marker `/root/.lumiverse-bootstrap-v3.complete`) or `BOOTSTRAP_FAILED <reason>`;
ComfyUI stays up regardless.

**Model selection** — the extension's deploy panel passes env `lumiverse_models`
(comma-separated registry IDs, e.g. `anima-turbo-1.1,moss-sft-int8`). The worker
records the deployed set in `/root/.lumiverse-selected-models.txt`. Default (no env):
the v2 manifest (turbo-1.1 + aesthetic-v1.1 + MOSS INT8 SFT + Base + adapter). Registry:

| ID | File | GB |
|---|---|---|
| anima-turbo-1.1 / anima-turbo-1.0 / anima-base-1.0 | Anima Turbo v1.1 / v1.0 / Base v1.0 | 4.2 ea |
| anima-aesthetic-1.1 / anima-aesthetic-1.0 / anima-aesthetic-1.0b | Anima Aesthetic v1.1 / 1.0 / 1.0b | 4.2 ea |
| anima-preview / anima-preview2 / anima-preview3-base | Anima preview checkpoints | 4.2 ea |
| moss-sft-int8 / moss-base-int8 | MOSS INT8 convrot | 5.4 ea |
| moss-sft-bf16 / moss-base-bf16 | MOSS bf16 (needs bf16 encoder) | 10.2 ea |
| adapter-ref | Anima reference-image adapter LoRA | 0.2 |

Dependencies inferred: Anima picks → qwen encoder (1.2 GB) + qwen_image_vae (0.25 GB).
MOSS INT8 → qwen3.5_9b_w4a8_gptq (7.3 GB) + flux2-vae_small. MOSS bf16 → qwen3.5_9b_bf16
(19.3 GB) + flux2-vae.

## Active-model switching — required contract (phase 2)

A future instance manager endpoint will let the Space set the *active* model via the worker itself:

- The worker (and ONLY the worker) is the source of truth for what can be made active.
  The list of switchable models = the deployed set written in `/root/.lumiverse-selected-models.txt`
  intersected with files actually present in `models/diffusion_models/`.
- The Space asks the worker for its model list at deploy/open time; the UI renders only
  those as switch targets. Arbitrary model names are never accepted.
- Switching = atomic symlink `models/diffusion_models/active.safetensors` → chosen file.
  Lumiverse submits workflows against `active.safetensors`; the worker owns the resolution.
- The Space never calls ComfyUI's generation endpoint to switch; switching is a control-plane
  operation only — it never touches prompt-graph execution.

Model files must remain intact between switches; switching only repoints the symlink.
