"""Build a private kernel cell to download a selected Civitai checkpoint."""
import base64
import json
import re


def build_download_cell(selection):
    if not isinstance(selection, dict) or not isinstance(selection.get("version"), dict):
        raise ValueError("invalid Civitai selection")
    version = selection["version"]
    vid, fid, family = version.get("id"), selection.get("fileId"), version.get("family")
    if (type(vid) is not int or not 0 < vid < 10**15 or type(fid) is not int or not 0 < fid < 10**15 or family not in ("anima", "moss")):
        raise ValueError("invalid Civitai selection")
    base = version.get("baseModel", "")
    pattern = r"^anima(?:\b|[-_ ])" if family == "anima" else r"^moss(?:[-_ ]?image)?(?:\b|[-_ ])"
    if not isinstance(base, str) or not re.match(pattern, base, re.I):
        raise ValueError("unsupported Civitai family")
    files = version.get("files")
    if not isinstance(files, list): raise ValueError("invalid Civitai files")
    matches = [f for f in files if isinstance(f, dict) and f.get("id") == fid]
    if len(matches) != 1: raise ValueError("invalid Civitai file")
    f = matches[0]
    if not isinstance(f.get("name"), str) or (len(f["name"]) > 180 or not f["name"].lower().endswith(".safetensors") or re.search(r"[\x00-\x1f\x7f/\\]", f["name"])):
        raise ValueError("invalid Civitai file")
    size = f.get("sizeKB")
    if isinstance(size, bool) or not isinstance(size, (int, float)) or not 0 < size <= 100_000_000: raise ValueError("invalid Civitai size")
    sha = f.get("sha256")
    if sha is not None and (not isinstance(sha, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", sha)): raise ValueError("invalid Civitai hash")
    token = selection.get("token", "")
    if not isinstance(token, str) or len(token) > 1024 or any(not (33 <= ord(c) <= 126) for c in token): raise ValueError("invalid token")
    payload = base64.b64encode(json.dumps({"vid": vid, "fid": fid, "family": family, "sizeKB": size, "sha": sha, "token": token}).encode()).decode()
    return f'''
import base64, hashlib, json, os, shutil, requests
from pathlib import Path
from urllib.parse import urljoin, urlparse
from safetensors import safe_open
_c = json.loads(base64.b64decode({payload!r}))
_url = "https://civitai.com/api/download/models/" + str(_c["vid"]) + "?fileId=" + str(_c["fid"])
_dest = MODELS / "diffusion_models" / ("civitai-" + str(_c["vid"]) + "-" + str(_c["fid"]) + ".safetensors")
_dest.parent.mkdir(parents=True, exist_ok=True)
_tmp = _dest.with_suffix(".part")
_headers = {{}}
try:
    if _dest.is_file():
        with safe_open(_dest, framework="pt", device="cpu") as _safe:
            if not _safe.keys(): raise RuntimeError("Empty SafeTensors checkpoint")
        os.environ["RGM_CIVITAI_FAMILY"] = _c["family"]
        os.environ["RGM_CIVITAI_CHECKPOINT"] = _dest.name
        print("Verified Drive checkpoint ready")
    else:
        if shutil.disk_usage(_dest.parent).free < int(_c["sizeKB"] * 1024) + 512 * 1024 * 1024:
            raise RuntimeError("Insufficient disk space for the selected checkpoint")
        for _ in range(6):
            _parsed = urlparse(_url)
            _host = (_parsed.hostname or "").lower()
            _allowed = _host in ("civitai.com", "www.civitai.com", "civitai.red", "www.civitai.red") or _host.endswith(".civitai.com") or _host.endswith(".civitai.red") or _host.endswith(".amazonaws.com") or _host.endswith(".cloudflarestorage.com")
            if _parsed.scheme != "https" or not _allowed or _parsed.username or _parsed.password: raise RuntimeError("Unsupported Civitai download host")
            _headers = {{"Authorization": "Bearer " + _c["token"]}} if _c["token"] and _host in ("civitai.com", "www.civitai.com", "civitai.red", "www.civitai.red") else {{}}
            _r = requests.get(_url, headers=_headers, stream=True, timeout=(30, 120), allow_redirects=False)
            if _r.status_code in (301, 302, 303, 307, 308):
                _next = _r.headers.get("Location", ""); _r.close()
                if not _next: raise RuntimeError("Civitai download redirect missing")
                _url = urljoin(_url, _next); continue
            try:
                _r.raise_for_status()
                if "html" in _r.headers.get("Content-Type", "").lower() or "json" in _r.headers.get("Content-Type", "").lower(): raise RuntimeError("Civitai returned a page instead of a model")
                _hash = hashlib.sha256(); _size = 0
                with _tmp.open("wb") as _out:
                    for _chunk in _r.iter_content(8 * 1024 * 1024):
                        if not _chunk: continue
                        _size += len(_chunk)
                        if _size > int(_c["sizeKB"] * 1024) + 1024 * 1024: raise RuntimeError("Civitai file exceeds advertised size")
                        _hash.update(_chunk); _out.write(_chunk)
                if not _size or (_c["sha"] and _hash.hexdigest().lower() != _c["sha"].lower()): raise RuntimeError("Civitai checkpoint verification failed")
                with safe_open(_tmp, framework="pt", device="cpu") as _safe:
                    if not _safe.keys(): raise RuntimeError("Empty SafeTensors checkpoint")
                os.replace(_tmp, _dest)
                os.environ["RGM_CIVITAI_FAMILY"] = _c["family"]
                os.environ["RGM_CIVITAI_CHECKPOINT"] = _dest.name
                print("Civitai checkpoint downloaded and validated")
                break
            finally:
                _r.close()
        else: raise RuntimeError("Too many Civitai download redirects")
finally:
    _tmp.unlink(missing_ok=True)
    for _secret_name in ("_c", "_headers", "_url", "_r", "_parsed", "_next"):
        globals().pop(_secret_name, None)
'''
