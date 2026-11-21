"""Build a kernel cell that restores Picker-authorized model files from Drive."""
import ast
import base64
import json
import re

FILES = {
    "moss_image_sft_int8_convrot.safetensors": "diffusion_models",
    "moss_image_base_int8_convrot.safetensors": "diffusion_models",
    "moss_image_base_bf16.safetensors": "diffusion_models",
    "moss_image_sft_bf16.safetensors": "diffusion_models",
    "Anima-2.9B-preview-v1.safetensors": "diffusion_models",
    "Anima-2.9B-preview-v1_int8_convrot.safetensors": "diffusion_models",
    "qwen3.5_9b_w4a8_gptq.safetensors": "text_encoders",
    "flux2-vae_small.safetensors": "vae",
    "qwen_3_06b_base.safetensors": "text_encoders",
    "qwen_image_vae.safetensors": "vae",
    **{f"anima-{name}.safetensors": "diffusion_models" for name in (
        "base-v1.0", "turbo-v1.0", "turbo-v1.1", "aesthetic-v1.0",
        "aesthetic-v1.0b", "aesthetic-v1.1", "preview", "preview2", "preview3-base")},
}


MODELS = {
    "MOSS SFT INT8": ("moss_image_sft_int8_convrot.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"),
    "MOSS SFT BF16": ("moss_image_sft_bf16.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"),
    "MOSS Base BF16": ("moss_image_base_bf16.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"),
    "Anima 2.9B Preview BF16": ("Anima-2.9B-preview-v1.safetensors", "qwen_3_06b_base.safetensors", "qwen_image_vae.safetensors"),
    "Anima 2.9B Preview INT8": ("Anima-2.9B-preview-v1_int8_convrot.safetensors", "qwen_3_06b_base.safetensors", "qwen_image_vae.safetensors"),
    "MOSS Base INT8": ("moss_image_base_int8_convrot.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"),
    **{label: (f"anima-{name}.safetensors", "qwen_3_06b_base.safetensors", "qwen_image_vae.safetensors") for label, name in {
        "Anima Preview": "preview", "Anima Preview 2": "preview2", "Anima Preview 3 Base": "preview3-base",
        "Anima Base v1.0": "base-v1.0", "Anima Turbo v1.0": "turbo-v1.0", "Anima Turbo v1.1": "turbo-v1.1",
        "Anima Aesthetic v1.0": "aesthetic-v1.0", "Anima Aesthetic v1.0b": "aesthetic-v1.0b", "Anima Aesthetic v1.1": "aesthetic-v1.1"}.items()},
}


def workbook_model(source):
    matches = re.findall(r"^MODEL_CHOICE\s*=\s*(.+?)\s*#\s*@param", source, re.MULTILINE)
    if len(matches) != 1:
        raise ValueError("invalid workbook model")
    try:
        model = ast.literal_eval(matches[0])
    except (ValueError, SyntaxError):
        raise ValueError("invalid workbook model") from None
    if not isinstance(model, str) or (model not in MODELS and model != "Custom Civitai"):
        raise ValueError("invalid workbook model")
    return model


def build_restore_cell(token, files, model="MOSS SFT INT8", family=None, custom=None):

    if not token or not isinstance(files, list) or not files:
        raise ValueError("drive cache and access token required")
    custom_name = None
    custom_dest = None
    custom_sha = None
    if custom is not None:
        version = custom.get("version", {}) if isinstance(custom, dict) else {}
        vid, fid = version.get("id"), custom.get("fileId")
        candidates = [f for f in version.get("files", []) if isinstance(f, dict) and f.get("id") == fid]
        if type(vid) is not int or type(fid) is not int or not 0 < vid < 10**15 or not 0 < fid < 10**15 or len(candidates) != 1:
            raise ValueError("invalid custom cache metadata")
        custom_name, custom_sha = candidates[0].get("name"), candidates[0].get("sha256")
        if not isinstance(custom_name, str) or (len(custom_name) > 180 or not custom_name.lower().endswith(".safetensors") or re.search(r"[\x00-\x1f\x7f/\\]", custom_name)): raise ValueError("invalid custom cache name")
        if custom_sha is not None and (not isinstance(custom_sha, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", custom_sha)): raise ValueError("invalid custom cache hash")
        custom_dest = f"civitai-{vid}-{fid}.safetensors"
    names = set()
    selected = []
    for item in files:
        name, file_id = item.get("name"), item.get("id")
        if (name not in FILES and name != custom_name) or name in names or not isinstance(file_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", file_id):
            raise ValueError("invalid drive cache selection")
        names.add(name)
        selected.append({"name": name, "id": file_id, "category": FILES.get(name, "diffusion_models"), **({"destination": custom_dest, "sha256": custom_sha} if name == custom_name else {})})
    if model == "Custom Civitai":
        required = {"qwen_3_06b_base.safetensors", "qwen_image_vae.safetensors"} if family == "anima" else {"qwen3.5_9b_w4a8_gptq.safetensors", "flux2-vae_small.safetensors"} if family == "moss" else None
    else:
        required = MODELS.get(model)
    if not required or not names.issubset(set(required) | ({custom_name} if custom_name else set())):
        raise ValueError("selected cache does not match model")
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
        _dest = MODELS / _f["category"] / _f.get("destination", _f["name"])
        _dest.parent.mkdir(parents=True, exist_ok=True)
        _tmp = _dest.with_suffix(_dest.suffix + ".part")
        try:
            _hash = hashlib.md5(); _sha = hashlib.sha256(); _size = 0
            with requests.get(_url, headers=_headers, params={{"alt":"media"}}, stream=True, timeout=(30,120)) as _r:
                _r.raise_for_status()
                with _tmp.open("wb") as _out:
                    for _chunk in _r.iter_content(8 * 1024 * 1024):
                        if _chunk: _out.write(_chunk); _hash.update(_chunk); _sha.update(_chunk); _size += len(_chunk)
            if _size != int(_m["size"]) or _hash.hexdigest() != _m["md5Checksum"] or (_f.get("sha256") and _sha.hexdigest().lower() != _f["sha256"].lower()):
                raise RuntimeError("Drive cache verification failed")
            os.replace(_tmp, _dest)
        finally:
            _tmp.unlink(missing_ok=True)
    print("Drive cache restored")
finally:
    del _rgm
'''
