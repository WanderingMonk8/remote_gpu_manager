# Spike: Tailscale Funnel as the stable Colab worker URL

**Status:** Executed on Colab 2026-11-19 — **functional pass**. Multiple 1024 px generations went through the Funnel, and the worker survived a Colab disconnect/reconnect. Throughput numbers from §5 are still to be recorded.
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

1. **Enable HTTPS certificates** — admin console → **Network → DNS** → *HTTPS Certificates* →
   **Enable**. Funnel terminates TLS with `tailscale cert` material; without this, `tailscale funnel`
   fails. MagicDNS must be on for the same reason.
2. **Enable Funnel in the policy file** — admin console → **Access controls → JSON editor**.
   The current console has no dedicated Funnel section (the *Policies* page only shows General
   access rules / Tailscale SSH / Auto approvers), so the attribute is added by hand. Append this
   alongside whatever is already in the file — do not replace existing keys:

   ```json
   "nodeAttrs": [
     {
       "target": ["autogroup:member"],
       "attr":   ["funnel"],
     },
   ],
   ```

   A minimal policy file that works is:

   ```json
   {
     "grants": [
       { "src": ["*"], "dst": ["*"], "ip": ["*"] }
     ],
     "nodeAttrs": [
       { "target": ["autogroup:member"], "attr": ["funnel"] }
     ]
   }
   ```

   If `nodeAttrs` already exists, add the object to the existing array instead of adding a second
   `nodeAttrs` key. Then **Save**. Enabling Funnel from the CLI normally opens a browser approval
   page, which Colab cannot show; pre-approving it here is what makes the headless path work.
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

import os, json, re, time, shutil, subprocess
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

        # tailscaled keeps its node key (identity) and its TLS certificates in
        # --statedir, but it also creates a unix socket there. A unix socket
        # cannot be created on the Drive FUSE mount, and a state file on FUSE is
        # unreliable (flock, atomic rename). So it runs entirely on local disk,
        # and the identity files are mirrored to Drive once they are good.
        run_dir = Path("/content/ts-run")
        run_dir.mkdir(parents=True, exist_ok=True)
        sock = run_dir / "tailscaled.sock"

        persist_dir = None
        if PERSIST_TS_STATE and Path("/content/drive/MyDrive").is_dir():
            persist_dir = Path("/content/drive/MyDrive/rgm-tailnet")
            persist_dir.mkdir(parents=True, exist_ok=True)
            restored = []
            src_state = persist_dir / "tailscaled.state"
            if src_state.is_file() and src_state.stat().st_size > 0:
                shutil.copy2(src_state, run_dir / "tailscaled.state")
                restored.append("node identity")
            if (persist_dir / "certs").is_dir():
                shutil.copytree(persist_dir / "certs", run_dir / "certs", dirs_exist_ok=True)
                restored.append("TLS certificate")
            tail = f" - restored {', '.join(restored)}" if restored else " - first run, nothing to restore"
            print(f"Tailscale state: {persist_dir} (persisted){tail}")
        else:
            print("Tailscale state: EPHEMERAL (local disk only)")
            print("  WARNING: new node + new TLS certificate every session.")
            print("  Let's Encrypt allows ~5 duplicate certs/week per hostname;")
            print("  mount Drive (USE_DRIVE in section 2) to persist state instead.")

        def persist_ts_state(why):
            if persist_dir is None:
                return
            src = run_dir / "tailscaled.state"
            if src.is_file() and src.stat().st_size > 0:
                tmp = persist_dir / "tailscaled.state.tmp"
                shutil.copy2(src, tmp)
                os.replace(tmp, persist_dir / "tailscaled.state")
            if (run_dir / "certs").is_dir():
                shutil.copytree(run_dir / "certs", persist_dir / "certs", dirs_exist_ok=True)
            print(f"  persisted to Drive after {why}")

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
             f"--state={run_dir / 'tailscaled.state'}",
             f"--statedir={run_dir}",
             f"--socket={sock}",
             "--socks5-server=127.0.0.1:1055"],
            stdout=_log, stderr=subprocess.STDOUT,
        )

        def ts_log_tail(n=3000):
            try:
                return Path("/content/tailscaled.log").read_text(errors="replace")[-n:]
            except Exception:
                return "(no log)"

        for _ in range(60):
            if sock.exists():
                break
            if ts_proc.poll() is not None:
                raise RuntimeError("tailscaled exited\n" + ts_log_tail())
            time.sleep(0.5)
        else:
            raise RuntimeError("tailscaled never created its control socket\n" + ts_log_tail())

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
                               f"(state={status.get('BackendState')})\n" + ts_log_tail())

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

        # Force certificate issuance now, so a missing HTTPS setting fails here
        # with a readable error instead of silently after the Space connects.
        cert = tails("cert", "--cert-file", str(run_dir / "probe.crt"),
                     "--key-file", str(run_dir / "probe.key"), dns, check=False)
        if cert.returncode != 0:
            print("Certificate warning:", (cert.stderr or cert.stdout).strip()[:800])
        persist_ts_state("certificate issued")

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

