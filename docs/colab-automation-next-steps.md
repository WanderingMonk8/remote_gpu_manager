# Colab automation: what's proven, and what it would take

**Status:** implementation resumed locally at the owner's request. The controller,
enclave-backed controls, Drive Picker/cache path and idle-stop safeguards have local
tests; the integrated path has not yet been deployed or verified against a real Space
and Colab runtime. Manual Colab start/stop remains the current operating mode. See
[automation deployment](./automation-deployment.md) for setup and the remaining live gate.

Related: [ADR-006](./adr-006-colab-runtime-lifecycle.md),
[ADR-005](./adr-005-worker-endpoint-resolution.md), [lifecycle API](./lifecycle-api.md).

---

## 1. What is proven

| Capability | Evidence |
|---|---|
| Allocate/delete a free-tier T4 through the Colab API | `runtimes/rgm-*` created and deleted repeatedly |
| Bootstrap a blank runtime from the owner's notebook over the Jupyter API | cells executed, ComfyUI answered `/system_stats` |
| Generate an image (`GENERATE=True`, in-memory) | cell 22 submitted and returned `ok`; its guards raise on failure |
| Publish the worker publicly through Tailscale Funnel | `https://moss-comfy.tailf0a296.ts.net` |
| Enforcement of Basic Auth | `401` without credentials, `200` with |
| The Space can reach the worker | panel: `Gateway OK (200) · Worker OK` |
| Stable hostname across runtimes | state saved from run 1 restored in run 2, same URL |
| Gateway adopts a URL at runtime | `PUT /gateway/v1/upstream` + 9 tests |

The endpoint problem is solved: the Funnel hostname is stable because the tailnet node
identity is carried across runtimes. `GATEWAY_UPSTREAM` is set once.

## 2. Why automation was paused

Manual operation currently wins on both effort and speed:

