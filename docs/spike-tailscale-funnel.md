# Spike: Tailscale Funnel as the stable Colab worker URL

**Status:** Ready to run — not yet executed on Colab
**Date:** 2026-11-19
**Target:** replace `*.trycloudflare.com` (new hostname every session) with a fixed
`https://<node>.<tailnet>.ts.net`
**Decision context:** ADR-005 §4.1 T5, §4.4

---

## 1. What this changes and what it does not

Unchanged on purpose:

- Caddy on `127.0.0.1:8189` with HTTP Basic Auth in front of ComfyUI on `127.0.0.1:8188`.
- The Space-side gateway, its route allowlist, its credential injection, its `idleTimeout: 255`.
- `GATEWAY_BASIC_AUTH` — same value forever.
- The Lumiverse → gateway → worker path. Lumiverse still never sees a credential.

Changed:

- `GATEWAY_UPSTREAM` becomes a **constant** instead of a per-session value, so it is set **once**.
- The tunnel is terminated by `tailscaled` instead of `cloudflared`. Funnel does the TLS, and
  forwards plain HTTP to Caddy, which is exactly the shape cloudflared already provides.

The reason this is worth the risk: after this works, a Colab session needs **no** Space-side action at
all. No secret edit, no Factory restart, no copy/paste.

---

## 2. Prerequisites (one-time, in the Tailscale admin console)

Do these before running the cell. The cell cannot do them and will fail with a TLS/Funnel error if
they are missing.

1. **Enable HTTPS certificates** — admin console → **DNS** → *HTTPS Certificates* → **Enable**.
   Funnel terminates TLS with `tailscale cert` material; without this, `tailscale funnel` fails.
2. **Enable Funnel in the policy file** — admin console → **Access controls** → expand **Funnel** →
   **Add Funnel to policy**. That writes:

   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```

   Enabling Funnel from the CLI normally opens a browser approval page, which Colab cannot show.
   Pre-approving it here is what makes the headless path work.
3. **Create an auth key** — admin console → **Settings** → **Keys** → *Generate auth key*.
   - **Reusable** (not single-use).
   - **Not ephemeral** — an ephemeral node is deleted when it disconnects, which discards the TLS
     certificate and re-triggers issuance next session.
   - Pre-authorized (default).
   - Copy it once; it is only ever typed into `getpass` or stored as a Colab secret named
     `TS_AUTHKEY`.
4. **Pick a hostname** — a DNS label, e.g. `moss-comfy`. The final URL is
   `https://moss-comfy.<your-tailnet>.ts.net`. Keep it constant; changing it changes the URL and the
   certificate.

Note the tailnet name now (`<something>.ts.net`), because that is the part you cannot change without
renaming the tailnet.

---

## 3. The cell

Paste as a new cell after ComfyUI is running. It is self-contained: it starts Caddy itself and then
starts whichever tunnel you select, so it does not require the notebook's tunnel cell to have run.

