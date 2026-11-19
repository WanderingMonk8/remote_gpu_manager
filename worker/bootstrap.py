#!/usr/bin/env python3
"""
LumiverSE Vast.ai worker bootstrap (v3 — selective, registry-driven).

Runs on the vast.ai host via the instance `onstart` hook, ALONGSIDE the image
entrypoint (yanwk/comfyui-boot:cu126-slim starts ComfyUI normally). Normal VRAM
mode. Idempotent; per-file skips when target exists (>100 MB); a marker file ends early.

Model selection: the deploy passes env `lumiverse_models` (comma-separated registry IDs,
e.g. "anima-turbo-1.1,moss-sft-int8"). Selection is also recorded in
/root/.lumiverse-selected-models.txt on success.
  - Anima picks pull anima encoder+VAE automatically.
  - MOSS INT8 picks pull qwen3.5_9b_w4a8_gptq encoder + flux2-vae_small.
  - MOSS bf16 picks pull qwen3.5_9b_bf16 (19.3 GB!) + flux2-vae.
  - Default (no/empty env) = v2 manifest: turbo-1.1, aesthetic-v1.1, moss-sft-int8,
    moss-base-int8, adapter. Missing env never surprise-downloads 28+ GB blindly.

Prints BOOTSTRAP_COMPLETE on full success (the token the Space polls via vast logs API),
or BOOTSTRAP_FAILED <reason>. ComfyUI stays up regardless.
"""

import os
import sys
import time
import shutil
import subprocess
from pathlib import Path

MARKER = Path("/root/.lumiverse-bootstrap-v3.complete")
SELECT_FILE = Path("/root/.lumiverse-selected-models.txt")
MODELS = Path("/root/ComfyUI/models")
CACHE_DIR = Path("/root/.cache/lumiverse-bootstrap")
CUSTOM_NODES = Path("/root/ComfyUI/custom_nodes")
ADAPTER_NODE_DIR = CUSTOM_NODES / "ComfyUI-Anima-Ref-Adapter"
ADAPTER_REPO = "https://github.com/ArcAnima/ComfyUI-Anima-Ref-Adapter.git"
MIN_SIZE = 100_000_000

# (id, label, repo, repo_path, category, size_bytes)
REGISTRY = [
    ("anima-turbo-1.1",     "Anima Turbo v1.1 (10 steps)",          "circlestone-labs/Anima", "split_files/diffusion_models/anima-turbo-v1.1.safetensors",      "diffusion_models"),
    ("anima-turbo-1.0",     "Anima Turbo v1.0",                     "circlestone-labs/Anima", "split_files/diffusion_models/anima-turbo-v1.0.safetensors",      "diffusion_models"),
    ("anima-base-1.0",      "Anima Base v1.0",                      "circlestone-labs/Anima", "split_files/diffusion_models/anima-base-v1.0.safetensors",       "diffusion_models"),
    ("anima-aesthetic-1.1", "Anima Aesthetic v1.1 (30 steps)",      "circlestone-labs/Anima", "split_files/diffusion_models/anima-aesthetic-v1.1.safetensors",  "diffusion_models"),
    ("anima-aesthetic-1.0", "Anima Aesthetic v1.0",                 "circlestone-labs/Anima", "split_files/diffusion_models/anima-aesthetic-v1.0.safetensors",  "diffusion_models"),
    ("anima-aesthetic-1.0b","Anima Aesthetic v1.0b",                "circlestone-labs/Anima", "split_files/diffusion_models/anima-aesthetic-v1.0b.safetensors", "diffusion_models"),
    ("anima-preview",       "Anima Preview",                        "circlestone-labs/Anima", "split_files/diffusion_models/anima-preview.safetensors",        "diffusion_models"),
    ("anima-preview2",      "Anima Preview 2",                      "circlestone-labs/Anima", "split_files/diffusion_models/anima-preview2.safetensors",       "diffusion_models"),
    ("anima-preview3-base", "Anima Preview 3 Base",                 "circlestone-labs/Anima", "split_files/diffusion_models/anima-preview3-base.safetensors",  "diffusion_models"),
    ("moss-sft-int8",       "MOSS SFT INT8",                        "Comfy-Org/MOSS-Image",   "diffusion_models/moss_image_sft_int8_convrot.safetensors",        "diffusion_models"),
    ("moss-base-int8",      "MOSS Base INT8",                       "Comfy-Org/MOSS-Image",   "diffusion_models/moss_image_base_int8_convrot.safetensors",       "diffusion_models"),
    ("moss-sft-bf16",       "MOSS SFT bf16 (+19.3 GB bf16 encoder)","Comfy-Org/MOSS-Image",   "diffusion_models/moss_image_sft_bf16.safetensors",                "diffusion_models"),
    ("moss-base-bf16",      "MOSS Base bf16 (+19.3 GB bf16 encoder)","Comfy-Org/MOSS-Image",   "diffusion_models/moss_image_base_bf16.safetensors",               "diffusion_models"),
    ("adapter-ref",         "Anima reference-image adapter",        "ElectronGirl/anima-ref-adapter", "anima_ref_adapter_v2_r64.safetensors",         "loras"),
]
DEFAULT_SELECTION = "anima-turbo-1.1,anima-aesthetic-1.1,moss-sft-int8,moss-base-int8,adapter-ref"
KNOWN_IDS = {entry[0] for entry in REGISTRY}


