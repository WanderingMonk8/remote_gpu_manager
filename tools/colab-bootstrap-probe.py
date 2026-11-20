#!/usr/bin/env python3
"""
Bootstrap spike (ADR-006 §4): push a reduced cell set into a fresh Colab runtime
over the Jupyter API and prove ComfyUI comes up.

This is the missing link between "start/stop works" and "start means worker ready".
It reuses the notebook as the bootstrap script rather than inventing a second one.

Reduced profile — cells 2, 4, 8, 10:
  2   imports, GPU check
  4   clone ComfyUI, pip install requirements, dirs   (patched: USE_DRIVE=False)
  8   worker lifecycle / start_comfy definition       (patched: LIFECYCLE=False)
  10  launch ComfyUI and wait for /system_stats

Section 3 (cell 6) is replaced by a small stub: it defines comfy_ready,
stop_owned_server, ACTIVE_PROFILE and MODEL_CHOICE, but skips the multi-GB weight
download. ComfyUI starts with no models — /system_stats and /object_info answer,
which is what proves the mechanism. The full profile adds cell 6.

Cost: one T4 allocation for ~3-6 minutes (git clone + pip install + launch).
Deleted automatically unless --keep.

Run:
  .venv\\Scripts\\python.exe tools\\colab-bootstrap-probe.py
  .venv\\Scripts\\python.exe tools\\colab-bootstrap-probe.py --keep
  .venv\\Scripts\\python.exe tools\\colab-bootstrap-probe.py --cells 2,4,8,10
"""

import argparse
import base64
import importlib.util
import json
import os
import re
import sys
import time
import urllib.request
import uuid
from pathlib import Path

