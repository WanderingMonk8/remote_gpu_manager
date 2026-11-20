# Lifecycle control API (gateway)

Start and stop the Colab runtime from the extension. Implemented per
[ADR-006](./adr-006-colab-runtime-lifecycle.md); the gateway is the only component
that talks to Google.

**Lifecycle routes are manual-mode by default.** The `/gateway/v1/runtime*` routes return
`403 lifecycle_disabled` unless the gateway is started with `GATEWAY_LIFECYCLE=1`. The
upstream route below is always available (control-token gated) because a manually started
worker still needs to be published to the gateway.

All routes live on the existing loopback control plane and require
`Authorization: Bearer $GATEWAY_CONTROL_TOKEN`.

| Method | Path | Effect |
|---|---|---|
| `POST` | `/gateway/v1/runtime/credentials` | Store Colab OAuth credentials **in memory** |
| `DELETE` | `/gateway/v1/runtime/credentials` | Wipe them (restart, rotation, shutdown) |
| `POST` | `/gateway/v1/runtime` | Start: allocate a runtime, wait for `connectionInfo` |
| `GET` | `/gateway/v1/runtime` | Status, adopted runtime, idle countdown |
| `DELETE` | `/gateway/v1/runtime` | Stop: delete and **confirm** deletion |
| `PUT` | `/gateway/v1/runtime/idle` | Set idle minutes (`0` disables) |
| `POST` | `/gateway/v1/runtime/bootstrap` | Bootstrap the owned runtime (separate opt-in; see below) |
| `PUT` | `/gateway/v1/upstream` | Adopt a worker URL (HTTPS + host allowlist) |
| `GET` | `/gateway/v1/upstream` | Read the current upstream |

## Adopting a worker URL

The bootstrap returns a Funnel URL on every start. The Space hands it to the gateway so
proxied generation reaches the new worker without editing a secret:

```json
PUT /gateway/v1/upstream
{"url": "https://moss-comfy.tailf0a296.ts.net", "basic_auth": "user:password"}
```

- **HTTPS only.** `basic_auth` is optional; when present it replaces the upstream
  `Authorization`, because the tunnel's Caddy password changes per deployment.
- **Host allowlist.** The host must end in `.ts.net` or `.trycloudflare.com` (override
  with `GATEWAY_UPSTREAM_ALLOW`, comma-separated). This keeps the gateway from becoming
  an arbitrary-URL proxy.
- **In memory only.** A gateway restart falls back to `GATEWAY_UPSTREAM` from the
  environment, so a restart needs the secret or another adoption call.
- **Tested:** adoption actually repoints the proxy (two mock workers with different
  versions), wrong credentials surface `401`, malformed `basic_auth` is refused without
  changing state, and disallowed hosts are rejected.

Errors: `401 control_auth_required`, `400 url_invalid | https_required | basic_auth_invalid`,
`403 host_not_allowed`.

## Credentials custody

The extension reads the OAuth client id/secret and refresh token from the Spindle
enclave and posts them once per gateway boot:

```json
POST /gateway/v1/runtime/credentials
{"client_id": "...", "client_secret": "...", "refresh_token": "..."}
```

They are held in module memory only. They are never written to disk, never logged,
and never echoed in a response. The short-lived Google access token is refreshed
on demand and cached until 60 s before expiry.

## Bootstrap worker (experimental)

When `GATEWAY_BOOTSTRAP=1`, the authenticated control plane accepts a bootstrap
request containing `ts_authkey`, `basic_user`, `basic_pass`, and `state` (a map
of saved Tailscale state files to base64 strings). It retrieves the owned
runtime's current connection token, starts `tools/colab-bootstrap-worker.py`
through private stdio, then validates and adopts the returned Funnel hostname.
The response contains `state`, which is sensitive and must be saved in the
Spindle enclave by the caller. Do not log or display it. Python and the
`websocket-client` package are required in the host environment.

The POST returns `202` immediately; poll `GET /gateway/v1/runtime/bootstrap`
until `status` is `finished`. Its `httpStatus` and `result` contain the outcome.
The caller must persist the returned state securely before clearing the result
with `DELETE /gateway/v1/runtime/bootstrap`. Only one result is held, in memory;
it is lost on gateway restart. The extension does not yet store or send these
credentials or persist the returned state, so this is not yet a complete or
restart-safe automation flow. Allocation recovery is not durable. The result
includes `workerHealthy`, an authenticated gateway-to-worker health check;
the caller must save state even when this check fails.
Keep this feature disabled until those gaps are addressed. No production
Space deployment is implied by its presence in the repository.

## Start

```json
POST /gateway/v1/runtime  ->  200
{
  "runtime": {
    "name": "runtimes/rgm-gw-1a2b3c4d",
    "url": "https://8080-gpu-t4-s-....colab.dev",
    "spec": {"variant": "VARIANT_GPU", "accelerator": "T4", "shape": "SHAPE_STANDARD"},
    "adoptedAt": "2026-11-20T08:00:00.000Z",
    "tokenExpiresAt": "2026-11-20T09:00:00.000Z",
    "tokenPresent": true
  },
  "state": "ready"
}
```