```python
# @title Optional authenticated tunnel (Tailscale Funnel | cloudflared quick tunnel)
TUNNEL_MODE = "tailscale"   # @param ["tailscale", "cloudflare", "none"]
TS_HOSTNAME = "moss-comfy"  # @param {type:"string"}
TS_VERSION = "1.104.7"
PERSIST_TS_STATE = True     # @param {type:"boolean"}

import os, json, re, time, subprocess
from getpass import getpass
from pathlib import Path
import requests

UPSTREAM_PORT = 8189

if TUNNEL_MODE == "none":
    print("Tunnel disabled. Inline generation works without it.")
else:
    if not comfy_ready():
        raise RuntimeError("Start ComfyUI first.")

    # ---- stop whatever a previous run of this cell started ----
    for _name in ("tunnel_caddy_proc", "tunnel_cf_proc", "ts_proc"):
        _proc = globals().get(_name)
        if _proc is not None and _proc.poll() is None:
            _proc.terminate()
            try:
                _proc.wait(timeout=15)
            except Exception:
                _proc.kill()

    # ---- Caddy: Basic Auth in front of ComfyUI (identical for both tunnels) ----
    CADDY = Path("/content/caddy")
    if not CADDY.exists():
        subprocess.run(
            ["bash", "-c",
             "curl -L -o /content/caddy.tgz "
             "https://github.com/caddyserver/caddy/releases/download/v2.8.4/"
             "caddy_2.8.4_linux_amd64.tar.gz "
             "&& tar -xzf /content/caddy.tgz -C /content caddy "
             "&& rm /content/caddy.tgz"],
            check=True,
        )
        CADDY.chmod(0o755)

    BASIC_USER = input("HTTP Basic Auth username: ").strip()
    BASIC_PASS = getpass("HTTP Basic Auth password: ").strip()
    if not BASIC_USER or ":" in BASIC_USER or not BASIC_PASS:
        raise ValueError("Need a username (no colons) and a password.")

    _hashed = subprocess.check_output(
        [str(CADDY), "hash-password", "--plaintext", BASIC_PASS], text=True
    ).strip()
    Path("/content/Caddyfile").write_text(
        f":{UPSTREAM_PORT} {{\n"
        f"\tbasic_auth {{\n\t\t{BASIC_USER} {_hashed}\n\t}}\n"
        f"\treverse_proxy 127.0.0.1:8188\n"
        f"}}\n"
    )
    tunnel_caddy_proc = subprocess.Popen(
        [str(CADDY), "run", "--config", "/content/Caddyfile"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(2)
    _probe = requests.get(
        f"http://127.0.0.1:{UPSTREAM_PORT}/system_stats",
        auth=(BASIC_USER, BASIC_PASS), timeout=10,
    )
    assert _probe.ok and "devices" in _probe.json(), "Local auth proxy health check failed."
    print(f"Caddy: http://127.0.0.1:{UPSTREAM_PORT} -> ComfyUI:8188 (Basic Auth on)")

    # ---------------- Tailscale Funnel ----------------
    if TUNNEL_MODE == "tailscale":
        TS = Path("/content/tailscale")
        TSD = Path("/content/tailscaled")
        if not (TS.is_file() and TSD.is_file()):
            _base = f"tailscale_{TS_VERSION}_amd64"
            subprocess.run(
                ["bash", "-c",
                 f"cd /content && curl -fsSL -o ts.tgz "
                 f"https://pkgs.tailscale.com/stable/{_base}.tgz "
                 f"&& tar -xzf ts.tgz "
                 f"&& install -m755 {_base}/tailscale /content/tailscale "
                 f"&& install -m755 {_base}/tailscaled /content/tailscaled "
                 f"&& rm -rf ts.tgz {_base}"],
                check=True,
            )

        # Persisted state keeps the node identity AND its TLS certificate across
        # sessions. Without it every session is a new node with a new certificate,
        # and Let's Encrypt allows only ~5 duplicate certificates per week per name.
        state_dir = Path("/content/ts-state")
        persisted = False
        if PERSIST_TS_STATE and Path("/content/drive/MyDrive").is_dir():
            state_dir = Path("/content/drive/MyDrive/rgm-tailnet")
            persisted = True
        state_dir.mkdir(parents=True, exist_ok=True)
        sock = state_dir / "tailscaled.sock"
        print(f"Tailscale state: {state_dir} "
              f"({'persisted' if persisted else 'EPHEMERAL'})")
        if not persisted:
            print("  WARNING: new node + new TLS certificate every session.")
            print("  Let's Encrypt allows ~5 duplicate certs/week per hostname;")
            print("  mount Drive (USE_DRIVE in section 2) to persist state instead.")

        _key = os.environ.get("TS_AUTHKEY", "").strip()
        if not _key:
            try:
                from google.colab import userdata
                _key = (userdata.get("TS_AUTHKEY") or "").strip()
            except Exception:
                _key = ""
        if not _key:
            _key = getpass("Tailscale auth key (tskey-auth-...): ").strip()
        if not _key:
            raise RuntimeError("An auth key is required.")

        _log = open("/content/tailscaled.log", "w")
        ts_proc = subprocess.Popen(
            [str(TSD),
             "--tun=userspace-networking",          # Colab has no /dev/net/tun
             f"--state={state_dir / 'tailscaled.state'}",
             f"--statedir={state_dir}",
             f"--socket={sock}",
             "--socks5-server=127.0.0.1:1055"],
            stdout=_log, stderr=subprocess.STDOUT,
        )
        for _ in range(60):
            if sock.exists():
                break
            if ts_proc.poll() is not None:
                raise RuntimeError("tailscaled exited; see /content/tailscaled.log")
            time.sleep(0.5)
        else:
            raise RuntimeError("tailscaled never created its control socket")

        def tails(*args, check=True):
            r = subprocess.run([str(TS), "--socket", str(sock), *args],
                               text=True, capture_output=True)
            if check and r.returncode != 0:
                raise RuntimeError(("tailscale " + " ".join(args[:2]) + ": "
                                    + (r.stderr or r.stdout)).strip()[:1500])
            return r

        r = tails("up",
                  f"--authkey={_key}",
                  f"--hostname={TS_HOSTNAME}",
                  "--accept-dns=false",
                  "--reset",
                  "--timeout=120s",
                  check=False)
        del _key
        if r.returncode != 0:
            raise RuntimeError("tailscale up failed: "
                               + (r.stderr or r.stdout).strip()[:1500])

        status = {}
        for _ in range(90):
            _st = tails("status", "--json", check=False)
            try:
                status = json.loads(_st.stdout or "{}")
            except Exception:
                status = {}
            self_info = status.get("Self") or {}
            if status.get("BackendState") == "Running" and self_info.get("Online", True):
                break
            time.sleep(1)
        else:
            raise RuntimeError(f"Tailscale never reached Running "
                               f"(state={status.get('BackendState')}); "
                               "see /content/tailscaled.log")

        r = tails("funnel", "--bg", "--https=443", "--yes",
                  f"http://127.0.0.1:{UPSTREAM_PORT}", check=False)
        if r.returncode != 0:
            print((r.stderr or r.stdout).strip())
            raise RuntimeError(
                "funnel failed. Enable HTTPS certificates and Funnel in the "
                "Tailscale admin console first (see docs/spike-tailscale-funnel.md §2)."
            )

        dns = ((status.get("Self") or {}).get("DNSName") or "").rstrip(".")
        if not dns:
            _st = tails("status", "--json", check=False)
            dns = ((json.loads(_st.stdout or "{}").get("Self") or {}).get("DNSName") or "").rstrip(".")
        if not dns:
            raise RuntimeError("Could not read the node DNS name from tailscale status")

        URL = f"https://{dns}"
        print()
        print("Funnel URL:", URL)
        print("  stable: identical every session while hostname + tailnet are unchanged")
        print()
        print("HF Space secrets - set ONCE, no restart in future sessions:")
        print("  GATEWAY_UPSTREAM=" + URL)
        print("  GATEWAY_BASIC_AUTH=" + BASIC_USER + ":<password you typed>")
        print()
        print("First use of a new hostname: allow ~60 s for certificate + public DNS.")
        print("In-runtime check (goes out through the tailnet and back):")
        print(f"  curl -sS --socks5-hostname 127.0.0.1:1055 -u {BASIC_USER} "
              f"{URL}/system_stats")
        print()
        print("Funnel config:")
        print(tails("funnel", "status", check=False).stdout.strip() or "(no output)")
        print()
        print("tailscaled log: /content/tailscaled.log")

    # ---------------- Cloudflare quick tunnel (previous behaviour) ----------------
    elif TUNNEL_MODE == "cloudflare":
        CF = Path("/content/cloudflared")
        if not CF.exists():
            subprocess.run(
                ["bash", "-c",
                 "curl -L -o /content/cloudflared "
                 "https://github.com/cloudflare/cloudflared/releases/latest/download/"
                 "cloudflared-linux-amd64"],
                check=True,
            )
            CF.chmod(0o755)

        tunnel_cf_proc = subprocess.Popen(
            [str(CF), "tunnel", "--url", f"http://127.0.0.1:{UPSTREAM_PORT}"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        TUNNEL_URL = None
        for _line in tunnel_cf_proc.stdout:
            _m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", _line)
            if _m:
                TUNNEL_URL = _m.group(0)
                break
        print("Tunnel online:", TUNNEL_URL)
        print("Set these in the HF Space secrets and RESTART the Space:")
        print("  GATEWAY_UPSTREAM=" + str(TUNNEL_URL))
        print("  GATEWAY_BASIC_AUTH=" + BASIC_USER + ":<password you typed>")
```

