# Space gateway patch — additive blocks only

> The Space's Dockerfile is **private and deliberately not in this repository** (owner decision, 2026-11-17). This file contains only the blocks to add to it, nothing else. Apply by hand to your own copy of the Dockerfile.

## Add to the build stage (after the app build, before any sidecar stages)

```dockerfile
# ---------------------------------------------------------------------------
# Remote GPU Manager gateway — localhost-only sidecar (extension backend)
# ---------------------------------------------------------------------------
# Authenticated reverse proxy between Lumiverse's native ComfyUI provider and
# the user-managed warm GPU worker. Loopback-only; the public port is unchanged.
# No credentials live in this file: GATEWAY_UPSTREAM and the upstream Basic
# Auth credentials are HF Space secrets (Settings -> Variables and secrets).
ARG RGM_BRANCH=main

# Cache-bust when the gateway is updated upstream.
ADD https://api.github.com/repos/WanderingMonk8/remote_gpu_manager/commits/${RGM_BRANCH} \
    /tmp/rgm-commit.json

RUN git clone \
    --branch "${RGM_BRANCH}" \
    --single-branch \
    --depth 1 \
    https://github.com/WanderingMonk8/remote_gpu_manager \
    /opt/remote-gpu-manager \
    && test -f /opt/remote-gpu-manager/dist-host/gateway.mjs

ENV GATEWAY_PORT=8189
```

## Add to the startup script (before the Lumiverse launch section)

```sh
# Remote GPU Manager gateway (loopback-only; optional from Lumiverse's
# perspective). If it fails, Lumiverse still starts normally; the extension
# and the native connection simply cannot reach the worker until it is back.
RGM_GATEWAY_PID=""

start_rgm_gateway() {
    echo "===== Remote GPU Manager gateway startup ====="
    if [ -z "${GATEWAY_UPSTREAM:-}" ]; then
        echo "[rgm-gateway] GATEWAY_UPSTREAM not set; gateway stays down (manual worker mode)."
        return 0
    fi
    if [ -z "${GATEWAY_BASIC_AUTH:-}" ]; then
        echo "[rgm-gateway] WARNING: GATEWAY_BASIC_AUTH not set; the upstream worker will reject the gateway."
    fi

    bun run /opt/remote-gpu-manager/dist-host/gateway.mjs &
    RGM_GATEWAY_PID=$!

    for attempt in $(seq 1 30); do
        http_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GATEWAY_PORT:-8189}/system_stats" || true)"
        # Any non-zero HTTP status (even 502 upstream-unreachable) means the
        # gateway process is up and serving; upstream outage is reported by
        # the gateway's status endpoint, not by refusing to start.
        if [ -n "$http_code" ] && [ "$http_code" != "000" ]; then
            echo "[rgm-gateway] Ready on 127.0.0.1:${GATEWAY_PORT:-8189} (upstream /system_stats -> $http_code)."
            return 0
        fi

        if ! kill -0 "$RGM_GATEWAY_PID" 2>/dev/null; then
            echo "[rgm-gateway] WARNING: process exited during startup."
            wait "$RGM_GATEWAY_PID" 2>/dev/null || true
            RGM_GATEWAY_PID=""
            return 1
        fi

        sleep 1
    done

    echo "[rgm-gateway] WARNING: gateway did not answer within 30 seconds."
    return 1
}
```

## Call it after the other sidecar launches

```sh
start_rgm_gateway || true
```

## In the shutdown handler (after the other sidecar shutdowns)

```sh
	if [ -n "${RGM_GATEWAY_PID:-}" ]; then
		echo "[shutdown] Stopping Remote GPU Manager gateway..."
		kill -TERM "$RGM_GATEWAY_PID" 2>/dev/null || true
		wait "$RGM_GATEWAY_PID" 2>/dev/null || true
	fi
```

## In the trailing build guards

```sh
    && grep -Fq 'start_rgm_gateway' /usr/local/bin/start-lumiverse.sh \
```

## Reminder

- `GATEWAY_UPSTREAM` / `GATEWAY_BASIC_AUTH` / `GATEWAY_CONTROL_TOKEN` are set in the Space's Variables and secrets, never in the Dockerfile or git.
- Gateway readiness = any non-`000` HTTP response (even `502` from an offline worker); `401` = wrong/missing upstream creds; `200` = worker warm and authenticated.
- Bash-syntax-check your edited startup script before pushing (`bash -n`).