### 5.1 Measurement helper

§5 says the ADR only gets numbers, not impressions. Run this after the tunnel cell in the same
runtime; it drives everything through `tailscaled`'s SOCKS5 proxy, so the traffic leaves the node
and comes back through the relay exactly as a remote client's does, and it prints one copyable
block. It reads the Basic Auth password from the tunnel cell's globals when they are still there.

```python
# @title Measure the Funnel path from inside the runtime (numbers only, no secrets printed)
import subprocess, urllib.parse
from getpass import getpass

URL  = (globals().get("URL") or input("Funnel URL: ")).strip().rstrip("/")
USER = globals().get("BASIC_USER") or input("Basic Auth user: ").strip()
PASS = globals().get("BASIC_PASS") or getpass("Basic Auth password: ")
PROXY = "socks5h://127.0.0.1:1055"   # tailscaled userspace proxy: leaves and re-enters via the relay

def curl(*args, timeout=300):
    cmd = ["curl", "-sS", "--proxy", PROXY, "-u", f"{USER}:{PASS}",
           "--max-time", str(timeout), *args]
    r = subprocess.run(cmd, text=True, capture_output=True)
    return r.returncode, r.stdout, r.stderr.strip()

def timed(path, timeout=300):
    """-> (http_code, seconds, bytes) or None"""
    rc, out, err = curl("-o", "/dev/null",
                        "-w", "%{http_code} %{time_total} %{size_download}",
                        URL + path, timeout=timeout)
    parts = out.split()
    if rc != 0 or len(parts) != 3:
        print(f"  {path} FAILED rc={rc} {err[:300]}")
        return None
    code, secs, size = int(parts[0]), float(parts[1]), int(float(parts[2]))
    return code, secs, size

def rate(size, secs):
    return f"{size/1e6:.2f} MB in {secs:.1f} s ({size/1e6/max(secs,1e-9):.3f} MB/s)"

print("NOTE: this measures node -> relay -> funnel -> node, which is slower than")
print("      the Space -> funnel path. Treat it as an upper bound.\n")

stats = [timed("/system_stats") for _ in range(3)]
print("1. /system_stats   ", [f"{s[1]*1000:.0f} ms" for s in stats if s])

print("2. /object_info (cold-ish: this may hit ComfyUI's cache)")
oi = timed("/object_info", timeout=600)
if oi:
    print("   ", rate(oi[2], oi[1]))

print("3. /ws upgrade")
rc, out, err = curl("-i", "-o", "-", "--max-time", "10", "--http1.1",
                    "-H", "Connection: Upgrade", "-H", "Upgrade: websocket",
                    "-H", "Sec-WebSocket-Version: 13",
                    "-H", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
                    URL + "/ws?clientId=spike")
first = (out.splitlines() or ["(no response)"])[0].strip()
print("   ", first if first else err[:300])

print("4. /view (last image in ComfyUI history)")
rc, hist, err = curl(URL + "/history", timeout=120)
view_line = "   (no image found)"
try:
    import json
    h = json.loads(hist or "{}")
    newest = list(h.values())[-1]
    imgs = [i for o in (newest.get("outputs") or {}).values()
            for i in (o.get("images") or [])]
    if imgs:
        im = imgs[0]
        q = urllib.parse.urlencode({"filename": im["filename"],
                                    "subfolder": im.get("subfolder", ""),
                                    "type": im.get("type", "output")})
        v = timed("/view?" + q, timeout=600)
        if v:
            view_line = "   " + rate(v[2], v[1])
except Exception as exc:
    view_line = f"   (history parse failed: {exc})"
print(view_line)

print("\n" + "=" * 60)
print("copy this block into the chat / the spike document:")
print("=" * 60)
print(f"funnel_url        = {URL}")
print("system_stats      = " + ", ".join(f"{s[1]*1000:.0f} ms" for s in stats if s))
print(f"object_info       = {rate(oi[2], oi[1]) if oi else 'failed'}")
print(f"ws_upgrade        = {first}")
print(f"view              = {view_line.strip()}")
print("=" * 60)
print("Also copy these lines from the Space log if present:")
print("  [rgm-gateway] GET /ws -> 101")
print("  [rgm-gateway] /view streaming")
print("  [rgm-gateway] /view body delivered")
```

