# Communicating with Colab and the Space

This guide describes the automation implemented in this repository and a safe
way to inspect a deployment. Examples use placeholders; they are not real
account identifiers. Runtime APIs and Space behavior can change, so verify the
live deployment and its logs instead of assuming it runs the current branch.

## Components and trust boundaries

1. The Lumiverse extension UI sends commands to its Spindle backend. The backend
   reads per-user credentials from the encrypted enclave and talks to the gateway
   on the Space's loopback interface (`http://127.0.0.1:8189`).
2. The gateway's lifecycle control routes require a bearer control token. It
   exchanges the Google refresh token for a short-lived access token using
   Google's OAuth token endpoint and calls the Colab runtime API. It also calls
   the Drive API for explicitly selected cache files.
3. The gateway launches the private bootstrap worker. It connects to the
   allocated runtime's Jupyter API with the provider's short-lived proxy token,
   runs selected cells from the committed final workbook, and does not mount
   Drive interactively. The workbook starts ComfyUI and a Tailscale Funnel.
4. On successful bootstrap, the gateway adopts the worker's reported HTTPS
   endpoint in memory. Lumiverse sends ComfyUI requests through the loopback
   gateway, which injects the tunnel's Basic Auth. The extension saves the
   recovered tailnet identity in the user's enclave before acknowledging the
   bootstrap result.

A Colab session being allocated, Jupyter being connected, and ComfyUI being
reachable are separate states. `ready` in the runtime status means the provider
has supplied a connection; use worker health to verify the tunnel and ComfyUI.
The deployed gateway may be older than the extension, and capability checks can
refuse a start before allocation until the gateway is updated.

## Credentials and privacy

- Keep the Google OAuth client secret, refresh token, gateway control token,
  Tailscale auth key, tunnel password, proxy tokens, and tailnet identity out of
  Git, logs, screenshots, issue reports, and chat. Do not print environment
  variables, credential-helper output, authorization headers, session URLs, or
  complete bootstrap payloads.
- Store control and Google credentials in the extension's per-user enclave; use
  Space secrets for the gateway's corresponding configuration. The gateway's
  persistent allocation intent is a safety record, not a credential store.
- The Picker uses a web client, browser key, and project number. The runtime uses
  the desktop OAuth client and refresh token. With `drive.file`, existing Drive
  files need to be selected through Picker for this app; do not broaden access
  without the owner's approval.
- Inspect and share only minimal, redacted log lines. Hostnames, runtime IDs,
  file IDs, filenames, usernames, timestamps, prompts and status bodies can be
  sensitive. Replace them with descriptive placeholders before documenting them.

## Start, check and stop

- **Start Colab** performs workbook and cache preflight. For gateway versions
  advertising `bootstrap_allocation: 1`, allocation and bootstrap run as one
  gateway-owned background job. The extension polls its result every 10 seconds.
  A failed or interrupted create can still leave an allocation; do not blindly
  repeat the create. Google's create response is a long-running operation: the
  gateway must inspect its completion or embedded provider error before treating
  an HTTP 200 as an allocated runtime. Inconclusive operations retain the
  allocation fence; an explicit provider refusal can be reported separately.
- **Check runtime** queries the managed runtime and reports provider state,
  worker reachability, Jupyter connection, and job information. **Check worker**
  separately probes `/system_stats` through the gateway. A 502 with
  `upstream_dns_unresolved` on a compatible gateway means DNS lookup failed; it
  does not prove that a hostname changed. Older versions may show only
  `upstream_unreachable`. A newly published Funnel can take time to propagate.
- **Stop Colab** avoids stopping when work or queue state is active or uncertain.
  **Force stop** is for an explicit user-confirmed stop despite that uncertainty.
  Verify that deletion is confirmed and recheck Colab's Manage sessions.
- `allocation_uncertain` is an allocation fence, not proof of an active runtime.
  Use **Recover allocation** only after the user has checked that the previous
  managed runtime is gone and no allocation is still in flight. The gateway
  performs its own checks; a delayed provider create can still be a concern.
- When investigating, prefer read-only status and logs. Do not start another
  runtime merely to inspect an issue. Live tests use the least expensive suitable
  runtime, and should be stopped and checked after use.

## Drive cache and workflows

Existing selected Drive files are checked before allocation and verified during
restore. Files absent from the selection may be downloaded by the workbook into
**temporary Colab storage**. Those downloads are not automatically uploaded to
Drive; an upload helper exists in the repository but is not connected end to end.
The partial-cache restoration fix may require a newer gateway than the one
currently deployed; check the gateway revision before relying on it.

The extension's model preference applies on the next worker start; it does not
change an existing worker. Lumiverse's generation workflow is configured
separately and must name compatible worker files. The workflow download feature
uses live worker inventory and refuses ambiguous choices; it is a starter
workflow, not a record of a successful generation.

## Inspecting the Hugging Face Space

Use the Space owner UI to view **Settings**, **Container logs**, build status,
and persistent-storage configuration. For API inspection, substitute the
owner and Space name locally and authenticate with the owner's existing
Hugging Face access token where required:

- Runtime status: `GET https://huggingface.co/api/spaces/<owner>/<space>/runtime`
- Container log stream: `GET https://huggingface.co/api/spaces/<owner>/<space>/logs/run?tail=<count>`

The log endpoint streams events: consume the needed entries and close the
connection rather than waiting for the response to end. Never paste a token in
an API URL, command history, or shared output. Read stored credentials privately
and print only the nonsecret fields needed for the diagnosis. Confirm the
meaning of logs by correlating their timestamps; do not assume that a prior
startup, snapshot, or worker health check describes the current instance.

## Deploying safely

Extension updates and the Space gateway are separate deployments. The gateway
revision is pinned in the Space's Dockerfile; push the existing Colab branch,
then prepare a Space commit pointing to the intended immutable revision. Do not
create extra branches or replace the Space's persistent storage. A Space push can
restart the application: respect the owner's availability requirement and get
explicit approval for the concrete restart when needed.

Before restarting, verify a **fresh, successful** application snapshot covers
the owner's latest data. The container logs record snapshot creation and
completion; check for failures as well. If the owner has made changes since the
last verified snapshot, wait for a later snapshot or obtain an explicit informed
instruction to proceed. After deployment, check the Space runtime state, HTTP
response, database restore and integrity logs, gateway startup, and with the owner
that recent data is present. A database integrity check alone does not prove that
the latest messages were included. Never delete or reset persistent storage as a
deployment shortcut.

## Source references

- `src/automation.ts`, `src/backend.ts`, `src/frontend.ts`: user-facing control,
  state persistence, and status.
- `host-gateway/gateway.ts`: Colab, Drive, tunnel proxy, and lifecycle routes.
- `tools/colab-bootstrap-worker.py`, `tools/colab-bootstrap-probe.py`,
  `tools/drive-cache.py`: private Jupyter bootstrap and Drive restore.
- `Unified_MOSS_Anima_Colab_Studio_Tailscale_Final.ipynb`: committed workbook.
- `tests/automation.test.ts`, `tests/lifecycle.test.ts`, `tests/test_drive_cache.py`:
  mocked lifecycle and cache checks; these do not replace a live verification.
