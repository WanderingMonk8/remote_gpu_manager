#!/usr/bin/env python3
"""
Check a Funnel URL from outside the tailnet.

Expects: no auth -> 401 (Caddy enforces Basic Auth), correct auth -> 200.
Reads BASIC_AUTH_USER/PASS from tools/.colab-creds.json and never prints them.

Usage:
  .venv\\Scripts\\python.exe tools/check-funnel.py https://moss-comfy.tailf0a296.ts.net
"""

import argparse
import json
import sys
from pathlib import Path

import requests

CREDS = Path(__file__).with_name(".colab-creds.json")


def main():
    ap = argparse.ArgumentParser(description="Verify a Funnel URL from outside the tailnet.")
    ap.add_argument("url")
    ap.add_argument("--path", default="/system_stats", help="path to probe")
    ap.add_argument("--timeout", type=float, default=20.0)
    args = ap.parse_args()

    url = args.url.rstrip("/") + args.path
    print(f"probing {url}")

    try:
        r = requests.get(url, timeout=args.timeout)
        print(f"  no auth     -> HTTP {r.status_code}")
    except Exception as exc:
        print(f"  no auth     -> ERROR {type(exc).__name__}: {str(exc)[:160]}")
        return 1

    creds = {}
    if CREDS.is_file():
        creds = json.loads(CREDS.read_text(encoding="utf-8"))
    user = str(creds.get("BASIC_AUTH_USER", "")).strip()
    password = str(creds.get("BASIC_AUTH_PASS", "")).strip()
    if not user or not password:
        print("  basic auth  -> skipped (no credentials in tools/.colab-creds.json)")
        return 0 if r.status_code == 401 else 1

    try:
        r2 = requests.get(url, auth=(user, password), timeout=args.timeout)
        print(f"  basic auth  -> HTTP {r2.status_code} ({len(r2.content)} bytes)")
    except Exception as exc:
        print(f"  basic auth  -> ERROR {type(exc).__name__}: {str(exc)[:160]}")
        return 1

    ok = r.status_code == 401 and r2.status_code == 200
    if ok:
        print("RESULT: OK - reachable from outside and Basic Auth enforced")
    elif r2.status_code == 401:
        print("RESULT: auth rejected - the Space's GATEWAY_BASIC_AUTH does not match")
    elif r2.status_code == 200:
        print("RESULT: reachable, but NOT protected - check the Caddyfile")
    else:
        print(f"RESULT: unexpected (unauth {r.status_code}, auth {r2.status_code})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
