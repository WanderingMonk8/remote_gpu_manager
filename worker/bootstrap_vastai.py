#!/usr/bin/env python3
"""
LumiverSE Vast.ai worker bootstrap — vastai/pytorch base image (v1).

On-start flow (runs as the container's foreground process):
  1. Clone ComfyUI from GitHub (depth 1) to /root/ComfyUI.
  2. Install its requirements + huggingface_hub + safetensors.
  3. Clone the Anima reference-image adapter into custom_nodes.
  4. Download the user's selected models (+ auto-pulled encoder/VAE deps).
  5. Print BOOTSTRAP_COMPLETE.
  6. execvp ComfyUI bound to 0.0.0.0:8188 (foreground; keeps the container alive).

Idempotent. Prints BOOTSTRAP_FAILED <reason> on error. Exit code 0 either way so
Vast.ai's wrapper still reports success (better a running empty ComfyUI than a failed container).
"""

import os
import sys
import time
import shutil
import subprocess
from pathlib import Path

MARKER = Path("/root/.lumiverse-vastai-complete")
SELECT_FILE = Path("/root/.lumiverse-selected-models.txt")
COMFY_DIR = Path("/root/ComfyUI")
MODELS = COMFY_DIR / "models"
CACHE_DIR = Path("/root/.cache/lumiverse-vastai")
CUSTOM_NODES = COMFY_DIR / "custom_nodes"
ADAPTER_NODE_DIR = CUSTOM_NODES / "ComfyUI-Anima-Ref-Adapter"
ADAPTER_REPO = "https://github.com/ArcAnima/ComfyUI-Anima-Ref-Adapter.git"
MIN_SIZE = 100_000_000

REGISTRY = {
    "anima-turbo-1.1":     ("circlestone-labs/Anima", "split_files/diffusion_models/anima-turbo-v1.1.safetensors",   "diffusion_models"),
    "anima-turbo-1.0":     ("circlestone-labs/Anima", "split_files/diffusion_models/anima-turbo-v1.0.safetensors",   "diffusion_models"),
    "anima-base-1.0":      ("circlestone-labs/Anima", "split_files/diffusion_models/anima-base-v1.0.safetensors",    "diffusion_models"),
    "anima-aesthetic-1.1": ("circlestone-labs/Anima", "split_files/diffusion_models/anima-aesthetic-v1.1.safetensors","diffusion_models"),
    "anima-aesthetic-1.0": ("circlestone-labs/Anima", "split_files/diffusion_models/anima-aesthetic-v1.0.safetensors","diffusion_models"),
    "anima-aesthetic-1.0b":("circlestone-labs/Anima", "split_files/diffusion_models/anima-aesthetic-v1.0b.safetensors","diffusion_models"),
    "anima-preview":       ("circlestone-labs/Anima", "split_files/diffusion_models/anima-preview.safetensors",      "diffusion_models"),
    "anima-preview2":      ("circlestone-labs/Anima", "split_files/diffusion_models/anima-preview2.safetensors",     "diffusion_models"),
    "anima-preview3-base": ("circlestone-labs/Anima", "split_files/diffusion_models/anima-preview3-base.safetensors","diffusion_models"),
    "moss-sft-int8":       ("Comfy-Org/MOSS-Image",   "diffusion_models/moss_image_sft_int8_convrot.safetensors",    "diffusion_models"),
    "moss-base-int8":      ("Comfy-Org/MOSS-Image",   "diffusion_models/moss_image_base_int8_convrot.safetensors",   "diffusion_models"),
    "moss-sft-bf16":       ("Comfy-Org/MOSS-Image",   "diffusion_models/moss_image_sft_bf16.safetensors",            "diffusion_models"),
    "moss-base-bf16":      ("Comfy-Org/MOSS-Image",   "diffusion_models/moss_image_base_bf16.safetensors",           "diffusion_models"),
    "adapter-ref":         ("ElectronGirl/anima-ref-adapter", "anima_ref_adapter_v2_r64.safetensors",                "loras"),
}
DEFAULT_SELECTION = "anima-turbo-1.1,anima-aesthetic-1.1"
KNOWN_IDS = set(REGISTRY)


def log(m: str) -> None:
    print(f"[vastai-bootstrap] {m}", flush=True)


def run(cmd, **kw) -> int:
    log(f"$ {' '.join(str(c) for c in cmd)}")
    return subprocess.run([str(c) for c in cmd], check=False, **kw).returncode