Treat these as an **upper bound** on latency: node → relay → funnel → node is one extra leg that
the Space does not pay. The authoritative `/view` figures are the gateway's own
`/view streaming` / `body delivered` log lines from the Space.

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
6. **The state directory is mirrored, not mounted.** `tailscaled` creates a unix socket inside its
   state directory, and Google Drive's FUSE mount cannot host sockets — a socket there makes the
   daemon exit within a second of starting. It is also a poor home for the state file itself, which
   relies on `flock` and atomic rename. The cell therefore runs `tailscaled` entirely on
   `/content/ts-run` and copies the node key and the TLS certificate to Drive once they are good.
   Consequence: if the runtime dies abruptly *before* the cell finishes, the last saved identity is
   from the previous run — harmless, but the funnel may need to re-register.

---

## 7. If it fails

Fall back in this order, both already specified in ADR-005:

1. `TUNNEL_MODE = "cloudflare"` in the same cell — restores today's working behaviour with no
   notebook edit.
2. **T4 (named Cloudflare tunnel)** — requires the ~$10/yr domain decision.
3. Live endpoint swap (ADR-005 Layer 1) — gives one paste per session instead of secret + restart,
   and is a prerequisite for every remaining option.

---

## 8. Result (2026-11-19)

**Functionally proven on Colab.** The owner ran the fixed cell (local-disk `tailscaled`, Drive mirror
of identity + certs) and reported:

- The Funnel URL came up and the Space reached the worker through it with no per-session change.
- **Multiple 1024 px images generated end to end** through the tunnel.
- **Colab disconnected and reconnected, and it still worked** — the failure mode this spike exists
  to eliminate (new hostname every session → secret edit + Factory restart) did not occur.

That settles the two questions that could have killed T5 outright: Funnel egress and control plane
are reachable from Colab (risk 5), and the relay path carries a real generation session rather than
just a health check.

Still open, in priority order:

1. **Was the post-reconnect runtime a fresh VM?** If Colab only reattached to the same VM, the tunnel
   process never restarted and measurement 7 is not proven yet. The discriminator is the cell's own
   first line after rerun: `restored node identity, TLS certificate` (fresh VM, state came off Drive)
   versus `first run, nothing to restore` (Drive not mounted, or same VM).
2. **Numbers 1–6** from §5.1, plus the Space-side `/view streaming` and `body delivered` lines.
   Until they exist, T5 is "selected and working", not "accepted": risk 3 (Funnel bandwidth) is
   untested against a 1.3–1.4 MB body, and the historical failure was a slow body, not a broken one.
3. **`/ws` upgrade through the Funnel.** Lumiverse progress streaming depends on it. If it fails,
   generation still works but the client loses live progress.
4. **Certificate reuse across sessions.** One reconnect does not prove it; the proof is no new
   issuance while the Drive copy is restored. `tailscale cert` prints a warning on failure, so a
   clean run means the cached pair was accepted.

If 1–3 hold, T5 moves to accepted in ADR-005 §13 and the notebook's `cloudflare` branch becomes the
documented rollback rather than a parallel option.