| | Manual (Colab UI) | Automated (today's tooling) |
|---|---|---|
| Start | Open notebook, Run all | One CLI command afterwards |
| Startup time | ~2–3 min (Drive cache) | ~12–15 min (no Drive, 12 GiB re-download) |
| Browser | Already there | Not needed after the one-time consent |
| Works on mobile | Yes (Colab UI) | No — bootstrap and state live on one PC |
| Stop | Runtime → Disconnect | One command |

Three of the perceived automation drawbacks are artifacts of the local harness, not the design:
per-start browser prompts come from a CLI that ignored the saved refresh token; the PC binding
comes from state living in `tools/`; the per-device URL would not exist once state is central.

The genuine automation wins are narrow: **idle auto-shutdown** and **start-on-demand from a
generation request**. Neither is built.

## 3. Next steps, in dependency order

### 3.1 Move the bootstrap into the Space

Everything currently runs from `tools/colab-bootstrap-probe.py` on the owner's PC. Until the
same work runs inside the Space, automation is tied to one machine and cannot serve mobile.

- Add Python to the Space image and run the bootstrap as a sidecar, or port it to TypeScript.
- Expose it behind the gateway control plane so `POST /gateway/v1/runtime` can allocate,
  bootstrap, and adopt in one call.
- Keeps the Space as the only orchestrator; no client-side setup.

### 3.2 Custody: credentials and tailnet state in the enclave

- OAuth client id/secret/refresh token, `TS_AUTHKEY`, and Basic Auth move from
  `tools/.colab-creds.json` into the Spindle Secure Enclave.
- `tailscaled.state` (node identity, private key) moves from `tools/.tailnet-state` into the
  enclave. It authenticates as the node and must be treated as a secret.
- Fixes the PC binding and guarantees the same Funnel hostname from any device.
- Colab Secrets are **not** an option: `userdata.get` fails headless
  ("Secrets can only be fetched when running from the Colab UI").

### 3.3 Cache weights in Drive via the API

`drive.mount()` blocks headless (no browser), so `USE_DRIVE` is unusable as written. Drive is
reachable through its API instead:

- Add the `drive.file` scope to the consent, alongside `colaboratory`, so one refresh token
  covers both.
- Before the model cell, download the cached weights from
  `MyDrive/Unified_Image_Assets/weights/…` into `/content/Unified_ComfyUI/models/…`. The
  notebook's `acquire_weight` then finds them and skips Hugging Face.
- Effect: startup drops from ~12 minutes to ~2, and can also persist the tailnet state.

### 3.4 UI and idle shutdown

- Extension buttons: Start / Stop / Idle minutes, calling the existing gateway routes.
- Idle auto-stop already exists in the gateway (`PUT /gateway/v1/runtime/idle`); it needs a UI
  and a real work signal from the native generation path.
- Add a "Adopt URL" step so start does not require a Space restart: the controller calls
  `PUT /gateway/v1/upstream` with the returned URL and Basic Auth.

### In progress: advanced workbook controls

- Implemented locally: save a per-user model preference and present the supported MOSS and Anima variants
  before starting a runtime. Display the configured current worker model separately
  from the preference for the next start.
- Map each model to its checkpoint, encoder and VAE. Show saved selections and missing
  files, allow choosing only the missing Drive files, and retain prior selections when
  switching models. Validate the chosen model's requirements before allocating; remove
  the current unconditional MOSS SFT requirement for other model choices.
- Pass the chosen model to the committed final workbook without modifying stored user
  data. Test the model mapping, Drive access preflight and workbook configuration with
  mocks before a minimal-cost live check.
- First release: allow changing the next-start preference while a worker is running.
  Separately investigate an explicit active-worker switch, including queue-idle checks,
  weight restoration, workflow compatibility, rollback and whether the existing worker
  can change model without restarting the runtime. Do not interrupt active jobs.

### Investigate: unexpected runtime expiration

- Distinguish a gateway idle stop, Colab provider termination, a ComfyUI/supervisor
  restart and tunnel or connectivity failure using timestamps and nonsecret logs.
- Verify that actual generation requests use the gateway and update its last-work time,
  that queue activity protects long jobs, and that the saved timeout is applied. Test
  offline with mocks before using any Colab runtime. Check that browser or worker-only
  traffic that bypasses the gateway is not misidentified as gateway-observed work.
- The notebook supervisor monitors child processes; it does not override provider
  lifetime or idle policies. Inspect the official Colab API and plan limits before
  proposing any provider-specific change; do not promise indefinite availability.

### Expanded model catalog

The workbook and extension list CircleStone's Anima Preview, Preview 2, and
Preview 3 Base, plus the community Anima 2.9B Preview v1 in BF16 and INT8.
Comfy-Org's MOSS-Image Base and SFT are offered in both INT8 and BF16; all MOSS
choices use the current W4A8 text encoder and small VAE. BF16 weights need more
GPU/system memory and may not fit the selected GPU. Anima 2.9B is a community
layer expansion, not an official CircleStone version, and requires an up-to-date
ComfyUI. Anima and its derivatives are under CircleStone's non-commercial license.
The added models require gateway model-cache capability 3; earlier gateways are
rejected before allocation. Select the required Drive files before starting.

Sources: [CircleStone model files](https://huggingface.co/circlestone-labs/Anima/tree/main/split_files/diffusion_models),
[Anima 2.9B model card](https://huggingface.co/Gazingstars123/Anima-2.9B),
and [Comfy-Org MOSS-Image model card](https://huggingface.co/Comfy-Org/MOSS-Image).

### Custom Civitai checkpoints

The advanced model list includes Custom Civitai. The user can enter a Civitai
model or version URL, select a published version and a SafeTensors checkpoint,
and save the choice per user. The first supported families are Anima and
MOSS-Image; incompatible or unrecognized base-model metadata is rejected.
Civitai's optional API token is held separately in the encrypted enclave, is never
returned to the UI, and can be removed without removing the model selection.
The selected file overrides the built-in diffusion model on the next startup;
the relevant family encoder and VAE are still required through Drive Picker.

An existing matching Drive copy can be selected separately to avoid downloading
it on each new Colab runtime. Drive MD5 and file size are always checked, and the
Civitai SHA-256 is also checked when published. Without a Drive copy the worker
streams the selected file from Civitai and checks the hash if supplied and the
SafeTensors header. The runtime and network cost depends on the file size; the
file is not automatically written back to Drive. Tokens are passed to the private
worker process and sent only to Civitai, never to redirected storage hosts.
The selected Lumiverse workflow must match the custom model's actual architecture.
The custom choice requires gateway model-cache capability 4, checked before
allocation. Its integration needs a live, explicitly budgeted test; the Civitai
metadata endpoint was unreachable from the development environment during testing.

### Remaining workbook controls

Lumiverse owns generation settings. Do not expose prompt, dimensions, sampler,
seed, or other generation controls in the extension, and do not override native
Lumiverse generation values. The notebook's inline generation remains available
for manual diagnostics; it is disabled during automated startup.

- The advanced panel currently covers next-start model, installation, supervisor,
  VRAM, and startup LoRA download settings. The updated gateway restores only files
  required by the chosen model. Until that gateway is deployed, non-default model
  starts fail before allocation with an update-required message; the original MOSS
  SFT model remains compatible.
- Remaining non-generation controls include reference and LoRA asset management,
  file upload, workflow download, and cleanup. They require functional UI and
  explicit runtime actions rather than merely saved fields: automation skips the
  notebook's cleanup cells and cannot use its browser pickers.
- Changing settings in the current panel applies on the next startup; switching
  an active model or applying live settings requires additional runtime controls.
- Keep credentials masked and user-specific; validate all input and check the
  active queue before disruptive operations. Keep the existing idle protections.

### Investigate: preserving the Colab connection

The current headless bootstrap opens a Jupyter kernel connection to execute the
workbook, then closes it while ComfyUI continues in a separate process. Google
Colab CLI maintainers say the service considers kernel activity and active
connections; they removed a retired client-side keep-alive ping. This is evidence
for testing a connection, not a guarantee that a particular connection will
prevent Colab from reclaiming the runtime.

| Option | Proposed approach | Key uncertainty or tradeoff |
|---|---|---|
| Persistent Jupyter connection | Keep the authenticated kernel connection open from the Space while the worker is running; refresh credentials and reconnect when necessary. | Colab may not count this exact connection as active, and provider limits still apply. No browser is needed. |
| Active notebook task | Run and supervise the actual worker as a foreground notebook execution rather than returning after launching it. | Requires changes to startup, cancellation, and shutdown; its effect on lifetime must be measured. |
| Browser automation | Keep a signed-in Colab notebook open and interact with it, as in [Keep-Colab-Alive](https://github.com/Samyak2/Keep-Colab-Alive). | Requires a maintained browser and Google login; it is unverified whether that notebook attaches to the API-created runtime. Avoid rerunning cells unintentionally. |
| SSH connection | Maintain an authenticated SSH tunnel to the runtime, potentially inspired by [remocolab](https://github.com/demotomohiro/remocolab). | Adds an exposed service and credentials. The archived repository does not establish that SSH keeps today's managed runtimes alive. |
| ComfyUI keep-alive node | Evaluate [ColabKeepAlive](https://github.com/huyl3-cpu/comfyui-sortlist/blob/main/nodes/utility/colab_nodes.py), which can perform GPU/file activity and attempt notebook interactions. | ComfyUI runs outside the notebook kernel in our setup, so notebook calls may fail silently. Its cache cleanup and synthetic GPU work may affect performance and costs. |

**First experiment:** implement the persistent Jupyter connection behind an
explicit, observable lifecycle; expose connected/disconnected status, refresh the
short-lived proxy token, use bounded reconnection, and close it when the user stops
the runtime. The connection and monitoring must not count as generation activity
or reset the manager's own idle shutdown timer. Never silently allocate another
runtime or retry a generation. Keep the manager's stop/recovery protections and
user-selected idle timeout in force.

The first implementation keeps the kernel identifier in gateway memory only.
If the gateway restarts while a runtime is running, the Jupyter status reports
`stopped`; it does not guess which existing kernel belongs to the worker. A new
bootstrap establishes a connection. A connected status confirms a WebSocket,
not that Colab will extend the runtime's lifetime.

Verify connection lifecycle and idle behavior with mocks first. Then, with the
owner's authorization, use one L4 runtime for approximately the 30-40 minute
period in which previous sessions disappeared. Record nonsecret connection,
provider and worker state; use actual generation as appropriate, stop promptly
when the comparison is complete, and report compute-unit use if available. A
single successful run is evidence, not a lifetime guarantee. If it still fails,
consider the active notebook task next; evaluate browser automation, SSH and the
node as separate experiments rather than changing multiple variables at once.

References: [Google's Colab CLI change](https://github.com/googlecolab/google-colab-cli/pull/144),
[Colab runtime API](https://developers.google.com/colab/api/reference/rest/v1beta/runtimes),
and [Colab FAQ](https://research.google.com/colaboratory/faq.html).

## 4. Decision criteria

Resume only if at least one is wanted:

- **Idle auto-shutdown** to stop paying T4-minutes on idle runtimes.
- **Start without the notebook**, including from a phone.
- **Start on demand** when a native generation request arrives.

If none apply, manual Colab is the better tool and this stays parked.

## 5. Risks to keep visible

- **Free-tier policy:** Colab's FAQ reserves the right to terminate free runtimes used as a
  web UI primarily. Allocation works; continued availability is not guaranteed.
- **Re-download cost:** 12.1 GiB per start without the Drive cache (§3.3).
- **Secret spread:** until §3.2 lands, secrets live on one machine, outside the enclave.