def parse_selection() -> list[str]:
    raw = (os.environ.get("lumiverse_models") or "").strip()
    if not raw:
        return DEFAULT_SELECTION.split(",")
    ids = [t.strip() for t in raw.split(",") if t.strip() in KNOWN_IDS]
    if not ids:
        log("empty/unknown lumiverse_models env — falling back to default manifest")
        ids = DEFAULT_SELECTION.split(",")
    return ids


def with_dependencies(ids: list[str]):
    out: list[tuple[str, str, str, str]] = []
    if any(i.startswith("anima-") for i in ids):
        out.append(("circlestone-labs/Anima", "split_files/text_encoders/qwen_3_06b_base.safetensors", "text_encoders", "anima encoder"))
        out.append(("circlestone-labs/Anima", "split_files/vae/qwen_image_vae.safetensors", "vae", "anima VAE"))
    if "moss-sft-int8" in ids or "moss-base-int8" in ids:
        out.append(("Comfy-Org/MOSS-Image", "text_encoders/qwen3.5_9b_w4a8_gptq.safetensors", "text_encoders", "MOSS INT8 encoder"))
        out.append(("Comfy-Org/MOSS-Image", "vae/flux2-vae_small.safetensors", "vae", "MOSS VAE"))
    if "moss-sft-bf16" in ids or "moss-base-bf16" in ids:
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


def ensure_comfy() -> bool:
    if (COMFY_DIR / "main.py").exists():
        log("ComfyUI present, skipping clone")
        return True
    log("cloning ComfyUI (depth 1)…")
    return run(["git", "clone", "--depth", "1", "https://github.com/comfyanonymous/ComfyUI", str(COMFY_DIR)]) == 0


def install_deps() -> None:
    req = COMFY_DIR / "requirements.txt"
    if req.exists():
        log("pip install -r requirements.txt…")
        run([sys.executable, "-m", "pip", "install", "-r", str(req)])
    run([sys.executable, "-m", "pip", "install", "-q", "huggingface_hub>=0.25", "safetensors"])


def main() -> int:
    t0 = time.time()
    if MARKER.exists():
        log("marker present, skipping bootstrap")
        print("BOOTSTRAP_COMPLETE", flush=True)
        os.chdir(COMFY_DIR)
        os.execvp(sys.executable, [sys.executable, "main.py", "--listen", "0.0.0.0", "--port", "8188"])
        return 0

    selection = parse_selection()
    log(f"start ({len(selection)} model(s): {', '.join(selection)})")

    if not ensure_comfy():
        log("ComfyUI clone failed")
        print("BOOTSTRAP_FAILED clone", flush=True)
        return 0  # still let container sleep happily

    for d in ("diffusion_models", "text_encoders", "vae", "loras"):
        (MODELS / d).mkdir(parents=True, exist_ok=True)
    CUSTOM_NODES.mkdir(parents=True, exist_ok=True)

    install_deps()

    if not ADAPTER_NODE_DIR.exists():
        log("cloning Anima-Ref-Adapter…")
        rc = run(["git", "clone", "--depth", "1", ADAPTER_REPO, str(ADAPTER_NODE_DIR)])
        log("adapter cloned" if rc == 0 else "WARNING: adapter clone failed (non-fatal)")

    ok = True
    for repo, repo_path, dest_dir, why in with_dependencies(selection):
        log(f"dep: {why}")
        ok &= fetch(repo, repo_path, MODELS / dest_dir / Path(repo_path).name)
    for model_id in selection:
        repo, repo_path, category = REGISTRY[model_id]
        ok &= fetch(repo, repo_path, MODELS / category / Path(repo_path).name)

    SELECT_FILE.write_text(",".join(selection) + "\n")
    if ok:
        MARKER.write_text(f"completed in {time.time() - t0:.0f}s\n")
        log(f"all assets ready in {time.time() - t0:.0f}s")
        print("BOOTSTRAP_COMPLETE", flush=True)
    else:
        print("BOOTSTRAP_FAILED partial-download", flush=True)
        return 0

    os.chdir(COMFY_DIR)
    os.execvp(sys.executable, [sys.executable, "main.py", "--listen", "0.0.0.0", "--port", "8188"])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        log(f"fatal: {e}")
        print(f"BOOTSTRAP_FAILED {e}", flush=True)
        sys.exit(0)
