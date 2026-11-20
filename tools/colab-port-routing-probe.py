#!/usr/bin/env python3
"""
Colab port-routing probe (ADR-006 §5).

Answers one question: does the Colab API's connectionInfo proxy route by port
prefix? If connectionInfo.url is

    https://8080-gpu-t4-s-abc123.us-west4.prod.r.colab.dev

does

    https://8188-gpu-t4-s-abc123.us-west4.prod.r.colab.dev

reach a server listening on 8188 inside the runtime?

If yes, an API-created runtime can publish ComfyUI without the Funnel, and
GATEWAY_UPSTREAM becomes a stable URL instead of a per-session secret.

What it does:
  1. Creates a T4 runtime (costs quota).
  2. Connects to its Jupyter kernel over the authenticated proxy.
  3. Starts a tiny HTTP server on 8188 inside the runtime.
  4. Requests https://8188-<suffix>/ through the proxy, with the proxy token.
  5. Reports: routes+works / routes+rejects token / routes+no server / no such route.
  6. Deletes the runtime.

Auth: reuses tools/.colab-creds.json. Run  python tools/colab-runtime-api.py creds
once first. The access token is minted from the saved refresh token, so this
script needs no browser.

Cost: one T4 allocation for ~2-3 minutes. Delete is automatic unless --keep.

Run:
  .venv\\Scripts\\python.exe tools\\colab-port-routing-probe.py
  .venv\\Scripts\\python.exe tools\\colab-port-routing-probe.py --keep
"""

import argparse
import json
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import websocket  # websocket-client
except ImportError:
    sys.exit("Missing dependency. Run:  .venv\\Scripts\\python.exe -m pip install websocket-client")

BASE = "https://colaboratory.googleapis.com"
SCOPE = "https://www.googleapis.com/auth/colaboratory"
CLIENT_SECRET = Path(__file__).with_name("client_secret.json")
CREDS_PATH = Path(__file__).with_name(".colab-creds.json")
RESULT_PATH = Path(__file__).resolve().parent.parent / "docs" / "colab-port-routing-result.json"

