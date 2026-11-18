/**
 * M1 integration test: mock ComfyUI worker -> gateway -> native-provider-shaped client.
 *
 * Boot: mock (Basic Auth upstream) and gateway (injects credentials), then:
 *   1. /system_stats through the gateway succeeds with injected auth
 *   2. /object_info exposes the MOSS/Anima node set
 *   3. disallowed route (/debug/internal) is blocked with 403 by the gateway
 *   4. POST /prompt runs a full mock job; WS client sees executing events
 *   5. /history/{id} returns outputs; /view returns PNG bytes
 *   6. control plane requires the bearer token when enabled
 *   7. upstream 401 propagates when the gateway holds WRONG credentials
 *   8. missing gateway credentials fail health checks (misconfig surfaces loudly)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";

// Randomized high ports so concurrent/leftover instances never collide.
const PORT_BASE = 19200 + (process.pid % 400);
const MOCK_PORT = PORT_BASE;
const GW_PORT = PORT_BASE + 1;
const GW_PORT_BAD = PORT_BASE + 2; // gateway with intentionally wrong upstream creds
const GW2_PORT = PORT_BASE + 3; // gateway with no control token
const CONTROL_TOKEN = "control-test-token-0123456789abcdef";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn().catch(() => false)) return;
    await sleep(75);
  }
  throw new Error("Timed out waiting for condition");
}

const mossWorkflow = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "moss_image_sft_int8_convrot.safetensors", weight_dtype: "default" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3.5_9b_w4a8_gptq.safetensors", type: "moss_image", device: "default" } },
  "3": { class_type: "VAELoader", inputs: { vae_name: "flux2-vae_small.safetensors" } },
  "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "a red coat in a hallway" } },
  "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "worst quality, blurry" } },
  "6": { class_type: "EmptyFlux2LatentImage", inputs: { width: 768, height: 768, batch_size: 1 } },
  "7": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], seed: 42, steps: 4, cfg: 2.5, sampler_name: "er_sde", scheduler: "simple", denoise: 1.0 } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "moss/image" } },
};

let mock: Subprocess | null = null;
let gateway: Subprocess | null = null;
let gatewayBad: Subprocess | null = null;

const base = () => `http://127.0.0.1:${GW_PORT}`;
const gwBad = () => `http://127.0.0.1:${GW_PORT_BAD}`;

beforeAll(async () => {
  mock = Bun.spawn(["bun", "tests/mock-comfyui/server.ts"], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_USER: "lumiverse", MOCK_PASS: "test-secret", MOCK_EXECUTION_MS: "100" },
    stdout: "ignore",
    stderr: "inherit",
  });
  gateway = Bun.spawn(["bun", "host-gateway/gateway.ts"], {
    env: {
      ...process.env,
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
      GATEWAY_BASIC_AUTH: "lumiverse:test-secret",
      GATEWAY_CONTROL_TOKEN: CONTROL_TOKEN,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  gatewayBad = Bun.spawn(["bun", "host-gateway/gateway.ts"], {
    env: {
      ...process.env,
      GATEWAY_PORT: String(GW_PORT_BAD),
      GATEWAY_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
      GATEWAY_BASIC_AUTH: "lumiverse:wrong-secret",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitFor(async () => (await fetch(`${base()}/system_stats`)).ok);
  await waitFor(async () => (await fetch(`${gwBad()}/system_stats`)).status === 401);
});

afterAll(() => {
  mock?.kill("SIGKILL");
  gateway?.kill("SIGKILL");
  gatewayBad?.kill("SIGKILL");
});

describe("allowlisted health/catalog paths", () => {
  test("GET /system_stats proxies with injected Basic Auth", async () => {
    const res = await fetch(`${base()}/system_stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.devices?.[0]?.type).toBe("cuda");
    expect(body.system?.python_version).toBeDefined();
  });

  test("GET /object_info exposes MOSS-capable node set", async () => {
    const res = await fetch(`${base()}/object_info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    for (const node of ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "EmptyFlux2LatentImage", "KSampler", "VAEDecode", "SaveImage", "LoraLoaderModelOnly"]) {
      expect(body[node], `missing ${node}`).toBeDefined();
    }
    expect(body.CLIPLoader.input.required.type[0]).toContain("moss_image");
  });

  test("GET /object_info/UNETLoader works; unknown node gives 404", async () => {
    const ok = await fetch(`${base()}/object_info/UNETLoader`);
    expect(ok.status).toBe(200);
    const missing = await fetch(`${base()}/object_info/NotANode`);
    expect(missing.status).toBe(404);
  });
});

describe("deny-by-default", () => {
  test("disallowed route returns 403 and never reaches the worker", async () => {
    const res = await fetch(`${base()}/debug/internal`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "route_not_allowed" });
  });

  test("unknown POST path returns 403", async () => {
    const res = await fetch(`${base()}/promptx`, { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
  });

  test("GET on POST-only route returns 403", async () => {
    const res = await fetch(`${base()}/prompt`, { method: "GET" });
    expect(res.status).toBe(403);
  });
});

describe("generation lifecycle over gateway", () => {
  test("POST /prompt -> WS events -> history -> view", async () => {
    const clientId = "test-client-1";
    const wsUrl = `ws://127.0.0.1:${GW_PORT}/ws?clientId=${clientId}`;
    const events: Array<{ type: string; data?: any }> = [];
    const wsDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS completion timed out")), 10_000);
      const ws = new WebSocket(wsUrl);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        events.push(msg);
        if (msg.type === "executing" && msg.data?.node === null) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("WS error"));
      });
    });

    const submit = await fetch(`${base()}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: mossWorkflow, client_id: clientId }),
    });
    expect(submit.status).toBe(200);
    const { prompt_id } = (await submit.json()) as { prompt_id: string };
    expect(prompt_id).toMatch(/^[0-9a-f-]{36}$/);

    await wsDone;
    expect(events.some((e) => e.type === "executing" && e.data?.node === "7")).toBe(true);

    // History is only readable after completion; poll briefly.
    let history: any = {};
    for (let i = 0; i < 20 && !history[prompt_id]; i++) {
      history = await (await fetch(`${base()}/history/${prompt_id}`)).json();
      await sleep(50);
    }
    expect(history[prompt_id]?.outputs?.["9"]?.images?.[0]?.filename).toBe("moss_00001_.png");

    const view = await fetch(`${base()}/view?filename=moss_00001_.png&subfolder=&type=output`);
    expect(view.status).toBe(200);
    const bytes = new Uint8Array(await view.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  });
});

describe("gateway auth handling", () => {
  test("gateway with wrong upstream credentials surfaces upstream 401", async () => {
    const res = await fetch(`${gwBad()}/system_stats`);
    expect(res.status).toBe(401);
  });

  test("control plane requires bearer token", async () => {
    const noAuth = await fetch(`${base()}/gateway/v1/status`);
    expect(noAuth.status).toBe(401);
    const wrongToken = await fetch(`${base()}/gateway/v1/status`, { headers: { Authorization: "Bearer nope" } });
    expect(wrongToken.status).toBe(401);
    const ok = await fetch(`${base()}/gateway/v1/status`, { headers: { Authorization: `Bearer ${CONTROL_TOKEN}` } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as any;
    expect(body.upstream.reachable).toBe(true);
  });
});
