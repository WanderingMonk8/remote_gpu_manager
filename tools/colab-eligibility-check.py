#!/usr/bin/env python3
"""
Read-only Google Colab eligibility probe — M0 feasibility gate (ADR-002).

Calls ONLY read-only endpoints with the colaboratory.readonly scope:

  GET https://colaboratory.googleapis.com/v1beta/subscription
  GET https://colaboratory.googleapis.com/v1beta/runtimespecs

It NEVER creates, starts, stops, deletes, or connects to a runtime, and it
does not touch the Colab UI. Nothing is provisioned and no quota is consumed
beyond one read per endpoint. It does not bypass or weaken any Colab policy.

Prerequisites (do these in your own Google account, by hand):

  1. Create/select a Google Cloud project.
  2. Enable the "Colab API" for it:
       https://console.cloud.google.com/apis/library/colaboratory.googleapis.com
  3. Configure the OAuth consent screen (External is fine; add yourself as a
     test user if the app stays in testing).
  4. Create OAuth client credentials of type "Desktop app".
  5. Download the client config JSON as  tools/client_secret.json
     (gitignored; never commit it).
  6. pip install google-auth-oauthlib requests

Run:

  python tools/colab-eligibility-check.py

A browser window opens for consent (scope: colaboratory.readonly). The result
is printed and also written to  docs/colab-eligibility-result.json  (gitignored
— it can contain your account identifiers). Share that file or its contents
with the developer if you want the eligibility record included in the M0 docs.

Deleting your tokens: this script stores none. It uses google-auth-oauthlib's
InstalledAppFlow which keeps the token in memory only. Revoke anytime at
https://myaccount.google.com/permissions
"""

import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

try:
    from google_auth_oauthlib.flow import InstalledAppFlow
except ImportError:
    sys.exit(
        "Missing dependency. Run:  pip install google-auth-oauthlib requests\n"
        "(If your pip is restricted, use a venv:  python -m venv .venv && .venv\\Scripts\\activate)"
    )

SCOPES = ["https://www.googleapis.com/auth/colaboratory.readonly"]
BASE = "https://colaboratory.googleapis.com"
CLIENT_SECRET = Path(__file__).with_name("client_secret.json")
RESULT_PATH = Path(__file__).resolve().parent.parent / "docs" / "colab-eligibility-result.json"


def api_get(path, token):
    req = urllib.request.Request(
        BASE + path,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "lumiverse-remote-gpu-manager-m0-eligibility/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        return e.code, {"error": body[:2000]}


def main():
    if not CLIENT_SECRET.is_file():
        sys.exit(
            f"OAuth client not found at {CLIENT_SECRET}\n"
            "Download a 'Desktop app' OAuth client config for your Cloud project and save it there.\n"
            "See the instructions at the top of this file."
        )

    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), SCOPES)
    creds = flow.run_local_server(
        port=0,
        prompt="consent",
        authorization_prompt_message="Authorize the read-only Colab eligibility probe in your browser…",
        success_message="Eligibility probe authorized. You can close this tab.",
    )
    token = creds.token  # in-memory only; never written to disk

    sub_code, subscription = api_get("/v1beta/subscription", token)
    specs_code, specs = api_get("/v1beta/runtimespecs", token)

    eligible = []
    for entry in specs.get("runtimeSpecs", []) if isinstance(specs, dict) else []:
        key = entry.get("key", {})
        eligible.append(
            {
                "variant": key.get("variant"),
                "accelerator": key.get("accelerator"),
                "shape": key.get("shape"),
                "eligible": entry.get("eligible"),
            }
        )

    result = {
        "subscription": {"http_status": sub_code, "body": subscription},
        "runtime_specs": {"http_status": specs_code, "specs": eligible},
        "note": (
            "Read-only probe. No runtime was created, started, stopped or deleted. "
            "Results reflect account eligibility at probe time only and do not grant "
            "any rights beyond Google's published terms for managed Colab runtimes."
        ),
    }
    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULT_PATH.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print("\n=== Colab subscription ===")
    print(json.dumps(result["subscription"], indent=2))
    print("\n=== Eligible runtime specs ===")
    for s in eligible:
        mark = "ELIGIBLE " if s["eligible"] else "not elig."
        print(f"  [{mark}] {s['variant']:>11}  {s['accelerator']:>6}  {s['shape']}")
    print(f"\nSaved to {RESULT_PATH} (gitignored).")
    print("Share docs/colab-eligibility-result.json with the developer if you want it in the M0 record.")


if __name__ == "__main__":
    main()
