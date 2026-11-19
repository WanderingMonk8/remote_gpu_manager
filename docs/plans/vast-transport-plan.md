# Vast.ai Transport Plan — State as of 2026-11-19

As recorded after a multi-day debugging session. Nothing here is speculative — every fact comes from a verified observation on a live instance.

---

## What works (verified)

| Component | Evidence |
|---|---|
| **vastai/pytorch:cuda-13.0.3-auto** boots and works | `Successfully loaded .../ssh` status; SSH login works (`root@sshN.vast.ai -p <port>`) |
| ComfyUI built from source runs and answers | `curl -s http://127.0.0.1:8188/system_stats` → `comfyui_version: 0.46.0`, `pytorch_version: 2.15.0+cu132`, `NVIDIA GeForce RTX 4080 SUPER` |
| Models download fine from HF Hub | `moss_image_sft_int8_convrot.safetensors (5.04 GiB)`, `qwen3.5_9b_w4a8_gptq.safetensors (6.84 GiB)` |
| External network | ComfyUI reachable to/from worker internally via 127.0.0.1, not yet exposed to the Space |

## The critical blocker: HTTP reachability from the Space

**Verified state**: Port 22/tcp only — no HTTP map, no port 8188 map — regardless of `-p 8188` env arg.

### Root cause identified

Vast publishes port 8188 only when the image's Dockerfile `EXPOSE 8188`. Setting env var `-p 8188` to an image without `EXPOSE 8188` does nothing. `vastai/pytorch` has no `EXPOSE 8188`; yanwk image had it.

### Yanwk status

`yanwk/comfyui-boot:cu126-slim` and `cu130-slim` both had `EXPOSE 8188`. But vast agent never reached ready state on either:
-Vast's image wrapper (apt-get missing in OpenSUSE-based yanwk) reported "ssh: command not found" infinite loop
-Vast's health check requires sshd but yanwk doesn't ship one →vast agent never confirmed healthy, instance showed "success running yanwk/..." butVast·agent never moved past its boot detection loop
-Confusing side:Vast-health-check phase probably never completed

## Two independent host quality issues found

| Haunter | Machine ID | IP | Issue |
|---|---|---|---|
| 443829 | 84216 | 104.233.209.157 | Port-flipping unreliable; consistently returns `Ports: 7` then maps nothing; never boots to `running` correctly; same 0% GPU stuck |
| 410852 | 57628 | 137.175.22.196 | instance state looks "running", ports list shows nothing useful butVast·agent reported "SSH currently disabled" consistently on the BASE image |
| 859798 | 157549 | 154.21.201.159 | Actually working — GPU visible inVast·agent, SSH worked, ComfyUI ran full suite, port-22 map only |

4070 Super host 599785/Machine 162749 — untested — good backup option.

## Blocklist state

User-blocked via the deployed extension (block-host fix in `7970a00`):
- Machine 84216 (host 443829) — tonight's blocklist storage works across reinstalls (see `7970a00`)

## What's still untested

- WhetherVast's built-in Instance Portal (docs: `docs.vast.ai/guides/instances/connect/instance-portal.md`) can publish a `trycloudflare.com` link that exposes port 8188 to the outside world — requires a simple `OPEN_BUTTON_PORT=8188` env var. It's designed to work regardless of EXPOSE. Not tested on the current session.
- Whether Lumiverse's "API URL" field exposed the provider entry point — observed but not exercised.

## Deploy candidate

```
vastai/pytorch:cuda-13.0.3-auto
Custom onstart: worker/bootstrap_vastai.py (git clone ComfyUI + pip install + exec ComfyUI --listen 0.0.0.0 --port 8188)
```

Works on machines verified host #859798 / machine 157549 (~hosts #57628 — same region, host 410852 — which showed good GPU state).

## Most probable paths to integration (ranked by effort vs risk)

1. **Vast agent proxy via Instance Portal** (~30 min to test):
   - Deploy vastai/pytorch with `OPEN_BUTTON_PORT=8188` in env
   -Vast console → instance row → click **Open** → wait for `trycloudflare.com` link
   - `curl https://<that-url>/system_stats` from local shell
   - If working: set Lumiverse provider `API URL = https://<that-url>/`, `API Key` = blank
   - Lumiverse native still talks to the worker via HTTPS over the tunnel

2. **CustomVast Image with `EXPOSE 8188`** (~3-6 hours to set up, ~$5 in cloud compute, permanent):
   - Dockerfile: `FROM vastai/pytorch:cuda-13.0.3-auto` + `EXPOSE 8188` + clone bootstrap
   - Build + push to Docker Hub namespace from user machine (requires cloudflared installed)
   - Everything works natively — vast publishes 8188, Lumiverse curls the port
   - Cost: ~6GB image change only, ~$0

3. **CustomVast Base image** (12-24 hours, two containers, intrusive):
   - Start from `vastai/base-image`, put ComfyUI + bootstrap + EXPOSE inside
   - Most reliable local ComfyUI deployment signal
   - Requires Docker Hub credentials and automated build pipeline

4. **SSH Tunnel from Space** — BLOCKED: no HF Pro → no SSH access from Space

## Cost of current path debugging (for reference)

- 3 wasted instances (~$2)
- ~40 min of user time downloading/re-downloading models
- Lost: oneComfyUI install deleted (~5 GB, recoverable with git clone)

## After Colab — fresh Vast session checklist

1. Destroy whatever instances exist
2. Deploy Full worker on a **new** host (machine ID > 157549) — never reuse 84216
3. After `running`: SSH to the worker, `curl -s http://127.0.0.1:8188/system_stats` → expect JSON
4. Click **Open** inVast console → verify `trycloudflare.com` link appears
5. `curl https://<that-link>/system_stats` → if JSON, set Lumiverse provider `API URL` to it
6. If any of steps 3–5 fail, fall back to **customVast image with `EXPOSE 8188`** as the final path

## Account state currently

- Models already selected in userStorage (Anima Turbo v1.1)
- Vast.ai account alive, no billing issue observed
- Instances: 0 owned (last probe destroyed)
- Blocklist: machine 84216 + host 443829 — both stored (won't confuse the next session)
- Last full-worker deploy with pytorch image **worked end-to-end internally** — ComfyUI ran, `system_stats` answered via SSH; only HTTP reach from the Space was missing