---

## 4. Run order

1. Sections 1–4 of the notebook (ComfyUI running, `comfy_ready()` true).
2. If you want the certificate to survive sessions: section 2 with **`USE_DRIVE = True`** and run it
   **before** this cell, so `/content/drive/MyDrive` exists when the cell checks for it.
3. Paste and run the cell, `TUNNEL_MODE = "tailscale"`.
4. Type the Basic Auth user/password, then the auth key (or set the Colab secret `TS_AUTHKEY`).
5. Copy the printed `GATEWAY_UPSTREAM` into the Space secret **once**, with `GATEWAY_BASIC_AUTH`
   matching what you typed. Restart the Space this one time.

---

## 5. What to measure (this is the whole point of the spike)

Record these. The ADR only gets updated with numbers, not impressions.

| # | Measurement | How | Why it matters |
|---|---|---|---|
| 1 | Time from cell start to `Funnel URL` printed | wall clock | cold node + cert issuance cost |
| 2 | Gateway `GET /system_stats` latency from the Space | Space log line | Funnel relay overhead per request |
| 3 | Cold `GET /object_info` duration and byte count | Space log (2.2 MB today) | bulk latency through netstack |
| 4 | `/ws` upgrade result | Space log `GET /ws -> 101` | Funnel must pass the Upgrade header |
| 5 | 1024 px generation, end to end | two runs | the actual product path |
| 6 | `/view` bytes + duration | `[rgm-gateway] /view streaming …` / `body delivered` | the historical 12 s killer |
| 7 | Whether the URL is identical after a **new** Colab runtime with Drive mounted | second session | the entire premise |

