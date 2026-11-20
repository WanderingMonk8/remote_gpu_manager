#!/usr/bin/env python3
"""
Scan a .ipynb for likely credentials WITHOUT printing their values.

Checks cell sources and saved outputs. Prints only the location and a masked
hint (first 4 chars + length), so the report itself is safe to paste.

Usage:
  python tools/scan-notebook-secrets.py "path/to/notebook.ipynb"
  python tools/scan-notebook-secrets.py "path/to/notebook.ipynb" --show-values

Exit code 1 when anything is found, 0 when clean.
"""

import argparse
import json
import re
import sys
from pathlib import Path

PATTERNS = [
    ("tailscale auth key", re.compile(r"tskey-[A-Za-z0-9-]{8,}")),
    ("huggingface token", re.compile(r"hf_[A-Za-z0-9]{20,}")),
    ("google api key", re.compile(r"AIza[0-9A-Za-z_-]{30,}")),
    ("openai-style key", re.compile(r"\bsk-[A-Za-z0-9]{20,}")),
    ("bearer token", re.compile(r"Bearer\s+[A-Za-z0-9._-]{20,}")),
    ("civitai token", re.compile(r"\b[0-9a-f]{32}\b")),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    ("assigned secret", re.compile(
        r"(?i)(?<![\w.'\"])"
        r"(password|passwd|secret|token|api_key|apikey|authkey)\s*[:=]\s*"
        r"[\"']([A-Za-z0-9_\-./+]{12,})[\"']")),
]


def mask(value):
    if len(value) <= 6:
        return "*" * len(value)
    return f"{value[:4]}…({len(value)} chars)"


def scan_text(text, where, show_values):
    hits = []
    for label, pattern in PATTERNS:
        for m in pattern.finditer(text):
            found = m.group(0)
            # For "assigned secret", report only the right-hand value.
            if label == "assigned secret" and m.lastindex and m.lastindex >= 2:
                found = m.group(2)
            shown = found if show_values else mask(found)
            hits.append((where, label, shown))
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--show-values", action="store_true",
                    help="print the actual values (only on your own machine)")
    args = ap.parse_args()

    p = Path(args.path)
    if not p.is_file():
        sys.exit(f"Not found: {p}")

    nb = json.loads(p.read_text(encoding="utf-8"))
    hits = []
    for i, cell in enumerate(nb.get("cells", [])):
        src = "".join(cell.get("source", []))
        hits += scan_text(src, f"cell {i} source", args.show_values)
        for out in cell.get("outputs", []) or []:
            blob = json.dumps(out)
            hits += scan_text(blob, f"cell {i} output", args.show_values)

    print(f"Scanned {p.name}: {len(nb.get('cells', []))} cells")
    if not hits:
        print("CLEAN - no credential-shaped strings in sources or outputs.")
        return 0

    print(f"FOUND {len(hits)} potential credential(s):")
    for where, label, shown in hits:
        print(f"  {where:22} {label:20} {shown}")
    print("\nIf any of these are real, rotate them before sharing this file.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
