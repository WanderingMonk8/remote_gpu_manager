#!/usr/bin/env python3
"""
Colab runtime lifecycle spike — answers whether a FREE-tier account can create
(and therefore stop) a Colab runtime through the public Colab API v1beta.

This is the allocation gate for "start/stop from the extension". Nothing is built
on it until it answers one question:

    does POST /v1beta/runtimes actually allocate a T4 for this account,
    or does it return FAILED_PRECONDITION?

`eligible: true` in GetRuntimeSpecs is permission to *ask*, not a guarantee of
stock. Only a real call answers it.

Endpoints (scope: https://www.googleapis.com/auth/colaboratory, read/write):

  GET    /v1beta/runtimespecs       eligibility per spec
  GET    /v1beta/runtimes           runtimes assigned to this account
  POST   /v1beta/runtimes           create (this is "start")
  GET    /v1beta/runtimes/{id}      status + connectionInfo (short-lived token)
  DELETE /v1beta/runtimes/{id}      unassign (this is "stop")

There is no "power on a stopped runtime": delete unassigns, create allocates a
new one. Persisted state on Drive is what makes that feel like on/off.

Prerequisites: the same OAuth client the eligibility probe uses, saved as
tools/client_secret.json (gitignored). The first run asks you to approve the
read/write scope; that consent is the one difference from the read-only probe.

Usage:

    python tools/colab-runtime-api.py specs          # read-only, no allocation
    python tools/colab-runtime-api.py list           # read-only
    python tools/colab-runtime-api.py create         # create, report, delete
    python tools/colab-runtime-api.py create --keep  # create and leave it running
    python tools/colab-runtime-api.py delete runtimes/abc123

Cost: a created runtime consumes Colab quota/units from the moment it is
allocated. `create` deletes what it made unless --keep is given.

Privacy: the token is held in memory only. connectionInfo.token is never printed
in full and is masked in the saved JSON.
"""

import argparse
import json
import random
import string
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SCOPES = ["https://www.googleapis.com/auth/colaboratory"]
BASE = "https://colaboratory.googleapis.com"
CLIENT_SECRET = Path(__file__).with_name("client_secret.json")
RESULT_PATH = Path(__file__).resolve().parent.parent / "docs" / "colab-runtime-api-result.json"
# Local testing only. In production the gateway receives these from the enclave.
CREDS_PATH = Path(__file__).with_name(".colab-creds.json")