### Pass criteria

- Two consecutive 1024 px generations persist to chat **and** gallery.
- `/view` completes with `body delivered (N/N bytes)`, no `ECONNRESET`, no duplicate fetch.
- `/ws` returns `101` and progress messages keep flowing.
- The second session, with Drive mounted, prints the **same** `https://…ts.net` URL and the Space
  connects with **no** secret edit and **no** restart.

### Fail criteria (and what each one means)

| Symptom | Meaning | Next move |
|---|---|---|
| `funnel failed` mentioning a certificate or HTTPS | admin console prerequisites missing | fix §2, rerun the cell |
| `BackendState` never `Running` | control plane or DERP unreachable from Colab egress | this is the ngrok situation again → abandon T5 on Colab |
| `/view` takes 30 s+ but completes | Funnel bandwidth, not a bug | measure throughput; decide if tolerable; otherwise T4 |
| `/ws` never upgrades | Funnel does not proxy the upgrade | disqualifying → abandon T5 |
| URL differs on session 2 | state not persisting, or hostname collision (`-1` suffix) | confirm Drive mount, delete the stale node |

---

## 6. Known risks, stated plainly

1. **Funnel is in beta and applies non-configurable bandwidth limits.** Public reports include
   transfers at 20–40 KB/s through the relay path. A 1.4 MB image at 40 KB/s is ~35 s. This is the
   single most likely reason T5 fails, and it is why measurement 6 exists.
2. **Userspace networking is the slow path.** With no kernel TUN, Funnel inbound traffic is handled
   by gVisor's netstack inside `tailscaled`, which Tailscale itself documents as ~5× slower than a
   server bound directly to a tailnet IP. Colab has no `/dev/net/tun`, so this is not avoidable here.
3. **Certificate duplication.** ~5 duplicate certs/week per hostname. Mitigated by persisting the
   state directory; unmitigated if Drive is off.
4. **Node name collision.** If a stale node with the same hostname exists, Tailscale registers
   `<hostname>-1`, which silently changes the URL. The cell prints whatever the daemon reports, so
   compare it against what you expect.
5. **Egress filtering.** Colab may block `controlplane.tailscale.com` or DERP. If so, this is dead
   on Colab and the answer is T4 (named tunnel) after all.

---

## 7. If it fails

Fall back in this order, both already specified in ADR-005:

1. `TUNNEL_MODE = "cloudflare"` in the same cell — restores today's working behaviour with no
   notebook edit.
2. **T4 (named Cloudflare tunnel)** — requires the ~$10/yr domain decision.
3. Live endpoint swap (ADR-005 Layer 1) — gives one paste per session instead of secret + restart,
   and is a prerequisite for every remaining option.