- Single-flight: a second `POST` while one is in progress returns `409 provisioning_in_progress`.
- A `POST` while already ready returns `200` with `"reused": true` — no second allocation.
- Before creating, the gateway lists manager-prefixed runtimes and reuses an existing
  one; if there are multiple, it refuses with `multiple_owned_runtimes` for manual
  reconciliation. This is not an interprocess lock: run only one controller.
- If the create request has an ambiguous transport or server failure, further starts
  in that process fail with `allocation_uncertain`. Inspect Colab before recovery.
  This guard is in memory and does not survive a restart, so it is not yet a durable
  solution for delayed or eventually consistent allocation.
- After a successful create, the gateway retains the runtime handle even when
  connection polling fails, allowing status and stop to find it.
- Only runtimes named `rgm-gw-*` are ever created, adopted or deleted. Another
  session's runtime is never touched.
- `connectionInfo.token` is a short-lived credential and is deliberately **not**
  returned. `GET` refreshes it inside the gateway.

## Status

```json
GET /gateway/v1/runtime  ->  200
{
  "runtime": {...} | null,
  "state": "starting" | "ready" | "offline",
  "idle": {"minutes": 10, "lastWorkAt": "...", "remainingSeconds": 542}
}
```

If the runtime was created by this gateway before a restart, `GET` adopts it from
`GET /v1beta/runtimes` rather than allocating a second one. If Colab deleted it
outside the gateway (idle reaping, quota), `state` becomes `offline`.

## Stop

```json
DELETE /gateway/v1/runtime  ->  200
{"deleted": true, "name": "runtimes/rgm-gw-1a2b3c4d", "confirmed": true}
```

Deletion is re-checked with `GET` before reporting success (PRD R-06: status must
confirm deletion, not a stop request). If the delete is accepted but the runtime
is still listed, the gateway returns `202` with `"confirmed": false` instead of
claiming success.

## Idle shutdown

```json
PUT /gateway/v1/runtime/idle   {"minutes": 10}
```

- `5`, `10`, `15`, `30` or `0` (disabled) — the PRD R-06 set. Sub-minute values are
  accepted for tests and diagnostics.
- "Real work" is submission (`POST /prompt`), result retrieval (`GET /view`,
  `GET /history/{id}`), authorized asset installation (`POST /upload/image`), and
  an active WS session. `GET /queue` polling is **not** work.
- Before deleting, the timer re-reads `/queue` and holds the runtime if anything is
  running or pending (PRD R-05).
- If the queue cannot be read, the runtime is **kept**. Fail-safe, never fail-open.
- No heartbeat traffic is generated to defeat Colab's own idle enforcement.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_LIFECYCLE` | unset (off) | `1` enables every route above |
| `COLAB_BASE` | `https://colaboratory.googleapis.com` | API base (tests point at a mock) |
| `OAUTH_TOKEN_URL` | `https://oauth2.googleapis.com/token` | Token endpoint |
| `RUNTIME_ACCELERATOR` | `T4` | Requested accelerator |
| `RUNTIME_SHAPE` | `STANDARD` | Requested shape |
| `RUNTIME_IDLE_MINUTES` | `10` | Initial idle timeout |
| `RUNTIME_CREATE_TIMEOUT_MS` | `300000` | How long to wait for `connectionInfo` |
| `RUNTIME_IDLE_CHECK_MS` | `30000` | Timer resolution |

## Typed errors (PRD §5)

| Code | Status | Cause |
|---|---|---|
| `lifecycle_disabled` | 403 | `GATEWAY_LIFECYCLE` not set |
| `auth_required` | 401 | No credentials, or Google refused the refresh |
| `policy_restricted` | 403 | `FAILED_PRECONDITION` — tier, quota or stock |
| `quota_exceeded` | 429 | Google rate limit |
| `offline` | 502/503 | Colab unreachable |
| `timeout` | 504 | Created but `connectionInfo` never appeared |
| `provisioning_in_progress` | 409 | Concurrent start |
| `multiple_owned_runtimes` | 409 | More than one manager-prefixed runtime requires manual reconciliation |
| `allocation_uncertain` | 409 | A create may have succeeded despite an ambiguous failure |
| `no_owned_runtime` | 404 | Stop with nothing owned |
| `idle_minutes_invalid` | 400 | Not in the R-06 set |

## Not done here

- **Bootstrap.** Allocation gets a machine; it does not get *our* stack onto it.
  How the notebook cells execute on an API-created runtime is unresolved
  (ADR-006 §4). Until then, start/stop is proven for the machine, not for a
  ready-to-generate worker.
- **Publishing.** `connectionInfo.url` is the Jupyter proxy on port 8080, not
  ComfyUI on 8188. Whether the proxy routes by port prefix is untested.
- **Free-tier policy.** An API-created runtime driven through a web UI is the
  shape Colab's FAQ reserves the right to terminate on the free tier. Allocation
  works; continued availability is not guaranteed.
