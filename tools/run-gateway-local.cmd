@echo off
REM Start the gateway locally for lifecycle testing (ADR-006).
REM Run from the repo root, or from anywhere - it cd's to its own parent.
REM
REM This is a LOCAL test harness. It is not the Space deployment.

setlocal
cd /d "%~dp0.."

REM --- control token -------------------------------------------------------
REM The lifecycle routes require a bearer token. Override by setting
REM GATEWAY_CONTROL_TOKEN before running this script.
if "%GATEWAY_CONTROL_TOKEN%"=="" set GATEWAY_CONTROL_TOKEN=local-dev-token
set GATEWAY_PORT=8189

REM --- upstream ------------------------------------------------------------
REM Required at boot. Lifecycle does not need a live worker; this is only the
REM address the gateway would proxy ComfyUI requests to.
if "%GATEWAY_UPSTREAM%"=="" set GATEWAY_UPSTREAM=http://127.0.0.1:8188

REM --- lifecycle -----------------------------------------------------------
set GATEWAY_LIFECYCLE=1

REM Idle shutdown default (minutes). 0 disables. PRD set: 5, 10, 15, 30.
if "%RUNTIME_IDLE_MINUTES%"=="" set RUNTIME_IDLE_MINUTES=10

echo.
echo   Gateway   http://127.0.0.1:%GATEWAY_PORT%
echo   Upstream  %GATEWAY_UPSTREAM%   (not needed for start/stop)
echo   Lifecycle ON    idle %RUNTIME_IDLE_MINUTES% min
echo   Token     %GATEWAY_CONTROL_TOKEN%
echo.
echo   In a SECOND window:
echo     node tools\test-lifecycle.mjs --token %GATEWAY_CONTROL_TOKEN%
echo.
echo   Stop the runtime at any time:
echo     node tools\test-lifecycle.mjs --token %GATEWAY_CONTROL_TOKEN% --stop-only
echo.

bun run gateway
