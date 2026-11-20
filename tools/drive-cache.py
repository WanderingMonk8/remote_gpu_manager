"""Build a kernel cell that restores Picker-authorized model files from Drive."""
import base64
import json
import re

FILES = {
    "moss_image_sft_int8_convrot.safetensors": "diffusion_models",
    "moss_image_base_int8_convrot.safetensors": "diffusion_models",
    "qwen3.5_9b_w4a8_gptq.safetensors": "text_encoders",
    "flux2-vae_small.safetensors": "vae",
    "qwen_3_06b_base.safetensors": "text_encoders",
    "qwen_image_vae.safetensors": "vae",
    **{f"anima-{name}.safetensors": "diffusion_models" for name in (
        "base-v1.0", "turbo-v1.0", "turbo-v1.1", "aesthetic-v1.0",
        "aesthetic-v1.0b", "aesthetic-v1.1")},
}


def build_restore_cell(token, files):
    if not token or not isinstance(files, list) or not files:
        raise ValueError("drive cache and access token required")
    names = set()
    selected = []
    for item in files:
        name, file_id = item.get("name"), item.get("id")
        if name not in FILES or name in names or not isinstance(file_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", file_id):
            raise ValueError("invalid drive cache selection")
        names.add(name)
        selected.append({"name": name, "id": file_id, "category": FILES[name]})
    # Fail before downloading if the configured notebook's default model is incomplete.
    required = {"moss_image_sft_int8_convrot.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"}
    if not required.issubset(names):
        raise ValueError("incomplete default model cache")
    payload = base64.b64encode(json.dumps({"token": token, "files": selected}).encode()).decode()
    return f'''
import base64, hashlib, json, os, requests
from pathlib import Path
_rgm = json.loads(base64.b64decode({payload!r}))
try:
    for _f in _rgm["files"]:
        _url = "https://www.googleapis.com/drive/v3/files/" + _f["id"]
        _headers = {{"Authorization": "Bearer " + _rgm["token"]}}
        _meta = requests.get(_url, headers=_headers, params={{"fields":"id,name,size,md5Checksum"}}, timeout=30)
        _meta.raise_for_status(); _m = _meta.json()
        if _m.get("name") != _f["name"] or not _m.get("md5Checksum") or not _m.get("size"):
            raise RuntimeError("Drive cache metadata mismatch")
        _dest = MODELS / _f["category"] / _f["name"]
        _dest.parent.mkdir(parents=True, exist_ok=True)
        _tmp = _dest.with_suffix(_dest.suffix + ".part")
        try:
            _hash = hashlib.md5(); _size = 0
            with requests.get(_url, headers=_headers, params={{"alt":"media"}}, stream=True, timeout=(30,120)) as _r:
                _r.raise_for_status()
                with _tmp.open("wb") as _out:
                    for _chunk in _r.iter_content(8 * 1024 * 1024):
                        if _chunk: _out.write(_chunk); _hash.update(_chunk); _size += len(_chunk)
            if _size != int(_m["size"]) or _hash.hexdigest() != _m["md5Checksum"]:
                raise RuntimeError("Drive cache verification failed")
            os.replace(_tmp, _dest)
        finally:
            _tmp.unlink(missing_ok=True)
    print("Drive cache restored")
finally:
    del _rgm
'''