CREATE_TIMEOUT = 300        # seconds to wait for allocation
POLL_SECONDS = 5


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def call(method, path, token, body=None):
    """Return (http_status, parsed_json_or_text). Never raises on API errors."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if data else {}),
            "User-Agent": "lumiverse-remote-gpu-manager-colab-runtime-spike/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"error": {"message": raw[:2000]}}


def explain_error(status, payload):
    """Print the reason, including the details that make FAILED_PRECONDITION useful."""
    err = payload.get("error", payload) if isinstance(payload, dict) else {}
    if isinstance(err, str):
        print(f"  HTTP {status}: {err[:800]}")
        return
    code = err.get("code") or status
    print(f"  HTTP {status}: {code} {err.get('status', '')} "
          f"{err.get('message', '')}".rstrip())
    for detail in err.get("details", []) or []:
        print("  detail:", json.dumps(detail)[:900])


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def auth(offline: bool = False):
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        sys.exit(
            "Missing dependency. Run:  pip install google-auth-oauthlib requests\n"
            "(If your pip is restricted, use a venv:  python -m venv .venv && .venv\\Scripts\\activate)"
        )
    if not CLIENT_SECRET.is_file():
        sys.exit(
            f"OAuth client not found at {CLIENT_SECRET}\n"
            "Reuse the 'Desktop app' client from the eligibility probe, or download a new one.\n"
            "See the instructions at the top of tools/colab-eligibility-check.py."
        )
    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), SCOPES)
    creds = flow.run_local_server(
        port=0,
        prompt="consent",
        # access_type=offline is what makes Google return a refresh token, which
        # is what the gateway needs to act unattended later.
        access_type="offline" if offline else None,
        authorization_prompt_message="Authorize runtime create/delete on your Colab account: "
                                  "{url}",
        success_message="Authorized. You can close this tab.",
    )
    if offline:
        return creds
    return creds.token  # in memory only


def specs(token):
    status, payload = call("GET", "/v1beta/runtimespecs", token)
    if status != 200:
        explain_error(status, payload)
        sys.exit("Could not list runtime specs.")
    return payload.get("runtimeSpecs", []) or []


def pick_spec(all_specs, accelerator):
    """Choose the requested accelerator, standard shape, only if eligible."""
    for entry in all_specs:
        key = entry.get("key", {})
        if (key.get("accelerator") == accelerator
                and key.get("shape") == "SHAPE_STANDARD"
                and entry.get("eligible")):
            return key
    return None


def mask(runtime):
    """Copy of a Runtime with the proxy token shortened, for printing/saving."""
    out = json.loads(json.dumps(runtime))
    info = out.get("connectionInfo") or {}
    if info.get("token"):
        info["token"] = info["token"][:6] + "…" + f"({len(info['token'])} chars)"
    return out


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def cmd_specs(token):
    print("\n=== runtime specs offered to this account ===")
    for entry in specs(token):
        key = entry.get("key", {})
        mark = "ELIGIBLE " if entry.get("eligible") else "not elig."
        print(f"  [{mark}] {key.get('variant', ''):>13}  {key.get('accelerator', ''):>6}  "
              f"{key.get('shape', '')}")


def cmd_list(token):
    status, payload = call("GET", "/v1beta/runtimes", token)
    if status != 200:
        explain_error(status, payload)
        sys.exit("Could not list runtimes.")
    runtimes = payload.get("runtimes", []) or []
    print(f"\n=== {len(runtimes)} runtime(s) assigned ===")
    for rt in runtimes:
        key = rt.get("runtimeSpec", {})
        info = rt.get("connectionInfo") or {}
        print(f"  {rt.get('name')}  {key.get('accelerator')}/{key.get('shape')}  "
              f"token expires {info.get('expireTime', 'n/a')}")


def cmd_delete(token, name):
    status, payload = call("DELETE", f"/v1beta/{name}", token)
    if status in (200, 204):
        print(f"Deleted {name}.")
        return True
    explain_error(status, payload)
    return False


def cmd_create(token, accelerator, keep):
    all_specs = specs(token)
    spec = pick_spec(all_specs, accelerator)
    if spec is None:
        print(f"\n{accelerator} SHAPE_STANDARD is not eligible for this account right now.")
        cmd_specs(token)
        sys.exit(2)

    runtime_id = "rgm-spike-" + "".join(random.choices(string.hexdigits.lower()[:16], k=6))
    body = {"runtimeSpec": spec}
    created = f"runtimes/{runtime_id}"

    print(f"\n=== creating {runtime_id}  ({spec['variant']}, {spec['accelerator']}, {spec['shape']}) ===")
    status, payload = call("POST", "/v1beta/runtimes?runtimeId=" + runtime_id, token, body)
    print(f"  POST -> HTTP {status}")
    if status not in (200, 201):
        explain_error(status, payload)
        print("\nRESULT: create was refused. This is the answer for the free tier unless the")
        print("        reason above is transient (try again later) or account-specific.")
        return 1

    operation = payload if isinstance(payload, dict) else {}
    print(f"  operation: {operation.get('name')}  done={operation.get('done')}")

    runtime = None
    deadline = time.time() + CREATE_TIMEOUT
    while time.time() < deadline:
        status, payload = call("GET", f"/v1beta/{created}", token)
        if status == 200:
            runtime = payload
            if (runtime.get("connectionInfo") or {}).get("url"):
                break
            print(f"  … allocated, waiting for connection info")
        elif status in (404, 429, 500, 503):
            print(f"  … {status}, still waiting")
        else:
            explain_error(status, payload)
            break
        time.sleep(POLL_SECONDS)

    if not runtime or not (runtime.get("connectionInfo") or {}).get("url"):
        print("\nRESULT: created, but no connection info within "
              f"{CREATE_TIMEOUT}s. The allocation half may still work; investigate the runtime.")
        if not keep:
            cmd_delete(token, created)
        return 3

    safe = mask(runtime)
    print("\nRESULT: allocation SUCCEEDED.")
    print(json.dumps(safe, indent=2))

    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULT_PATH.write_text(json.dumps(
        {"runtime": safe, "accelerator": accelerator,
         "note": "Spike run. Token masked. Delete docs/colab-runtime-api-result.json "
                 "before committing anything that should stay private."},
        indent=2), encoding="utf-8")
    print(f"\nSaved to {RESULT_PATH} (token masked).")

    if keep:
        print(f"\n--keep given: {created} is STILL RUNNING and consuming quota.")
        print(f"Stop it with:  python tools/colab-runtime-api.py delete {created}")
        return 0

    print("\n=== deleting (stop path) ===")
    return 0 if cmd_delete(token, created) else 4


def cmd_creds():
    """One-time consent, saving what the gateway needs to act unattended."""
    creds = auth(offline=True)
    if not creds.refresh_token:
        sys.exit("Google did not return a refresh token. Revoke this app's access at "
                 "https://myaccount.google.com/permissions and run it again.")
    client = json.loads(CLIENT_SECRET.read_text(encoding="utf-8"))
    key = next(iter(client))
    payload = {
        "client_id": client[key]["client_id"],
        "client_secret": client[key]["client_secret"],
        "refresh_token": creds.refresh_token,
    }
    CREDS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CREDS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        CREDS_PATH.chmod(0o600)
    except OSError:
        pass
    print(f"\nSaved credentials to {CREDS_PATH} (gitignored).")
    print("The gateway reads these through the enclave in production; this file is")
    print("for local testing only. Delete it when you are done testing.")


def main():
    parser = argparse.ArgumentParser(description="Colab runtime create/delete spike.")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("specs", help="list runtime specs and eligibility (read-only)")
    sub.add_parser("list", help="list assigned runtimes (read-only)")
    sub.add_parser("creds", help="one-time consent; save creds for the gateway")
    p_create = sub.add_parser("create", help="create a runtime, report, then delete it")
    p_create.add_argument("--keep", action="store_true", help="leave the runtime running")
    p_create.add_argument("--accelerator", default="T4", help="T4, L4, A100 (default T4)")
    p_delete = sub.add_parser("delete", help="delete a runtime by name")
    p_delete.add_argument("name", help="runtimes/xxxx")
    args = parser.parse_args()

    if args.command == "creds":
        cmd_creds()
        return

    token = auth()
    if args.command in (None, "specs"):
        cmd_specs(token)
    elif args.command == "list":
        cmd_list(token)
    elif args.command == "create":
        sys.exit(cmd_create(token, args.accelerator.upper(), args.keep))
    elif args.command == "delete":
        sys.exit(0 if cmd_delete(token, args.name) else 1)


if __name__ == "__main__":
    main()
