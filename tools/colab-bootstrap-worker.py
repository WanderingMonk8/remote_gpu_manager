#!/usr/bin/env python3
"""One-shot private stdio bridge for a controller-owned Colab runtime.

One JSON request is read from stdin and one JSON response is written to stdout.
Both contain secrets and must only be connected to a trusted local controller.
The worker never allocates or deletes a runtime and never writes secrets to disk.
"""
import contextlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
MAX_REQUEST = 8 * 1024 * 1024


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            raise ValueError("request too large")
        request = json.loads(raw)
        runtime = request["runtime"]
        credentials = request["credentials"]
        state = request.get("state", {})
        if (not isinstance(runtime, dict) or not isinstance(credentials, dict)
                or not isinstance(state, dict)):
            raise ValueError("invalid request")
        spec = importlib.util.spec_from_file_location("bootstrap", HERE / "colab-bootstrap-probe.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        args = SimpleNamespace(cells="2,4,6,8,10,12,14,16,18,20,25", timeout=900,
                               no_state=True, stub=False, fetch_images=False)
        cells = module.load_cells(HERE.parent / "Unified_MOSS_Anima_Colab_Studio_Tailscale.ipynb")
        hooks = {"credentials": credentials, "state": state}
        # Notebook output is untrusted and may contain secrets; do not log it.
        with open(os.devnull, "w", encoding="utf-8") as null:
            with contextlib.redirect_stdout(null), contextlib.redirect_stderr(null):
                code = module.bootstrap_runtime(args, cells, runtime["name"], runtime, hooks)
        if code != 0 or not hooks.get("funnel") or not hooks.get("state", {}).get("tailscaled.state"):
            raise ValueError("bootstrap failed")
        response = {"ok": True, "funnel": hooks["funnel"], "state": hooks["state"]}
    except Exception:
        response = {"ok": False, "error": "bootstrap_failed"}
    sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
    return 0 if response["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