def log(msg: str) -> None:
    print(f"[lumiverse-bootstrap] {msg}", flush=True)


def run(cmd, cwd=None):
    log(f"$ {' '.join(str(c) for c in cmd)}")
    return subprocess.run([str(c) for c in cmd], check=False, cwd=cwd)


def parse_selection() -> list[str]:
    raw = (os.environ.get("lumiverse_models") or "").strip()
    ids = [tok.strip() for tok in raw.split(",") if tok.strip()] if raw else DEFAULT_SELECTION.split(",")
    ids = [i for i in dict.fromkeys(ids) if i in KNOWN_IDS]
    if not ids:
        log("empty/unknown lumiverse_models env — refusing to download nothing; falling back to default manifest")
        ids = DEFAULT_SELECTION.split(",")
    return ids


def with_dependencies(ids: list[str]) -> list[tuple[str, str, str, str, str]]:
    """Expand selection with encoder/VAE deps. Returns list of (repo, repo_path, category, why)."""
    out: list[tuple[str, str, str, str, str]] = []
    want_anima = any(i.startswith("anima-") for i in ids)
    want_moss_int8 = any(i in ("moss-sft-int8", "moss-base-int8") for i in ids)
    want_moss_bf16 = any(i in ("moss-sft-bf16", "moss-base-bf16") for i in ids)
    if want_anima:
        out.append(("circlestone-labs/Anima", "split_files/text_encoders/qwen_3_06b_base.safetensors", "text_encoders", "anima encoder"))
        out.append(("circlestone-labs/Anima", "split_files/vae/qwen_image_vae.safetensors", "vae", "anima VAE"))
    if want_moss_int8:
        out.append(("Comfy-Org/MOSS-Image", "text_encoders/qwen3.5_9b_w4a8_gptq.safetensors", "text_encoders", "MOSS INT8 encoder"))
        out.append(("Comfy-Org/MOSS-Image", "vae/flux2-vae_small.safetensors", "vae", "MOSS VAE"))
    if want_moss_bf16:
        out.append(("Comfy-Org/MOSS-Image", "text_encoders/qwen3.5_9b_bf16.safetensors", "text_encoders", "MOSS bf16 encoder"))
        out.append(("Comfy-Org/MOSS-Image", "vae/flux2-vae.safetensors", "vae", "MOSS VAE"))
    return out


def fetch(repo: str, repo_path: str, dest: Path) -> bool:
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
    except Exception as e:  # noqa: BLE001
        log(f"FAILED {repo}/{repo_path}: {e}")
        return False


def main() -> int:
    t0 = time.time()
    if MARKER.exists():
        log("marker present, nothing to do")
        print("BOOTSTRAP_COMPLETE", flush=True)
        return 0

    selection = parse_selection()
    log(f"start v3 ({len(selection)} model(s) selected: {', '.join(selection)})")
    for d in ("diffusion_models", "text_encoders", "vae", "loras"):
        (MODELS / d).mkdir(parents=True, exist_ok=True)

    # Base deps
    run([sys.executable, "-m", "pip", "install", "-q", "huggingface_hub>=0.25", "safetensors"])
    if not ADAPTER_NODE_DIR.exists():
        rc = run(["git", "clone", "--depth", "1", ADAPTER_REPO, str(ADAPTER_NODE_DIR)]).returncode
        log("adapter node cloned" if rc == 0 else "WARNING: adapter node clone failed (base flows unaffected)")

    ok = True
    # dependency downloads first (encoders before checkpoints is irrelevant, but encoders are required)
    for repo, repo_path, dest_dir, why in with_dependencies(selection):
        ok &= fetch(repo, repo_path, MODELS / dest_dir / Path(repo_path).name)
    # selected files
    by_id = {entry[0]: entry for entry in REGISTRY}
    for model_id in selection:
        _, _, repo, repo_path, category = by_id[model_id]
        ok &= fetch(repo, repo_path, MODELS / category / Path(repo_path).name)

    SELECT_FILE.write_text(",".join(selection) + "\n")
    if ok:
        MARKER.write_text(f"completed in {time.time() - t0:.0f}s; selection={','.join(selection)}\n")
        log(f"all selected assets ready in {time.time() - t0:.0f}s")
        print("BOOTSTRAP_COMPLETE", flush=True)
    else:
        print("BOOTSTRAP_FAILED partial-download", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        log(f"fatal: {e}")
        print(f"BOOTSTRAP_FAILED {e}", flush=True)
        sys.exit(0)
