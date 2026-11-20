/**
 * M4 lifecycle adapter tests (ADR-006): Colab runtime start/stop behind
 * GATEWAY_LIFECYCLE, against a mock Colab API and mock worker.
 *
 * Covers:
 *   1. capability flag off -> 403 lifecycle_disabled (manual mode is default)
 *   2. start without credentials -> 401 auth_required
 *   3. credentials stored; start -> ready; token never leaves the gateway
 *   4. status refreshes; stop confirms deletion (PRD R-06); foreign runtimes untouched
 *   5. idle shutdown after configurable inactivity (R-06); queue depth holds (R-05)
 *   6. create refusal maps to policy_restricted
 *   7. credentials wipe -> next start 401
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { bundledWorkbook } from "../src/workbook";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Randomized high ports so concurrent/leftover instances never collide.
// Integration suite uses 19200+pid%400; this file starts above its range.
const PORT_BASE = 24000 + Math.floor(Math.random() * 15000);
const COLAB_PORT = PORT_BASE;
const COLAB_FAIL_PORT = PORT_BASE + 1;
const MOCK_PORT = PORT_BASE + 2;
const MOCK_BUSY_PORT = PORT_BASE + 3;
const GW_PORT = PORT_BASE + 4;
const GW_OFF_PORT = PORT_BASE + 5;
const GW_FAIL_PORT = PORT_BASE + 6;
const GW_BUSY_PORT = PORT_BASE + 7;
const CONTROL_TOKEN = "control-test-token-0123456789abcdef";
const REFRESH = "ref-secret-do-not-leak";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn().catch(() => false)) return;
    await sleep(75);
  }
  throw new Error("Timed out waiting for condition");
}

let colab: Subprocess | null = null;
let colabFail: Subprocess | null = null;
let comfy: Subprocess | null = null;
let comfyBusy: Subprocess | null = null;
let gw: Subprocess | null = null;
let gwOff: Subprocess | null = null;
let gwFail: Subprocess | null = null;
let gwBusy: Subprocess | null = null;

const base = () => `http://127.0.0.1:${GW_PORT}`;
const baseOff = () => `http://127.0.0.1:${GW_OFF_PORT}`;
const baseFail = () => `http://127.0.0.1:${GW_FAIL_PORT}`;
const baseBusy = () => `http://127.0.0.1:${GW_BUSY_PORT}`;
const colabBase = () => `http://127.0.0.1:${COLAB_PORT}`;

const auth = { Authorization: `Bearer ${CONTROL_TOKEN}` };

async function ensureCreds(atBase: string): Promise<void> {
  const res = await fetch(`${atBase}/gateway/v1/runtime/credentials`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "cid", client_secret: "sec", refresh_token: REFRESH }),
  });
  if (!res.ok) throw new Error(`ensureCreds failed: ${res.status}`);
}

function spawnGateway(port: number, colabPort: number | null, upstream: string, extraEnv: Record<string, string> = {}) {
  return Bun.spawn(["bun", "host-gateway/gateway.ts"], {
      env: {
        ...process.env,
        GATEWAY_PORT: String(port),
        GATEWAY_UPSTREAM: upstream,
        GATEWAY_BASIC_AUTH: "lumiverse:test-secret",
        GATEWAY_CONTROL_TOKEN: CONTROL_TOKEN,
        ...extraEnv,
        ...(colabPort !== null
          ? {
              GATEWAY_LIFECYCLE: "1",
              COLAB_BASE: `http://127.0.0.1:${colabPort}`,
              OAUTH_TOKEN_URL: `http://127.0.0.1:${colabPort}/token`,
              DRIVE_BASE: `http://127.0.0.1:${colabPort}/drive/v3`,
              RUNTIME_IDLE_CHECK_MS: "500",
            }
          : {}),
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
}

beforeAll(async () => {
  colab = Bun.spawn(["bun", "tests/mock-colab/server.ts"], {
    env: { ...process.env, MOCK_COLAB_PORT: String(COLAB_PORT), MOCK_FOREIGN: "1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  colabFail = Bun.spawn(["bun", "tests/mock-colab/server.ts"], {
    env: { ...process.env, MOCK_COLAB_PORT: String(COLAB_FAIL_PORT), MOCK_CREATE_FAIL: "1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  comfy = Bun.spawn(["bun", "tests/mock-comfyui/server.ts"], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_USER: "lumiverse", MOCK_PASS: "test-secret", MOCK_EXECUTION_MS: "100" },
    stdout: "ignore",
    stderr: "ignore",
  });
  comfyBusy = Bun.spawn(["bun", "tests/mock-comfyui/server.ts"], {
    env: { ...process.env, MOCK_PORT: String(MOCK_BUSY_PORT), MOCK_USER: "lumiverse", MOCK_PASS: "test-secret", MOCK_EXECUTION_MS: "100", MOCK_QUEUE_DEPTH: "2" },
    stdout: "ignore",
    stderr: "ignore",
  });
  gw = spawnGateway(GW_PORT, COLAB_PORT, `http://127.0.0.1:${MOCK_PORT}`);
  gwOff = spawnGateway(GW_OFF_PORT, null, `http://127.0.0.1:${MOCK_PORT}`);
  gwFail = spawnGateway(GW_FAIL_PORT, COLAB_FAIL_PORT, `http://127.0.0.1:${MOCK_PORT}`);
  gwBusy = spawnGateway(GW_BUSY_PORT, COLAB_PORT, `http://127.0.0.1:${MOCK_BUSY_PORT}`);

  await waitFor(async () => (await fetch(`${base()}/system_stats`)).ok);
  await waitFor(async () => (await fetch(`${baseOff()}/system_stats`)).ok);
  await waitFor(async () => (await fetch(`${baseFail()}/system_stats`)).ok);
  await waitFor(async () => (await fetch(`${baseBusy()}/system_stats`)).ok);
  await waitFor(async () => (await fetch(`${colabBase()}/v1beta/runtimespecs`)).ok);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${COLAB_FAIL_PORT}/v1beta/runtimespecs`)).ok);
}, 30_000);

afterAll(() => {
  gw?.kill("SIGKILL");
  gwOff?.kill("SIGKILL");
  gwFail?.kill("SIGKILL");
  gwBusy?.kill("SIGKILL");
  colab?.kill("SIGKILL");
  colabFail?.kill("SIGKILL");
  comfy?.kill("SIGKILL");
  comfyBusy?.kill("SIGKILL");
});

describe("capability flag (manual mode is the default)", () => {
  test("lifecycle routes refuse 403 when GATEWAY_LIFECYCLE is unset", async () => {
    const res = await fetch(`${baseOff()}/gateway/v1/runtime`, { method: "POST", headers: auth });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "lifecycle_disabled" });
  });
});

describe("credentials custody (ADR-006)", () => {
  test("start without credentials fails typed auth_required", async () => {
    const res = await fetch(`${base()}/gateway/v1/runtime`, { method: "POST", headers: auth });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("auth_required");
  });

  test("stored credentials work and the token never leaves the gateway", async () => {
    const put = await fetch(`${base()}/gateway/v1/runtime/credentials`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "cid", client_secret: "sec", refresh_token: REFRESH }),
    });
    expect(put.status).toBe(200);

    const start = await fetch(`${base()}/gateway/v1/runtime`, { method: "POST", headers: auth });
    expect(start.status).toBe(200);
    const body = (await start.json()) as any;
    expect(body.runtime.name).toMatch(/^runtimes\/rgm-gw-/);
    expect(body.state).toBe("ready");
    expect(body.runtime.tokenPresent).toBe(true);

    // The fake proxy token, access token and refresh token must not leak.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("mock-proxy-token-SECRET");
    expect(wire).not.toContain("mock-access-token");
    expect(wire).not.toContain(REFRESH);

    // The gateway authenticated to the mock Colab API with the refreshed token.
    const log = await (await fetch(`${colabBase()}/__log`)).json();
    const create = log.calls.find((c: any) => c.method === "POST" && c.path.startsWith("/v1beta/runtimes"));
    expect(create.auth).toBe("Bearer mock-access-token");
  });

  test("wiped credentials force a new auth_required", async () => {
    await fetch(`${base()}/gateway/v1/runtime`, { method: "DELETE", headers: auth }); // release first
    const cleared = await fetch(`${base()}/gateway/v1/runtime/credentials`, { method: "DELETE", headers: auth });
    expect((await cleared.json()).cleared).toBe(true);
    const res = await fetch(`${base()}/gateway/v1/runtime`, { method: "POST", headers: auth });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("auth_required");
  });
});

describe("start / status / stop", () => {
  test("lists eligible GPUs without allocation and starts only a confirmed eligible choice", async () => {
    await ensureCreds(base());
    const before = await (await fetch(`${colabBase()}/__log`)).json();
    const specs = await (await fetch(`${base()}/gateway/v1/runtime/specs`, { headers: auth })).json();
    expect(specs.specs.map((s: any) => s.accelerator)).toEqual(["T4", "L4"]);
    const after = await (await fetch(`${colabBase()}/__log`)).json();
    expect(after.runtimes).toEqual(before.runtimes);
    const start = (body: unknown) => fetch(`${base()}/gateway/v1/runtime`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const noConfirm = await start({ accelerator: "L4", shape: "SHAPE_STANDARD" });
    expect(noConfirm.status).toBe(400);
    expect((await noConfirm.json()).error).toBe("gpu_confirmation_required");
    const unsupported = await start({ accelerator: "A100", shape: "SHAPE_STANDARD", confirm_non_default: true });
    expect(unsupported.status).toBe(403);
    const chosen = await start({ accelerator: "L4", shape: "SHAPE_STANDARD", confirm_non_default: true });
    expect(chosen.status).toBe(200);
    expect((await chosen.json()).runtime.spec.accelerator).toBe("L4");
    expect((await fetch(`${base()}/gateway/v1/runtime`, { method: "DELETE", headers: auth })).status).toBe(200);
  });

  test("Drive preflight checks selected files without allocating a runtime", async () => {
    await ensureCreds(base());
    const files = [
      { id: "a", name: "moss_image_sft_int8_convrot.safetensors" },
      { id: "b", name: "qwen3.5_9b_w4a8_gptq.safetensors" },
      { id: "c", name: "flux2-vae_small.safetensors" },
    ];
    const request = (selected: unknown) => fetch(`${base()}/gateway/v1/runtime/cache-check`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ files: selected }),
    });
    expect((await request(files)).status).toBe(200);
    expect((await request([{ id: "missing", name: files[0].name }])).status).toBe(403);
    const list = await (await fetch(`${colabBase()}/__log`)).json();
    expect(list.runtimes.filter((id: string) => id.startsWith("rgm-gw-"))).toHaveLength(0);
  });

  test("persistent allocation intent permits recovery and clears after confirmed stop", async () => {
    const file = join(tmpdir(), `rgm-intent-${crypto.randomUUID()}.json`);
    const port = PORT_BASE + 11;
    const env = { RUNTIME_INTENT_FILE: file };
    let gateway = spawnGateway(port, COLAB_PORT, `http://127.0.0.1:${MOCK_PORT}`, env);
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitFor(async () => (await fetch(`${url}/system_stats`)).ok);
      await ensureCreds(url);
      const first = await (await fetch(`${url}/gateway/v1/runtime`, { method: "POST", headers: auth })).json();
      expect(existsSync(file)).toBe(true);
      gateway.kill("SIGKILL");
      await gateway.exited;
      gateway = spawnGateway(port, COLAB_PORT, `http://127.0.0.1:${MOCK_PORT}`, env);
      await waitFor(async () => (await fetch(`${url}/system_stats`)).ok);
      await ensureCreds(url);
      const second = await (await fetch(`${url}/gateway/v1/runtime`, { method: "POST", headers: auth })).json();
      expect(second.runtime.name).toBe(first.runtime.name);
      expect(second.reused).toBe(true);
      expect((await fetch(`${url}/gateway/v1/runtime`, { method: "DELETE", headers: auth })).status).toBe(200);
      expect(existsSync(file)).toBe(false);
    } finally {
      gateway.kill("SIGKILL");
      if (existsSync(file)) unlinkSync(file);
    }
  });

  test("unreadable queue prevents normal stop", async () => {
    const port = PORT_BASE + 10;
    const gateway = spawnGateway(port, COLAB_PORT, `http://127.0.0.1:${MOCK_PORT}`, { GATEWAY_BASIC_AUTH: "wrong:wrong" });
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitFor(async () => (await fetch(`${url}/system_stats`)).status === 401);
      await ensureCreds(url);
      expect((await fetch(`${url}/gateway/v1/runtime`, { method: "POST", headers: auth })).status).toBe(200);
      const response = await fetch(`${url}/gateway/v1/runtime`, { method: "DELETE", headers: auth });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("queue_unavailable");
      expect((await fetch(`${url}/gateway/v1/runtime?force=1`, { method: "DELETE", headers: auth })).status).toBe(200);
    } finally { gateway.kill("SIGKILL"); }
  });

  test("bootstrap passes the owned connection privately and adopts the returned endpoint", async () => {
    const port = PORT_BASE + 9;
    const gateway = spawnGateway(port, COLAB_PORT, `http://127.0.0.1:${MOCK_PORT}`, {
      GATEWAY_BOOTSTRAP: "1", GATEWAY_BOOTSTRAP_PYTHON: process.execPath,
      GATEWAY_BOOTSTRAP_SCRIPT: "tests/mock-colab/bootstrap-worker.ts",
      MOCK_BOOTSTRAP_URL: `http://127.0.0.1:${MOCK_PORT}`,
      GATEWAY_UPSTREAM_ALLOW_HTTP: "1", GATEWAY_UPSTREAM_ALLOW: ".0.0.1",
    });
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitFor(async () => (await fetch(`${url}/system_stats`)).ok);
      await ensureCreds(url);
      expect((await fetch(`${url}/gateway/v1/runtime`, { method: "POST", headers: auth })).status).toBe(200);
      const workbook = await bundledWorkbook();
      const headers = { ...auth, "Content-Type": "application/json" };
      expect((await fetch(`${url}/gateway/v1/runtime/workbook-check`, {
        method: "POST", headers, body: JSON.stringify({ workbook }),
      })).status).toBe(200);
      expect((await fetch(`${url}/gateway/v1/runtime/workbook-check`, {
        method: "POST", headers, body: JSON.stringify({ workbook: { ...workbook, sha256: "0".repeat(64) } }),
      })).status).toBe(400);
      expect((await fetch(`${url}/gateway/v1/runtime/workbook-check`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workbook }),
      })).status).toBe(401);
      const response = await fetch(`${url}/gateway/v1/runtime/bootstrap`, {
        method: "POST", headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ ts_authkey: "key", basic_user: "lumiverse", basic_pass: "test-secret", state: {}, workbook }),
      });
      expect(response.status).toBe(202);
      await waitFor(async () => {
        const job = await (await fetch(`${url}/gateway/v1/runtime/bootstrap`, { headers: auth })).json();
        return job.status === "finished";
      });
      const job = await (await fetch(`${url}/gateway/v1/runtime/bootstrap`, { headers: auth })).json();
      expect(job.httpStatus).toBe(200);
      const data = job.result;
      expect(data.upstream).toBe(`http://127.0.0.1:${MOCK_PORT}`);
      expect(data.workerHealthy).toBe(true);
      expect(data.state["tailscaled.state"]).toBe("c2VjcmV0");
      expect(JSON.stringify(data)).not.toContain("mock-proxy-token-SECRET");
      expect((await fetch(`${url}/gateway/v1/runtime/bootstrap`, { method: "DELETE", headers: auth })).status).toBe(200);
    } finally {
      await fetch(`${url}/gateway/v1/runtime`, { method: "DELETE", headers: auth }).catch(() => {});
      gateway.kill("SIGKILL");
    }
  });

  test("a second gateway reconciles before start instead of allocating again", async () => {
    await ensureCreds(base());
    const first = await (await fetch(`${base()}/gateway/v1/runtime`, { method: "POST", headers: auth })).json();
    const secondPort = PORT_BASE + 8;
    const second = spawnGateway(secondPort, COLAB_PORT, `http://127.0.0.1:${MOCK_PORT}`);
    const secondBase = `http://127.0.0.1:${secondPort}`;
    try {
      await waitFor(async () => (await fetch(`${secondBase}/system_stats`)).ok);
      await ensureCreds(secondBase);
      const response = await fetch(`${secondBase}/gateway/v1/runtime`, { method: "POST", headers: auth });
      const adopted = await response.json();
      expect(response.status).toBe(200);
      expect(adopted.reused).toBe(true);
      expect(adopted.runtime.name).toBe(first.runtime.name);
      const state = await (await fetch(`${colabBase()}/__log`)).json();
      expect(state.runtimes.filter((id: string) => id.startsWith("rgm-gw-"))).toHaveLength(1);
    } finally {
      second.kill("SIGKILL");
      await fetch(`${base()}/gateway/v1/runtime`, { method: "DELETE", headers: auth });
    }
  });

  test("status refreshes the proxy token and reports the idle countdown", async () => {
    await ensureCreds(base());
    await fetch(`${base()}/gateway/v1/runtime`, { method: "POST", headers: auth }); // create (idempotent if reused)
    const res = await fetch(`${base()}/gateway/v1/runtime`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.state).toBe("ready");
    expect(body.runtime.name).toMatch(/^runtimes\/rgm-gw-/);
    expect(body.idle.minutes).toBe(10); // PRD R-06 default
    expect(body.idle.remainingSeconds).not.toBeNull();
  });

  test("stop confirms deletion, not merely a stop request (R-06)", async () => {
    const del = await fetch(`${base()}/gateway/v1/runtime`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);
    const body = (await del.json()) as any;
    expect(body.deleted).toBe(true);
    expect(body.confirmed).toBe(true);

    const after = await (await fetch(`${base()}/gateway/v1/runtime`, { headers: auth })).json();
    expect(after.state).toBe("offline");
    expect(after.runtime).toBeNull();
  });

  test("stop with no owned runtime is a typed 404", async () => {
    const res = await fetch(`${base()}/gateway/v1/runtime`, { method: "DELETE", headers: auth });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("no_owned_runtime");
  });

  test("foreign runtimes are listed but never deleted", async () => {
    // MOCK_FOREIGN=1 puts runtimes/someone-else in the list; reconcile must not
    // adopt it, and no DELETE may ever target it.
    await ensureCreds(base());
    await fetch(`${base()}/gateway/v1/runtime`, { method: "POST", headers: auth }); // own a runtime again
    const list = await (await fetch(`${colabBase()}/v1beta/runtimes`)).json();
    expect(list.runtimes.some((r: any) => r.name === "runtimes/someone-else")).toBe(true);

    await fetch(`${base()}/gateway/v1/runtime`, { method: "DELETE", headers: auth });
    const log = await (await fetch(`${colabBase()}/__log`)).json();
    const deletes = log.calls.filter((c: any) => c.method === "DELETE");
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) expect(d.path).toContain("rgm-gw-");
    const after = await (await fetch(`${colabBase()}/v1beta/runtimes`)).json();
    expect(after.runtimes.some((r: any) => r.name === "runtimes/someone-else")).toBe(true);
  });
});

describe("idle shutdown (PRD R-05 / R-06)", () => {
  test("runtime is deleted after configurable inactivity", async () => {
    await ensureCreds(base());
    await fetch(`${base()}/gateway/v1/runtime`, { method: "POST", headers: auth });
    const put = await fetch(`${base()}/gateway/v1/runtime/idle`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: 0.05 }), // 3 s — operator floor is 5 in the dashboard
    });
    expect(put.status).toBe(200);

    await waitFor(async () => {
      const st = await (await fetch(`${base()}/gateway/v1/runtime`, { headers: auth })).json();
      return st.state === "offline";
    }, 20_000);

    const log = await (await fetch(`${colabBase()}/__log`)).json();
    expect(log.calls.some((c: any) => c.method === "DELETE" && c.path.includes("rgm-gw-"))).toBe(true);
  }, 30_000);

  test("queued jobs hold the runtime; disabling re-enables deletion", async () => {
    // gwBusy fronts a worker whose /queue reports 2 running jobs.
    await ensureCreds(baseBusy());
    await fetch(`${baseBusy()}/gateway/v1/runtime`, { method: "POST", headers: auth });
    await fetch(`${baseBusy()}/gateway/v1/runtime/idle`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: 0.05 }),
    });

    await sleep(4_000); // long enough to fire the timer at least 8 times
    const st = await (await fetch(`${baseBusy()}/gateway/v1/runtime`, { headers: auth })).json();
    expect(st.state).toBe("ready"); // held by real queue activity

    // Disabled timer must never delete; normal stop must not interrupt work.
    await fetch(`${baseBusy()}/gateway/v1/runtime/idle`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: 0 }),
    });
    await sleep(1_500);
    const still = await (await fetch(`${baseBusy()}/gateway/v1/runtime`, { headers: auth })).json();
    expect(still.state).toBe("ready");

    const del = await fetch(`${baseBusy()}/gateway/v1/runtime`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(409);
    expect((await del.json()).error).toBe("runtime_busy");
    const forced = await fetch(`${baseBusy()}/gateway/v1/runtime?force=1`, { method: "DELETE", headers: auth });
    expect((await forced.json()).confirmed).toBe(true);
  }, 30_000);

  test("idle minutes are validated (R-06 set, or sub-minute for tests)", async () => {
    const bad = await fetch(`${base()}/gateway/v1/runtime/idle`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: 7 }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("idle_minutes_invalid");

    for (const ok of [5, 15, 30]) {
      const res = await fetch(`${base()}/gateway/v1/runtime/idle`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ minutes: ok }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).idleMinutes).toBe(ok);
    }

    const fine = await fetch(`${base()}/gateway/v1/runtime/idle`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: 0.05 }),
    });
    expect(fine.status).toBe(200);

    const off = await fetch(`${base()}/gateway/v1/runtime/idle`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: 0 }),
    });
    expect((await off.json()).idle).toBe("disabled");

    // Leave the shared gateway at the PRD default for the tests that follow.
    const reset = await fetch(`${base()}/gateway/v1/runtime/idle`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: 10 }),
    });
    expect((await reset.json()).idleMinutes).toBe(10);
  });
});

describe("provider refusals are typed (PRD §5)", () => {
  test("FAILED_PRECONDITION from CreateRuntime maps to policy_restricted", async () => {
    await fetch(`${baseFail()}/gateway/v1/runtime/credentials`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "cid", client_secret: "sec", refresh_token: REFRESH }),
    });
    const res = await fetch(`${baseFail()}/gateway/v1/runtime`, { method: "POST", headers: auth });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("policy_restricted");
    expect(body.detail).toContain("Free tier");
  });

  test("a second start while provisioning is single-flight refused", async () => {
    // MOCK_CREATE_DELAY_MS holds the mock's create response, so the gateway is
    // still polling when the second request arrives and must get 409, not a
    // second allocation.
    await ensureCreds(base());
    const first = fetch(`${base()}/gateway/v1/runtime`, { method: "POST", headers: auth });
    await sleep(200); // inside the 800 ms create window
    const second = await fetch(`${base()}/gateway/v1/runtime`, { method: "POST", headers: auth });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("provisioning_in_progress");
    const body = (await (await first).json()) as any;
    expect(body.state).toBe("ready");
    expect(body.runtime.name).toMatch(/^runtimes\/rgm-gw-/);
  });
});