CREATE_TIMEOUT = 300
POLL_SECONDS = 5
KERNEL_TIMEOUT = 60
SERVER_PORT = 8188
PROBE_MARKER = "RGM-PORT-PROBE-8188"


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
def access_token():
    """Mint a short-lived access token from the saved refresh token."""
    if not CREDS_PATH.is_file():
        sys.exit(f"Missing {CREDS_PATH}. Run:  python tools/colab-runtime-api.py creds")
    saved = json.loads(CREDS_PATH.read_text(encoding="utf-8"))
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
    except ImportError:
        sys.exit("Missing google-auth. Run:  .venv\\Scripts\\python.exe -m pip install google-auth")
    creds = Credentials(
        token=None,
        refresh_token=saved["refresh_token"],
        client_id=saved["client_id"],
        client_secret=saved["client_secret"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=[SCOPE],
    )
    creds.refresh(Request())
    return creds.token


# --------------------------------------------------------------------------- #
# Colab API
# --------------------------------------------------------------------------- #
def api(method, path, token, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if data else {}),
            "User-Agent": "lumiverse-remote-gpu-manager-port-probe/1.0",
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


def create_runtime(token, accelerator="T4"):
    status, payload = api("GET", "/v1beta/runtimespecs", token)
    if status != 200:
        print(f"  specs -> HTTP {status}: {json.dumps(payload)[:400]}")
        sys.exit(2)
    spec = None
    for entry in payload.get("runtimeSpecs", []) or []:
        key = entry.get("key", {})
        if (key.get("accelerator") == accelerator
                and key.get("shape") == "SHAPE_STANDARD"
                and entry.get("eligible")):
            spec = key
            break
    if spec is None:
        print(f"  {accelerator} SHAPE_STANDARD is not eligible for this account right now.")
        sys.exit(2)

    runtime_id = "rgm-port-" + uuid.uuid4().hex[:6]
    name = f"runtimes/{runtime_id}"
    print(f"  creating {name} ({spec['variant']}, {spec['accelerator']}, {spec['shape']})")
    status, payload = api("POST", f"/v1beta/runtimes?runtimeId={runtime_id}", token, {"runtimeSpec": spec})
    print(f"  POST -> HTTP {status}")
    if status not in (200, 201):
        err = payload.get("error", payload) if isinstance(payload, dict) else payload
        print(f"  refused: {json.dumps(err)[:600]}")
        sys.exit(2)

    deadline = time.time() + CREATE_TIMEOUT
    while time.time() < deadline:
        status, payload = api("GET", f"/v1beta/{name}", token)
        if status == 200 and (payload.get("connectionInfo") or {}).get("url"):
            state = payload.get("state", "")
            if state in ("", "IDLE", "CONNECTED", "RUNNING", "STATE_UNSPECIFIED"):
                return name, payload
            print(f"  … connectionInfo present, state={state}, waiting for the server")
        time.sleep(POLL_SECONDS)
    print(f"  no ready runtime within {CREATE_TIMEOUT}s; deleting the half-created runtime.")
    delete_runtime(token, name)
    sys.exit(3)


def delete_runtime(token, name):
    status, payload = api("DELETE", f"/v1beta/{name}", token)
    print(f"  DELETE -> HTTP {status}")
    if status in (200, 204):
        return True
    print(f"  {json.dumps(payload)[:400]}")
    return False


# --------------------------------------------------------------------------- #
# Proxy helpers
# --------------------------------------------------------------------------- #
def parse_proxy(connection_info):
    """Return (host, port, suffix, token) from connectionInfo."""
    parsed = urllib.parse.urlparse(connection_info["url"])
    host = parsed.hostname or ""
    port, _, suffix = host.partition("-")
    if not suffix:
        sys.exit(f"  unexpected proxy host (no port prefix): {host}")
    return host, port, suffix, connection_info["token"]


def port_host(suffix, port):
    """Replace the leading port in a port-prefixed host."""
    return f"{port}-{suffix}"


def request(url, token, scheme, timeout=30):
    """Try one auth scheme. Returns (status, body, error)."""
    headers = {"Accept": "application/json"}
    if scheme == "query":
        url = url + ("&" if "?" in url else "?") + "token=" + urllib.parse.quote(token)
    elif scheme == "bearer":
        headers["Authorization"] = f"Bearer {token}"
    elif scheme == "proxy-header":
        headers["X-Colab-Runtime-Proxy-Token"] = token
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(4000).decode("utf-8", "replace"), None
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(4000).decode("utf-8", "replace"), None
    except Exception as exc:  # DNS, TLS, connection refused, timeout
        return None, "", str(exc)


def discover_scheme(host, token):
    """Find the auth scheme the proxy accepts for /api/kernels.

    The documented scheme is the X-Colab-Runtime-Proxy-Token header. A 404 is
    not proof of a working scheme — it can mean the server is not up yet — so
    prefer an actual 200 and keep the best non-401/403 answer as a fallback.
    """
    best = None
    for scheme in ("proxy-header", "query", "bearer"):
        status, body, err = request(f"https://{host}/api/kernels", token, scheme)
        if status == 200:
            return scheme, status, body, err
        if status is not None and status not in (401, 403) and best is None:
            best = (scheme, status, body, err)
    if best:
        return best
    return None, None, "", "all schemes rejected or unreachable"


# --------------------------------------------------------------------------- #
# Jupyter kernel over WebSocket
# --------------------------------------------------------------------------- #
def ws_connect(host, token, scheme, kernel_id):
    session_id = str(uuid.uuid4())
    path = f"/api/kernels/{kernel_id}/channels?session_id={session_id}"
    if scheme == "query":
        path += "&token=" + urllib.parse.quote(token)
    headers = {}
    if scheme == "bearer":
        headers["Authorization"] = f"Bearer {token}"
    elif scheme == "proxy-header":
        # Documented header, plus the WebSocket query param the Colab clients use.
        headers["X-Colab-Runtime-Proxy-Token"] = token
        path += "&colab-runtime-proxy-token=" + urllib.parse.quote(token)
    ws = websocket.create_connection(f"wss://{host}{path}", header=headers, timeout=KERNEL_TIMEOUT)
    return ws, session_id


def wait_for_kernel(host, token, scheme, kernel_id, timeout=90):
    """Poll until the kernel reports execution_state 'idle'.

    A freshly created kernel is 'starting'; executing against it immediately
    queues the request and can lose the stream output. Waiting for idle makes
    the first execute deterministic.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, body, err = request(f"https://{host}/api/kernels", token, scheme)
        if status == 200:
            try:
                for k in json.loads(body):
                    if k.get("id") == kernel_id and k.get("execution_state") == "idle":
                        return True
            except Exception:
                pass
        time.sleep(2)
    return False


def execute(ws, session_id, code, timeout=60):
    """Run code on the kernel; return (ok, output)."""
    msg_id = str(uuid.uuid4())
    ws.send(json.dumps({
        "header": {
            "msg_id": msg_id,
            "username": "probe",
            "session": session_id,
            "msg_type": "execute_request",
            "version": "5.3",
        },
        "parent_header": {},
        "metadata": {},
        "content": {
            "code": code,
            "silent": False,
            "store_history": False,
            "user_expressions": {},
            "allow_stdin": False,
            "stop_on_error": True,
        },
        "channel": "shell",
    }))
    out = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            raw = ws.recv()
        except websocket.WebSocketTimeoutException:
            return False, "".join(out) + "\n(socket timeout)"
        except Exception as exc:
            return False, "".join(out) + f"\n(socket error: {exc})"
        reply = json.loads(raw)
        if reply.get("parent_header", {}).get("msg_id") != msg_id:
            continue
        kind = reply.get("header", {}).get("msg_type")
        content = reply.get("content", {})
        if kind == "stream":
            out.append(content.get("text", ""))
        elif kind in ("execute_result", "display_data"):
            out.append(content.get("data", {}).get("text/plain", ""))
        elif kind == "error":
            out.append("\n".join(content.get("traceback", [])))
            return False, "".join(out)
        elif kind == "execute_reply":
            return True, "".join(out)
    return False, "".join(out) + "\n(timeout)"


# --------------------------------------------------------------------------- #
# Probe
# --------------------------------------------------------------------------- #
SERVER_CODE = f"""
import sys, threading, http.server, socketserver
class _H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"{PROBE_MARKER}"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
srv = socketserver.TCPServer(("0.0.0.0", {SERVER_PORT}), _H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
sys.stdout.write("listening on {SERVER_PORT}\\n")
sys.stdout.flush()
"""


def classify(status, body, err, inside_ok=False):
    if err and status is None:
        return "NO_SUCH_ROUTE", f"connection error: {err}"
    if status == 200 and PROBE_MARKER in body:
        return "ROUTES_AND_WORKS", "the port-prefixed host reached our server"
    if status in (401, 403):
        return "ROUTES_BUT_REJECTS", f"HTTP {status}; the route exists but auth was refused"
    if status in (404, 502, 503):
        if inside_ok:
            return "NO_SUCH_ROUTE", (
                f"HTTP {status}; the server answers inside the runtime but the proxy "
                f"does not route port {SERVER_PORT}")
        return "ROUTES_BUT_NO_SERVER", f"HTTP {status}; the route exists but nothing answered on {SERVER_PORT}"
    if status == 200:
        return "ROUTES_SOMETHING_ELSE", f"HTTP 200 but not our server: {body[:120]!r}"
    return "INCONCLUSIVE", f"HTTP {status}: {body[:200]!r}"


def main():
    parser = argparse.ArgumentParser(description="Colab port-routing probe (ADR-006).")
    parser.add_argument("--keep", action="store_true", help="leave the runtime running")
    parser.add_argument("--accelerator", default="T4", help="T4, L4, A100 (default T4)")
    args = parser.parse_args()

    token = access_token()
    print("=== Colab port-routing probe ===")
    name, runtime = create_runtime(token, args.accelerator.upper())
    info = runtime["connectionInfo"]
    host, port, suffix, proxy_token = parse_proxy(info)
    target = port_host(suffix, SERVER_PORT)
    print(f"  runtime      {name}")
    print(f"  proxy host   {host}")
    print(f"  proxy token  {proxy_token[:6]}… ({len(proxy_token)} chars)")
    print(f"  port host    {target}  (was {port}-<suffix>)")

    verdict = "INCONCLUSIVE"
    detail = ""
    try:
        # 1. Is the Jupyter API reachable through the proxy? Retry: the proxy
        #    accepts connections before the Jupyter server is listening.
        scheme, status, body, err = None, None, "", ""
        for attempt in range(1, 25):
            scheme, status, body, err = discover_scheme(host, proxy_token)
            if scheme is not None and status == 200:
                break
            print(f"  [1] attempt {attempt}: scheme={scheme} HTTP {status} {err or ''}")
            time.sleep(5)
        print(f"\n[1] Jupyter API via {scheme or 'no scheme'} -> HTTP {status} {err or ''}")

        if scheme is None or status != 200:
            # Diagnose what the proxy actually serves before falling back.
            print("[1b] path diagnostics:")
            for path in ("/", "/api/kernels", "/api/kernelspecs", "/lab"):
                st, bd, e = request(f"https://{host}{path}", proxy_token, scheme or "query")
                print(f"     {path:20} -> HTTP {st} {e or ''} {bd[:80]!r}")
            print("  Cannot reach the Jupyter API; falling back to a passive port test.")
            st, bd, e = request(f"https://{target}/", proxy_token, scheme or "query")
            verdict, detail = classify(st, bd, e)
        else:
            # 2. Find or start a kernel.
            kernels = json.loads(body) if body.strip().startswith("[") else []
            print(f"[2] kernels: {[k.get('id') for k in kernels] or 'none'}")
            kernel_id = kernels[0]["id"] if kernels else None
            if not kernel_id:
                # POST needs a body; use urllib directly for the create call.
                req = urllib.request.Request(
                    f"https://{host}/api/kernels" + ("?token=" + urllib.parse.quote(proxy_token) if scheme == "query" else ""),
                    data=json.dumps({"name": "python3"}).encode(),
                    method="POST",
                    headers={
                        "Content-Type": "application/json",
                        **({"Authorization": f"Bearer {proxy_token}"} if scheme == "bearer" else {}),
                        **({"X-Colab-Runtime-Proxy-Token": proxy_token} if scheme == "proxy-header" else {}),
                    },
                )
                try:
                    with urllib.request.urlopen(req, timeout=60) as r:
                        kernel_id = json.loads(r.read().decode())["id"]
                except Exception as exc:
                    print(f"  could not start a kernel: {exc}")
                    kernel_id = None
            if kernel_id:
                if not wait_for_kernel(host, proxy_token, scheme, kernel_id):
                    print("  kernel did not reach idle; trying anyway")
                print(f"[3] starting a server on {SERVER_PORT} inside the runtime")
                ws, session_id = ws_connect(host, proxy_token, scheme, kernel_id)
                ok, out = execute(ws, session_id, SERVER_CODE)
                print(f"    kernel: {'ok' if ok else 'error'} {out.strip()[:200]}")
                inside_code = (
                    "import urllib.request; "
                    f"print(urllib.request.urlopen('http://127.0.0.1:{SERVER_PORT}/', timeout=5).read().decode())"
                )
                ok_in, out_in = execute(ws, session_id, inside_code)
                inside_ok = PROBE_MARKER in (out_in or "")
                print(f"    inside: {'ok' if inside_ok else 'no'} {out_in.strip()[:120]}")
                ws.close()
                time.sleep(2)
                print(f"[4] requesting https://{target}/")
                st, bd, e = request(f"https://{target}/", proxy_token, scheme)
                verdict, detail = classify(st, bd, e, inside_ok)
            else:
                verdict, detail = "INCONCLUSIVE", "no kernel available"
    finally:
        print(f"\nRESULT: {verdict}")
        print(f"  {detail}")
        masked = {
            "runtime": name,
            "proxy_host": host,
            "port_host": target,
            "verdict": verdict,
            "detail": detail,
            "note": "Token masked. Free-tier allocation; delete this file before committing.",
        }
        RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
        RESULT_PATH.write_text(json.dumps(masked, indent=2), encoding="utf-8")
        print(f"  saved to {RESULT_PATH} (token masked)")
        if args.keep:
            print(f"\n--keep given: {name} is STILL RUNNING and consuming quota.")
            print(f"Stop it with:  python tools/colab-runtime-api.py delete {name}")
        else:
            print("\n=== deleting runtime ===")
            delete_runtime(token, name)
    return 0 if verdict == "ROUTES_AND_WORKS" else 1


if __name__ == "__main__":
    sys.exit(main())