import websocket

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("probe", HERE / "colab-port-routing-probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

CELL_TIMEOUT = 900
PREAMBLE = (
    "import subprocess, sys\n"
    "subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'psutil'], check=False)\n"
    "print('preamble: psutil ready')\n"
)

# Replaces section 3 for the reduced profile: the helpers cells 8 and 10 expect,
# without the weight download.
STUB = """
import requests as _rq
def comfy_ready():
    try:
        return _rq.get('http://127.0.0.1:8188/system_stats', timeout=3).ok
    except Exception:
        return False
def stop_owned_server():
    proc = globals().get('comfy_proc')
    if proc is not None and proc.poll() is None:
        proc.terminate()
ACTIVE_PROFILE = {'family': 'moss'}
MODEL_CHOICE = 'MOSS SFT INT8'
print('stub: comfy_ready, stop_owned_server, ACTIVE_PROFILE, MODEL_CHOICE')
"""

VERIFY = """
import requests
r = requests.get('http://127.0.0.1:8188/system_stats', timeout=15)
print('COMFY', r.status_code, r.text[:200])
"""

FETCH_IMAGES = """
import base64, json, requests
_out = []
if 'images' in globals():
    for _it in images:
        _r = requests.get(BASE_URL + '/view', params={
            'filename': _it['filename'],
            'subfolder': _it.get('subfolder', ''),
            'type': _it.get('type', 'output'),
        }, timeout=120)
        _r.raise_for_status()
        _out.append({'filename': _it['filename'],
                     'b64': base64.b64encode(_r.content).decode('ascii')})
print('RGM_IMAGES:' + json.dumps(_out))
"""

ENV_KEYS = ("TS_AUTHKEY", "BASIC_AUTH_USER", "BASIC_AUTH_PASS")


def user_env(name):
    """Read a persistent Windows user env var (where `setx` writes).

    A long-running process does not see variables set after it started, so the
    registry is the reliable source on Windows. Returns '' if absent.
    """
    if os.name != "nt":
        return ""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _ = winreg.QueryValueEx(key, name)
        return str(value).strip()
    except OSError:
        return ""


def env_preamble():
    """Set RGM_AUTOMATION and inject the tunnel credentials into the kernel.

    The values are base64-encoded so a syntax error in the cell cannot print them
    in a traceback. Nothing here is written to disk in the runtime.
    """
    values = {"RGM_AUTOMATION": "1"}
    saved = {}
    creds_path = HERE / ".colab-creds.json"
    if creds_path.is_file():
        saved = json.loads(creds_path.read_text(encoding="utf-8"))
    for key in ENV_KEYS:
        # Process env wins, then the persistent user env (setx), then the file.
        value = (os.environ.get(key, "").strip()
                 or user_env(key)
                 or str(saved.get(key, "")).strip())
        if value:
            values[key] = value
    blob = base64.b64encode(json.dumps(values).encode("utf-8")).decode("ascii")
    code = (
        "import base64, json, os\n"
        f"_cfg = json.loads(base64.b64decode('{blob}').decode('utf-8'))\n"
        "for _k, _v in _cfg.items():\n"
        "    os.environ.setdefault(_k, _v)\n"
        "print('env: automation=1, injected', ', '.join(sorted(_cfg)))\n"
        "del _cfg\n"
    )
    return code, sorted(values)


def load_cells(path):
    nb = json.loads(path.read_text(encoding="utf-8"))
    return ["".join(c["source"]) for c in nb["cells"]]


def save_images(items, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for it in items:
        dest = out_dir / Path(it.get("filename", "image.png")).name
        dest.write_bytes(base64.b64decode(it["b64"]))
        paths.append(dest)
    return paths


def execute_live(ws, session_id, code, timeout=CELL_TIMEOUT):
    """Run code on the kernel, printing output live. Returns (ok, status, output)."""
    msg_id = str(uuid.uuid4())
    ws.send(json.dumps({
        "header": {"msg_id": msg_id, "username": "bootstrap", "session": session_id,
                   "msg_type": "execute_request", "version": "5.3"},
        "parent_header": {}, "metadata": {},
        "content": {"code": code, "silent": False, "store_history": False,
                    "user_expressions": {}, "allow_stdin": False, "stop_on_error": True},
        "channel": "shell",
    }))
    deadline = time.time() + timeout
    out = []
    while time.time() < deadline:
        try:
            raw = ws.recv()
        except websocket.WebSocketTimeoutException:
            return False, "socket timeout", "".join(out)
        except Exception as exc:
            return False, f"socket error: {exc}", "".join(out)
        reply = json.loads(raw)
        if reply.get("parent_header", {}).get("msg_id") != msg_id:
            continue
        kind = reply.get("header", {}).get("msg_type")
        content = reply.get("content", {})
        if kind == "stream":
            text = content.get("text", "")
            out.append(text)
            sys.stdout.write(text)
            sys.stdout.flush()
        elif kind in ("execute_result", "display_data"):
            text = content.get("data", {}).get("text/plain", "")
            if text:
                out.append(text + "\n")
                print(text)
        elif kind == "error":
            trace = "\n".join(content.get("traceback", []))
            out.append(trace)
            print(trace)
            return False, content.get("ename", "error"), "".join(out)
        elif kind == "execute_reply":
            status = content.get("status")
            # iopub messages (stream/display) can arrive just after execute_reply.
            # Draining briefly is what makes "Saved: <file>" visible.
            prev = ws.gettimeout()
            try:
                ws.settimeout(2.0)
                while True:
                    try:
                        late = json.loads(ws.recv())
                    except Exception:
                        break
                    lk = late.get("header", {}).get("msg_type")
                    lc = late.get("content", {})
                    if lk == "stream":
                        t = lc.get("text", "")
                        out.append(t)
                        sys.stdout.write(t)
                        sys.stdout.flush()
                    elif lk in ("execute_result", "display_data"):
                        t = lc.get("data", {}).get("text/plain", "")
                        if t:
                            out.append(t + "\n")
                            print(t)
            finally:
                ws.settimeout(prev)
            return status == "ok", status, "".join(out)
    return False, "timeout", "".join(out)


def main():
    parser = argparse.ArgumentParser(description="Bootstrap a Colab runtime from the notebook.")
    parser.add_argument("--keep", action="store_true", help="leave the runtime running")
    parser.add_argument("--accelerator", default="T4")
    parser.add_argument("--cells", default="2,4,8,10", help="comma-separated cell indices")
    parser.add_argument("--timeout", type=int, default=CELL_TIMEOUT, help="per-cell seconds")
    parser.add_argument("--stub", action="store_true",
                        help="replace section 3 with a no-weights stub (reduced profile)")
    parser.add_argument("--notebook", default=str(HERE.parent / "Unified_MOSS_Anima_Colab_Studio_Tailscale.ipynb"),
                        help="path to the .ipynb to execute")
    parser.add_argument("--list-cells", action="store_true",
                        help="print the notebook's cells and exit (no allocation)")
    parser.add_argument("--override", nargs=3, action="append",
                        metavar=("CELL", "OLD", "NEW"),
                        help="replace OLD with NEW in CELL's source, in memory only")
    parser.add_argument("--fetch-images", action="store_true",
                        help="after the cells run, save images the notebook produced")
    parser.add_argument("--out-dir", default=str(HERE.parent / "bootstrap-out"),
                        help="where fetched images are written")
    args = parser.parse_args()
    indices = [int(x) for x in args.cells.split(",") if x.strip()]

    cells = load_cells(Path(args.notebook))
    for spec in args.override or []:
        idx, old, new = int(spec[0]), spec[1], spec[2]
        if old not in cells[idx]:
            print(f"override failed: {old!r} not found in cell {idx}")
            return 2
        cells[idx] = cells[idx].replace(old, new, 1)
        print(f"override: cell {idx} {old!r} -> {new!r} (in memory only)")
    if args.list_cells:
        print(f"{args.notebook}: {len(cells)} cells")
        for i, src in enumerate(cells):
            title = ""
            for line in src.splitlines():
                if "@title" in line:
                    title = line.split("@title", 1)[1].strip()
                    break
            first = src.strip().splitlines()[0] if src.strip() else ""
            print(f"{i:2} {len(src.splitlines()):4}L  {title or first[:64]}")
        return 0

    token = probe.access_token()
    print("=== Colab bootstrap probe ===")
    name, runtime = probe.create_runtime(token, args.accelerator.upper())
    host, port, suffix, ptoken = probe.parse_proxy(runtime["connectionInfo"])
    print(f"  runtime {name}")
    print(f"  host    {host}")

    verdict, detail, funnel = "INCONCLUSIVE", "", None
    try:
        scheme, status, body, err = probe.discover_scheme(host, ptoken)
        print(f"[1] Jupyter API via {scheme} -> HTTP {status}")
        if scheme is None or status != 200:
            verdict, detail = "NO_JUPYTER", f"HTTP {status} {err}"
            return 1

        req = urllib.request.Request(
            f"https://{host}/api/kernels",
            data=json.dumps({"name": "python3"}).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "X-Colab-Runtime-Proxy-Token": ptoken},
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            kernel_id = json.loads(r.read().decode())["id"]
        print(f"[2] kernel {kernel_id}")
        if not probe.wait_for_kernel(host, ptoken, scheme, kernel_id):
            print("    kernel did not report idle; continuing")

        ws, session_id = probe.ws_connect(host, ptoken, scheme, kernel_id)
        ws.settimeout(args.timeout)

        print("[3] environment")
        ok, st, _ = execute_live(ws, session_id, PREAMBLE, timeout=180)
        if not ok:
            verdict, detail = "PREAMBLE_FAILED", st
            return 1
        env_code, injected = env_preamble()
        ok, st, _ = execute_live(ws, session_id, env_code, timeout=60)
        if not ok:
            verdict, detail = "ENV_FAILED", st
            return 1
        print(f"    injected: {', '.join(injected)}")

        if args.stub:
            print("[4] stubbing section 3")
            ok, st, _ = execute_live(ws, session_id, STUB, timeout=120)
            if not ok:
                verdict, detail = "STUB_FAILED", st
                return 1

        for idx in indices:
            print(f"\n[5] cell {idx}")
            ok, st, out = execute_live(ws, session_id, cells[idx], timeout=args.timeout)
            print(f"    -> {st}")
            if not ok:
                verdict, detail = "CELL_FAILED", f"cell {idx}: {st}"
                return 1
            for pattern in (r"GATEWAY_UPSTREAM=(https?://\S+)", r"Tunnel online:\s*(https?://\S+)"):
                m = re.search(pattern, out or "")
                if m:
                    funnel = m.group(1).rstrip(".,)")

        if args.fetch_images:
            print("\n[5b] fetching generated images")
            ok_f, st_f, out_f = execute_live(ws, session_id, FETCH_IMAGES, timeout=180)
            m = re.search(r"RGM_IMAGES:(\[.*\])", out_f or "", re.S)
            if m:
                try:
                    paths = save_images(json.loads(m.group(1)), Path(args.out_dir))
                    print(f"    saved {len(paths)} image(s): " + ", ".join(p.name for p in paths))
                except Exception as exc:
                    print(f"    could not save images: {exc}")
            else:
                print(f"    no images reported ({st_f})")

        print("\n[6] verifying ComfyUI")
        ok, st, out = execute_live(ws, session_id, VERIFY, timeout=120)
        ws.close()
        if ok and "COMFY 200" in out:
            verdict = "COMFY_UP"
            detail = "cells ran; ComfyUI answered /system_stats"
        else:
            verdict, detail = "VERIFY_FAILED", (out.strip() or st)
        if funnel:
            detail += f" | funnel {funnel}"
        print(f"\nRESULT: {verdict}")
        print(f"  {detail}")
        if funnel:
            print(f"  GATEWAY_UPSTREAM={funnel}")
        return 0 if verdict == "COMFY_UP" else 1
    finally:
        if args.keep:
            print(f"\n--keep: {name} is still running.")
            print(f"  stop: python tools/colab-runtime-api.py delete {name}")
        else:
            print("\n=== deleting runtime ===")
            probe.delete_runtime(token, name)


if __name__ == "__main__":
    sys.exit(main())
