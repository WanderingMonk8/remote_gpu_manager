/**
 * Upstream adoption tests: the gateway can be repointed at a running worker
 * (ADR-006), inside a strict allowlist.
 *
 * Two mocks with different versions let the test prove the proxy really switched,
 * not merely that the string was stored.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";

const PORT_BASE = 20100 + (process.pid % 200);
const MOCK_A = PORT_BASE;
const MOCK_B = PORT_BASE + 1;
const GW = PORT_BASE + 2;
const GW_STRICT = PORT_BASE + 3;
const TOKEN = "upstream-test-token-0123456789";
const USER = "lumiverse";
const PASS = "test-secret";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn().catch(() => false)) return;
    await sleep(75);
  }
  throw new Error("Timed out waiting for condition");
}

let mockA: Subprocess | null = null;
let mockB: Subprocess | null = null;
let gw: Subprocess | null = null;
let gwStrict: Subprocess | null = null;

const base = () => `http://127.0.0.1:${GW}`;
const strict = () => `http://127.0.0.1:${GW_STRICT}`;
const auth = { Authorization: `Bearer ${TOKEN}` };

async function adopt(url: string, basic?: string, at = base()) {
  const body: Record<string, string> = { url };
  if (basic !== undefined) body.basic_auth = basic;
  const res = await fetch(`${at}/gateway/v1/upstream`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  mockA = Bun.spawn(["bun", "tests/mock-comfyui/server.ts"], {
    env: { ...process.env, MOCK_PORT: String(MOCK_A), MOCK_USER: USER, MOCK_PASS: PASS, MOCK_VERSION: "mock-a" },
    stdout: "ignore",
    stderr: "ignore",
  });
  mockB = Bun.spawn(["bun", "tests/mock-comfyui/server.ts"], {
    env: { ...process.env, MOCK_PORT: String(MOCK_B), MOCK_USER: USER, MOCK_PASS: PASS, MOCK_VERSION: "mock-b" },
    stdout: "ignore",
    stderr: "ignore",
  });
  gw = Bun.spawn(["bun", "host-gateway/gateway.ts"], {
    env: {
      ...process.env,
      GATEWAY_PORT: String(GW),
      GATEWAY_UPSTREAM: `http://127.0.0.1:${MOCK_A}`,
      GATEWAY_BASIC_AUTH: `${USER}:${PASS}`,
      GATEWAY_CONTROL_TOKEN: TOKEN,
      GATEWAY_UPSTREAM_ALLOW: "127.0.0.1",
      GATEWAY_UPSTREAM_ALLOW_HTTP: "1",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  gwStrict = Bun.spawn(["bun", "host-gateway/gateway.ts"], {
    env: {
      ...process.env,
      GATEWAY_PORT: String(GW_STRICT),
      GATEWAY_UPSTREAM: `http://127.0.0.1:${MOCK_A}`,
      GATEWAY_BASIC_AUTH: `${USER}:${PASS}`,
      GATEWAY_CONTROL_TOKEN: TOKEN,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitFor(async () => (await fetch(`${base()}/system_stats`)).ok);
  await waitFor(async () => (await fetch(`${strict()}/system_stats`)).ok);
}, 30_000);

afterAll(() => {
  mockA?.kill("SIGKILL");
  mockB?.kill("SIGKILL");
  gw?.kill("SIGKILL");
  gwStrict?.kill("SIGKILL");
});

describe("authorization", () => {
  test("requires the control token", async () => {
    const res = await fetch(`${base()}/gateway/v1/upstream`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://moss-comfy.tailf0a296.ts.net" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("control_auth_required");
  });
});

describe("allowlist and scheme (strict gateway)", () => {
  test("rejects plain http", async () => {
    const r = await adopt(`http://127.0.0.1:${MOCK_A}`, undefined, strict());
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("https_required");
  });

  test("rejects a host outside the allowlist", async () => {
    const r = await adopt("https://evil.example.com", undefined, strict());
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("host_not_allowed");
  });

  test("rejects a malformed url", async () => {
    const r = await adopt("not a url", undefined, strict());
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("url_invalid");
  });
});

describe("adoption actually repoints the proxy", () => {
  test("before adoption it serves mock-a", async () => {
    const body = (await (await fetch(`${base()}/system_stats`)).json()) as any;
    expect(body.system.comfyui_version).toBe("mock-a");
  });

  test("adopts mock-b with the right Basic Auth and serves it", async () => {
    const put = await adopt(`http://127.0.0.1:${MOCK_B}`, `${USER}:${PASS}`);
    expect(put.status).toBe(200);
    expect(put.body.upstream).toBe(`http://127.0.0.1:${MOCK_B}`);
    expect(put.body.auth).toBe(true);

    const got = (await (await fetch(`${base()}/gateway/v1/upstream`, { headers: auth })).json()) as any;
    expect(got.upstream).toBe(`http://127.0.0.1:${MOCK_B}`);

    const body = (await (await fetch(`${base()}/system_stats`)).json()) as any;
    expect(body.system.comfyui_version).toBe("mock-b");
  });

  test("a wrong password surfaces 401 from the new worker", async () => {
    const put = await adopt(`http://127.0.0.1:${MOCK_B}`, `${USER}:wrong-password`);
    expect(put.status).toBe(200);
    const res = await fetch(`${base()}/system_stats`);
    expect(res.status).toBe(401);
  });

  test("a malformed basic_auth is refused and does not change anything", async () => {
    const put = await adopt(`http://127.0.0.1:${MOCK_B}`, "no-colon-here");
    expect(put.status).toBe(400);
    expect(put.body.error).toBe("basic_auth_invalid");
  });

  test("restores a working password", async () => {
    const put = await adopt(`http://127.0.0.1:${MOCK_B}`, `${USER}:${PASS}`);
    expect(put.status).toBe(200);
    const res = await fetch(`${base()}/system_stats`);
    expect(res.status).toBe(200);
  });
});
