# LumiverSE Vast.ai worker

Goal: a functioning Vast.ai GPU instance with the Anima + MOSS model families loaded
in ComfyUI, small enough that storage stays cheap. Normal VRAM mode. No tunnel —
the Space-side gateway is the transport (ADR-001/ADR-003).

## Bootstrap (`bootstrap.py`)

Runs on the vast.ai host via the instance `onstart` hook alongside the image
entrypoint (`yanwk/comfyui-boot:cu126-slim` — ComfyUI starts normally on
`0.0.0.0:8188`). Idempotent; a marker file (`/root/.lumiverse-bootstrap-v2.complete`)
ends early. Failures print `BOOTSTRAP_FAILED <reason>` but ComfyUI stays up.
Launch it from the **Full worker — Anima + MOSS (≈28 GB)** boot profile in the
extension's deploy panel (default disk for this profile: 60 GB).

## Manifest (v2 — disk-optimized, ≈28 GB)

| File | Repo | Size | Target |
|---|---|---|---|
| anima-turbo-v1.1.safetensors | circlestone-labs/Anima (`split_files/diffusion_models/`) | 4.18 GB | `models/diffusion_models/` — 10-step distilled, native workflow target |
| anima-aesthetic-v1.1.safetensors | circlestone-labs/Anima (`split_files/diffusion_models/`) | 4.18 GB | `models/diffusion_models/` — 30-step quality |
| qwen_3_06b_base.safetensors | circlestone-labs/Anima (`split_files/text_encoders/`) | 1.19 GB | `models/text_encoders/` — CLIP type `stable_diffusion` |
| qwen_image_vae.safetensors | circlestone-labs/Anima (`split_files/vae/`) | 0.25 GB | `models/vae/` |
| moss_image_sft_int8_convrot.safetensors | Comfy-Org/MOSS-Image (`diffusion_models/`) | 5.41 GB | `models/diffusion_models/` |
| moss_image_base_int8_convrot.safetensors | Comfy-Org/MOSS-Image (`diffusion_models/`) | 5.41 GB | `models/diffusion_models/` |
| qwen3.5_9b_w4a8_gptq.safetensors | Comfy-Org/MOSS-Image (`text_encoders/`) | 7.34 GB | `models/text_encoders/` — CLIP type `moss_image` (25 steps, CFG 2.5) |
| flux2-vae_small.safetensors | Comfy-Org/MOSS-Image (`vae/`) | 0.25 GB | `models/vae/` |
| anima_ref_adapter_v2_r64.safetensors | ElectronGirl/anima-ref-adapter | 0.18 GB | `models/loras/` |
| ComfyUI-Anima-Ref-Adapter (git clone) | ArcAnima/ComfyUI-Anima-Ref-Adapter | tiny | `custom_nodes/` — reference-image workflows |

Dropped since v1: anima-turbo-v1.0, anima-base-v1.0, anima-aesthetic-v1.0(+b),
MOSS bf16 weights (SFT/Base), the 9.7–19.3 GB bf16/`_int8_convrot` encoders and
`flux2-vae.safetensors`, and all Anima preview checkpoints. To expand the
manifest, edit the file list in `bootstrap.py` directly — deliberately explicit.

## Verify a live instance

Use the **Logs** button in the extension (My instances). Poll until you see
`BOOTSTRAP_COMPLETE` (or `BOOTSTRAP_FAILED <reason>`). Then ComfyUI answers
`/system_stats`; models are under its Model Library (refresh the page).
The native Lumiverse generation path is not wired yet — that's the
Space-side gateway transport milestone (docs/migration-vast.md).
