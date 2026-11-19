#!/usr/bin/env python3
"""
LumiverSE Vast.ai worker bootstrap (v2 — disk-optimized manifest).

Runs on the vast.ai host via the instance `onstart` hook, ALONGSIDE the image
entrypoint (yanwk/comfyui-boot:cu130-slim starts ComfyUI normally). Normal VRAM
mode is the default — no --lowvram/--novram flags are passed anywhere.

Idempotent: safe to re-run on every boot. Per-file: skips downloads when the
target file already exists (>100 MB). A marker file ends the work early.

Downloads (≈28 GB):
  Anima (circlestone-labs/Anima, split_files/):
    diffusion_models: anima-turbo-v1.1, anima-aesthetic-v1.1            (4.18 GB each)
    text_encoders:    qwen_3_06b_base.safetensors (1.19 GB, CLIP type stable_diffusion)
    vae:              qwen_image_vae.safetensors  (0.25 GB)
  MOSS (Comfy-Org/MOSS-Image):
    diffusion_models: moss_image_sft_int8_convrot.safetensors,
                      moss_image_base_int8_convrot.safetensors  (5.41 GB each)
    text_encoders:    qwen3.5_9b_w4a8_gptq.safetensors           (7.34 GB, CLIP type moss_image)
    vae:              flux2-vae_small.safetensors                (0.25 GB)
  Adapter (ElectronGirl/anima-ref-adapter):
    anima_ref_adapter_v2_r64.safetensors into loras/  (0.18 GB)
  Custom node (ArcAnima/ComfyUI-Anima-Ref-Adapter) into custom_nodes/ (reference-image workflows).

Prints BOOTSTRAP_COMPLETE on success (that's the token LumiverSE polls for via the
vast.ai logs API) or BOOTSTRAP_FAILED <reason> on failure. Exit code 0 either way —
ComfyUI must stay up even if downloads fail.
"""

import os
import sys
import time
import shutil
import subprocess
from pathlib import Path

MARKER = Path("/root/.lumiverse-bootstrap-v2.complete")
MODELS = Path("/root/ComfyUI/models")
CACHE_DIR = Path("/root/.cache/lumiverse-bootstrap")
CUSTOM_NODES = Path("/root/ComfyUI/custom_nodes")
ADAPTER_REPO = "https://github.com/ArcAnima/ComfyUI-Anima-Ref-Adapter.git"
ADAPTER_NODE_DIR = CUSTOM_NODES / "ComfyUI-Anima-Ref-Adapter"
MIN_SIZE = 100_000_000


def log(msg: str) -> None:
    print(f"[lumiverse-bootstrap] {msg}", flush=True)


def run(cmd, **kw):
    log(f"$ {' '.join(str(c) for c in cmd)}")
    return subprocess.run([str(c) for c in cmd], check=False, **kw)


def ensure_pip():
    if run([sys.executable, "-m", "pip", "install", "-q", "huggingface_hub>=0.25", "safetensors"]).returncode != 0:
        log("pip install of huggingface_hub failed; continuing (it may already exist)")


def fetch(repo: str, repo_path: str, dest: Path) -> bool:
    """Download repo_path from repo to dest (hardlink from HF cache; falls back to copy). Idempotent."""
    if dest.exists() and dest.stat().st_size > MIN_SIZE:
        log(f"present, skipping: {dest.name}")
        return True
    try:
        from huggingface_hub import hf_hub_download
        dest.parent.mkdir(parents=True, exist_ok=True)
        storage = CACHE_DIR / repo.replace("/", "--")
        f = Path(hf_hub_download(repo_id=repo, filename=repo_path, local_dir=str(storage)))
        if dest.exists():
            dest.unlink()
        try:
            os.link(f, dest)
        except OSError:
            if shutil.disk_usage(dest.parent).free < f.stat().st_size + 512 * 1024 * 1024:
                log(f"NOT ENOUGH DISK for {dest.name}")
                return False
            shutil.copy2(f, dest)
        log(f"ready: {dest.name} ({dest.stat().st_size / 1024**3:.2f} GiB)")
        return True
    except Exception as e:  # noqa: BLE001 — report and continue with the rest
        log(f"FAILED {repo}/{repo_path}: {e}")
        return False


def main() -> int:
    t0 = time.time()
    if MARKER.exists():
        log("marker present, nothing to do")
        print("BOOTSTRAP_COMPLETE", flush=True)
        return 0

    log("start (v2 disk-optimized, normal VRAM)")
    for d in ("diffusion_models", "text_encoders", "vae", "loras"):
        (MODELS / d).mkdir(parents=True, exist_ok=True)

    ensure_pip()

    # Custom node for the Anima reference-image adapter (notebook: INSTALL_ANIMA_ADAPTER=True)
    if not ADAPTER_NODE_DIR.exists():
        rc = run(["git", "clone", "--depth", "1", ADAPTER_REPO, str(ADAPTER_NODE_DIR)]).returncode
        log("adapter node cloned" if rc == 0 else "WARNING: adapter node clone failed (base flows unaffected)")
    else:
        log("adapter node present, skipping clone")

    ok = True
    ANIMA = "circlestone-labs/Anima"
    for ckpt in [
        "anima-turbo-v1.1.safetensors", "anima-aesthetic-v1.1.safetensors",
    ]:
        ok &= fetch(ANIMA, f"split_files/diffusion_models/{ckpt}", MODELS / "diffusion_models" / ckpt)
    ok &= fetch(ANIMA, "split_files/text_encoders/qwen_3_06b_base.safetensors", MODELS / "text_encoders" / "qwen_3_06b_base.safetensors")
    ok &= fetch(ANIMA, "split_files/vae/qwen_image_vae.safetensors", MODELS / "vae" / "qwen_image_vae.safetensors")

    MOSS = "Comfy-Org/MOSS-Image"
    for ckpt in ["moss_image_sft_int8_convrot.safetensors", "moss_image_base_int8_convrot.safetensors"]:
        ok &= fetch(MOSS, f"diffusion_models/{ckpt}", MODELS / "diffusion_models" / ckpt)
    ok &= fetch(MOSS, "text_encoders/qwen3.5_9b_w4a8_gptq.safetensors", MODELS / "text_encoders" / "qwen3.5_9b_w4a8_gptq.safetensors")
    ok &= fetch(MOSS, "vae/flux2-vae_small.safetensors", MODELS / "vae" / "flux2-vae_small.safetensors")

    ok &= fetch("ElectronGirl/anima-ref-adapter", "anima_ref_adapter_v2_r64.safetensors",
                MODELS / "loras" / "anima_ref_adapter_v2_r64.safetensors")

    if ok:
        MARKER.write_text(f"completed in {time.time() - t0:.0f}s\n")
        log(f"all assets ready in {time.time() - t0:.0f}s")
        print("BOOTSTRAP_COMPLETE", flush=True)
    else:
        log("one or more assets failed; ComfyUI stays up, but some models are missing")
        print("BOOTSTRAP_FAILED partial-download", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        log(f"fatal: {e}")
        print(f"BOOTSTRAP_FAILED {e}", flush=True)
        sys.exit(0)
