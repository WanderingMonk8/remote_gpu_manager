# Colab automation: deployment and first verification

This is a local implementation and has not yet been verified end to end on the
Space. Follow the existing gateway patch in `space-gateway-patch.md` first.
Changes to the deployed Space need the owner's explicit approval.

## Space image and settings

The local `Space.Dockerfile` reference already installs Python 3 and
`python3-venv`, and builds the gateway from `/opt/remote-gpu-manager`. Add the
following after the gateway build block and before `ENV GATEWAY_PORT=8189`:

```dockerfile
RUN python3 -m venv /opt/rgm-venv \
    && /opt/rgm-venv/bin/pip install --no-cache-dir websocket-client
ENV GATEWAY_LIFECYCLE=1 \
    GATEWAY_BOOTSTRAP=1 \
    GATEWAY_BOOTSTRAP_PYTHON=/opt/rgm-venv/bin/python \
    GATEWAY_BOOTSTRAP_SCRIPT=/opt/remote-gpu-manager/tools/colab-bootstrap-worker.py \
    RUNTIME_INTENT_FILE=/app/data/rgm/runtime-intent.json
```

Add `mkdir -p /app/data/rgm` inside `start_rgm_gateway`, immediately before
`bun run /opt/remote-gpu-manager/dist-host/gateway.mjs &`, so the directory is
created after the persistent volume is mounted. The checkout must include the
notebook and `tools/` files, not only `dist-host/`. The intent file stores
only the manager runtime name; do not place credentials there. Persistent
storage must survive restarts for allocation fencing to work.

The reference Dockerfile currently clones `main`; the implementation commits
must first be made available on the branch that the Space builds. The locally
checked-out archive branch alone is not available to the remote Space.

Set `GATEWAY_CONTROL_TOKEN` as a Space secret. The same token is entered in the
extension's credential form and saved in the per-user enclave. Keep the gateway
bound to loopback. A configured initial `GATEWAY_UPSTREAM` is still required;
the controller adopts the new endpoint after bootstrap.

## Google setup and credentials

1. Enable the Colab, Drive, and Google Picker APIs on the same Google Cloud
   project. Create a web OAuth client and browser API key with appropriate
   restrictions for the Space origin, and note the project number. Google Picker
   needs the web client, API key and project number; see [Google's Picker guide](https://developers.google.com/workspace/drive/picker/guides/web-picker).
2. Grant the existing desktop OAuth client both the Colab and `drive.file`
   scopes. The local helper supports `python tools/colab-runtime-api.py creds
   --drive-file`; it opens Google's consent flow and writes a gitignored local
   credential file. Treat that file as a secret and remove it after transferring
   its values into the extension's credential form.
3. In the extension, save the gateway token, desktop OAuth client ID and secret,
   refresh token, Tailscale auth key, and desired tunnel Basic Auth credentials.
   These values are stored in the user's enclave. Enter the web client ID, API
   key and project number in the Picker form, then select the MOSS SFT checkpoint,
   Qwen encoder and VAE files from the existing Drive cache.

The web and desktop OAuth clients must belong to the same project, and the
Picker must use the same Google account as the refresh token. `drive.file`
does not grant access to arbitrary existing Drive files: select the actual
cache files through Picker. The gateway checks their access and metadata before
allocating a runtime, and the worker verifies size and checksum while restoring
them. Start is intentionally refused until a complete MOSS SFT selection exists.

## First live check

After deployment approval and setup, use one runtime for the complete test:
start, wait for bootstrap and the authenticated health result, verify the
stable endpoint, then stop and confirm deletion. Keep the run short; if a check
fails, stop the owned runtime before investigating. Normal stop refuses active
or unknown work. Force stop is explicitly confirmed and is available if an
offline worker makes the queue unavailable. Check the Colab runtime list after
the test, including after any failed or ambiguous allocation.

The Picker integration, Drive scope propagation, Space CSP, real cache restore,
enclave persistence, and live Space-to-worker path still require verification.
The bootstrap result is held in gateway memory until the extension saves the
Tailscale identity; a Space restart before that save can lose the result. Do
not treat this as a fully restart-safe release yet.
